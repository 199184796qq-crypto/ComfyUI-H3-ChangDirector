import { app } from "/scripts/app.js";


const SECRET_WIDGETS = new Set(["access_key_id", "access_key_secret"]);


function findTextInput(widget) {
    for (const candidate of [widget?.inputEl, widget?.input_el, widget?.element]) {
        if (!candidate) {
            continue;
        }
        if (candidate.matches?.("input, textarea")) {
            return candidate;
        }
        const input = candidate.querySelector?.("input, textarea");
        if (input) {
            return input;
        }
    }
    return null;
}


function maskSecretWidget(node, widgetName, attempt = 0) {
    const widget = node.widgets?.find((item) => item.name === widgetName);
    if (!widget) {
        return;
    }

    // Current frontends use this option.  Keeping it on the widget also
    // handles redraws where ComfyUI recreates the DOM input element.
    widget.options = { ...widget.options, password: true };
    const input = findTextInput(widget);
    if (!input) {
        if (attempt < 30) {
            setTimeout(() => maskSecretWidget(node, widgetName, attempt + 1), 50);
        }
        return;
    }

    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.dataset.aliyunOssMasked = "true";
    // Chromium's password input shows bullets; this fallback covers custom
    // text widgets which retain type=text after a frontend redraw.
    input.style.webkitTextSecurity = "disc";
}


function installCanvasMask(node) {
    if (node.__aliyunOssCanvasMaskInstalled) {
        return;
    }
    node.__aliyunOssCanvasMaskInstalled = true;
    const previousDrawForeground = node.onDrawForeground;
    node.onDrawForeground = function (ctx, ...args) {
        previousDrawForeground?.call(this, ctx, ...args);
        const widgets = this.widgets ?? [];
        for (let index = 0; index < widgets.length; index += 1) {
            const widget = widgets[index];
            if (!SECRET_WIDGETS.has(widget?.name)) {
                continue;
            }
            const y = Number(widget.y);
            if (!Number.isFinite(y)) {
                continue;
            }
            const nextY = Number(widgets[index + 1]?.y);
            const height = Number.isFinite(nextY) && nextY > y
                ? Math.max(20, nextY - y - 2)
                : Math.max(20, globalThis.LiteGraph?.NODE_WIDGET_HEIGHT ?? 24);
            const x = 10;
            const width = Math.max(40, this.size[0] - x * 2);
            const radius = Math.min(10, height / 2);
            const label = String(widget.label ?? widget.name);
            const rawValue = String(widget.value ?? "");
            const maskedValue = rawValue ? "*".repeat(Math.min(24, rawValue.length)) : "";

            // This ComfyUI build draws STRING widgets on canvas, so changing
            // an HTML input's type is not enough.  Paint the entire widget
            // after ComfyUI's normal draw, while leaving widget.value intact.
            ctx.save();
            ctx.fillStyle = "#222";
            ctx.strokeStyle = "#666";
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (typeof ctx.roundRect === "function") {
                ctx.roundRect(x, y + 1, width, height - 2, radius);
            } else {
                ctx.rect(x, y + 1, width, height - 2);
            }
            ctx.fill();
            ctx.stroke();
            ctx.font = "13px Arial";
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#aaa";
            ctx.fillText(label, x + 12, y + height / 2);
            ctx.fillStyle = "#ddd";
            ctx.fillText(maskedValue, Math.max(x + 130, width * 0.48), y + height / 2);
            ctx.restore();
        }
    };
}


function maskNodeSecrets(node) {
    installCanvasMask(node);
    for (const widgetName of SECRET_WIDGETS) {
        maskSecretWidget(node, widgetName);
    }
    node.setDirtyCanvas?.(true, true);
}


app.registerExtension({
    name: "aliyun_oss.secret_mask",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!String(nodeData?.name ?? "").startsWith("AliyunOSS")) {
            return;
        }

        const previousCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = previousCreated?.apply(this, args);
            setTimeout(() => maskNodeSecrets(this), 0);
            return result;
        };

        const previousConfigured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = previousConfigured?.apply(this, args);
            setTimeout(() => maskNodeSecrets(this), 0);
            return result;
        };
    },
});

