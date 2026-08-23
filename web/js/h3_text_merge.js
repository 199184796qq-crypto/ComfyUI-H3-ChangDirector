import { app } from "../../../scripts/app.js";

const NODE_CLASS = "H3DynamicTextMerge";
const PORT_PREFIX = "text_";
const PREVIEW_PROPERTY = "h3_text_merge_preview";

function isTextPort(input) {
  return input && /^text_\d+$/.test(input.name || "");
}

function nextPortNumber(node) {
  const numbers = (node.inputs || [])
    .filter(isTextPort)
    .map((input) => Number(input.name.slice(PORT_PREFIX.length)))
    .filter(Number.isFinite);
  return Math.max(0, ...numbers) + 1;
}

function addTextPort(node) {
  const number = nextPortNumber(node);
  node.addInput(PORT_PREFIX + number, "STRING", {
    forceInput: true,
    tooltip: "连接文本后自动增加下一条输入；合并顺序从上到下。",
  });
}

function ensureTrailingTextPort(node) {
  const textPorts = (node.inputs || []).filter(isTextPort);
  if (!textPorts.length) {
    addTextPort(node);
    return;
  }
  const last = textPorts[textPorts.length - 1];
  if (last.link != null) addTextPort(node);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
}

function createPreview(node) {
  if (node.__h3TextMergePreview) return node.__h3TextMergePreview;
  if (!node.properties) node.properties = {};

  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;gap:5px;width:100%;height:180px;"
    + "min-height:130px;padding:6px;box-sizing:border-box;background:#17191d;border:1px solid #3c4856;"
    + "border-radius:7px;color:#d9e7f7;";
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;";
  const title = document.createElement("span");
  title.textContent = "合并文本预览（执行后更新）";
  title.style.cssText = "font-size:12px;color:#9fd0ff;";
  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.title = "复制全部合并文本";
  copy.style.cssText = "cursor:pointer;border:1px solid #5a6a7d;border-radius:5px;padding:2px 9px;"
    + "background:#29313b;color:#e7f2ff;font-size:12px;";
  bar.append(title, copy);

  const preview = document.createElement("textarea");
  preview.readOnly = true;
  preview.spellcheck = false;
  preview.placeholder = "运行此节点后，这里显示合并后的完整文本。";
  preview.style.cssText = "display:block;flex:1;min-height:0;width:100%;resize:none;overflow:auto;"
    + "box-sizing:border-box;border:1px solid #424b58;border-radius:5px;background:#0f1115;color:#e7e7e7;"
    + "padding:7px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre-wrap;";
  ["pointerdown", "wheel", "dblclick"].forEach((eventName) => {
    preview.addEventListener(eventName, (event) => event.stopPropagation());
  });
  container.append(bar, preview);

  const domWidget = node.addDOMWidget("合并文本预览", "h3_text_merge_preview", container,
    { serialize: false, hideOnZoom: false });
  const previewState = {
    setText(text) {
      const value = String(text ?? "");
      preview.value = value;
      node.properties[PREVIEW_PROPERTY] = value;
      copy.disabled = !value;
      copy.style.opacity = value ? "1" : "0.55";
    },
    syncSize() {
      // 输入口会随连接增加。预览高度始终吃掉节点框中剩余的空间，最低保留
      // 130px；拖动节点框时 textarea 会同步伸缩。
      const inputHeight = Math.max(1, (node.inputs || []).length) * 24;
      const otherWidgets = (node.widgets || []).filter((widget) => widget !== domWidget).length * 28;
      const height = Math.max(130, Math.floor((node.size?.[1] || 360) - inputHeight - otherWidgets - 72));
      container.style.height = height + "px";
    },
  };
  if (domWidget) {
    domWidget.computedSize = () => [Math.max(320, (node.size?.[0] || 380) - 20), container.clientHeight || 180];
    domWidget.computeLayoutSize = () => ({ minHeight: 130, minWidth: 320, maxHeight: undefined });
  }
  copy.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyText(preview.value);
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    } catch (error) {
      copy.textContent = "复制失败";
      setTimeout(() => { copy.textContent = "复制"; }, 1200);
    }
  });
  node.__h3TextMergePreview = previewState;
  previewState.setText(node.properties[PREVIEW_PROPERTY] || "");
  previewState.syncSize();
  return previewState;
}

function fitNodeToContents(node) {
  const minimum = node.computeSize();
  node.setSize([
    Math.max(380, node.size?.[0] || 0, minimum[0]),
    Math.max(330, node.size?.[1] || 0, minimum[1]),
  ]);
  node.__h3TextMergePreview?.syncSize();
}

function readMergedText(message) {
  // ComfyUI's executed event is normally the ui dictionary itself. Some
  // frontend versions wrap it in `ui` or `output`, so accept all forms.
  const candidates = [
    message?.merged_text,
    message?.ui?.merged_text,
    message?.output?.merged_text,
    message?.output?.ui?.merged_text,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (Array.isArray(candidate)) return candidate[0];
    return candidate;
  }
  return undefined;
}

app.registerExtension({
  name: "H3ContextDirector.DynamicTextMerge",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS) return;

    const originalConnectionChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, index, connected, linkInfo) {
      const result = originalConnectionChange?.apply(this, arguments);
      // type 1 is an input-port change. During graph restore, onConfigure
      // runs once after all links exist, avoiding duplicate blank ports.
      if (type === 1 && connected && linkInfo && !app.configuringGraph && isTextPort(this.inputs?.[index])) {
        ensureTrailingTextPort(this);
        fitNodeToContents(this);
        this.setDirtyCanvas(true, true);
      }
      return result;
    };

    const originalConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = originalConfigure?.apply(this, arguments);
      setTimeout(() => {
        ensureTrailingTextPort(this);
        this.__h3TextMergePreview?.setText(this.properties?.[PREVIEW_PROPERTY] || "");
        fitNodeToContents(this);
        this.setDirtyCanvas(true, true);
      }, 0);
      return result;
    };

    const originalResize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function () {
      const result = originalResize?.apply(this, arguments);
      this.__h3TextMergePreview?.syncSize();
      return result;
    };

    // Install this on the node type, rather than only on the freshly-created
    // instance. ComfyUI may attach its own instance callback while restoring a
    // workflow, which otherwise replaces an instance-only handler.
    const originalExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = originalExecuted?.apply(this, arguments);
      const value = readMergedText(message);
      if (value !== undefined) {
        this.__h3TextMergePreview?.setText(value);
        this.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
      }
      return result;
    };
  },

  nodeCreated(node) {
    if (node.comfyClass !== NODE_CLASS) return;
    ensureTrailingTextPort(node);
    createPreview(node);
    fitNodeToContents(node);
  },
});
