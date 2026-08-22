import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const SEG_COUNT = 6;
const SKIP_INPUTS = { H3DirectorTailFrame: ["排序依赖"] };

/* ---------------- 图操作工具 ---------------- */

function findSegments() {
  const segs = {};
  for (const n of app.graph._nodes) {
    const t = n.title || "";
    let m = t.match(/^段([1-6])\s*提示词/);
    if (m && n.type === "PrimitiveStringMultiline") (segs[m[1]] ||= {}).prompt = n;
    m = t.match(/^段([1-6])$/);
    if (m && n.type === "MiniMaxH3ReferenceToVideo") (segs[m[1]] ||= {}).h3 = n;
    m = t.match(/^段([1-6])\s*成片/);
    if (m && n.type === "SaveVideo") (segs[m[1]] ||= {}).savev = n;
  }
  for (const i of Object.keys(segs)) {
    const s = segs[i];
    if (!s.h3) continue;
    for (const n of app.graph._nodes) {
      if (n.type !== "SamplerCustomAdvanced") continue;
      const li = n.inputs.find((x) => x.name === "latent_image");
      if (li && li.link && app.graph.links[li.link] && app.graph.links[li.link].origin_id === s.h3.id) {
        s.sampler = n;
        const ni = n.inputs.find((x) => x.name === "noise");
        if (ni && ni.link) s.noise = app.graph.getNodeById(app.graph.links[ni.link].origin_id);
      }
    }
  }
  return segs;
}

async function queueSubgraph(rootNodeIds) {
  const { output } = await app.graphToPrompt();
  const keep = new Set();
  const stack = rootNodeIds.map(String);
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id) || !output[id]) continue;
    keep.add(id);
    const node = output[id];
    for (const key of Object.keys(node.inputs)) {
      const skip = SKIP_INPUTS[node.class_type];
      if (skip && skip.includes(key)) {
        delete node.inputs[key];
        continue;
      }
      const v = node.inputs[key];
      if (Array.isArray(v)) stack.push(String(v[0]));
    }
  }
  const sub = {};
  for (const id of keep) sub[id] = output[id];
  await api.queuePrompt(0, { output: sub });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForIdle() {
  await sleep(500);
  for (;;) {
    const q = await api.getQueue();
    const running = (q.queue_running || q.Running || []).length;
    const pending = (q.queue_pending || q.Pending || []).length;
    if (running + pending === 0) return;
    await sleep(1500);
  }
}

async function fetchStatus() {
  try {
    return await (await fetch("/h3director/status")).json();
  } catch (e) {
    return null;
  }
}

/* ---------------- 面板样式 ---------------- */

const CSS = `
.h3d-root { display:flex; flex-direction:column; gap:10px; padding:10px; height:100%; overflow-y:auto;
  font-size:13px; color:var(--fg-color, #ddd); box-sizing:border-box; }
.h3d-card { border:1px solid var(--border-color, #444); border-radius:10px; padding:10px; display:flex;
  flex-direction:column; gap:8px; background:var(--comfy-input-bg, rgba(128,128,128,0.06)); }
.h3d-head { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.h3d-title { font-weight:600; font-size:14px; }
.h3d-badge { font-size:11px; padding:1px 8px; border-radius:8px; background:#555; color:#eee; white-space:nowrap; }
.h3d-badge.ok { background:#0F6E56; }
.h3d-badge.no { background:#6e3a0f; }
.h3d-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.h3d-btn { cursor:pointer; border:1px solid var(--border-color,#555); border-radius:8px; padding:5px 10px;
  background:var(--comfy-input-bg, rgba(128,128,128,0.12)); color:inherit; font-size:12px; }
.h3d-btn:hover { filter:brightness(1.25); }
.h3d-btn.primary { background:#185FA5; border-color:#185FA5; color:#fff; }
.h3d-btn.danger { background:#712B13; border-color:#712B13; color:#fff; }
.h3d-btn:disabled { opacity:0.5; cursor:not-allowed; }
.h3d-ta { width:100%; min-height:110px; resize:vertical; border-radius:8px; border:1px solid var(--border-color,#555);
  background:var(--comfy-input-bg, rgba(0,0,0,0.2)); color:inherit; font-size:12px; padding:6px; box-sizing:border-box; }
.h3d-seed { width:150px; border-radius:8px; border:1px solid var(--border-color,#555);
  background:var(--comfy-input-bg, rgba(0,0,0,0.2)); color:inherit; font-size:12px; padding:4px 6px; }
.h3d-ref { display:flex; gap:4px; flex-wrap:wrap; }
.h3d-refimg { position:relative; width:56px; height:56px; border-radius:6px; overflow:hidden; border:1px solid #666; }
.h3d-refimg img { width:100%; height:100%; object-fit:cover; }
.h3d-refimg .x { position:absolute; top:0; right:0; background:rgba(0,0,0,0.65); color:#fff; border:none;
  cursor:pointer; font-size:11px; line-height:1; padding:2px 4px; }
.h3d-hint { font-size:11px; opacity:0.7; line-height:1.5; }
.h3d-global { position:sticky; bottom:0; background:var(--bg-color,#222); border-top:1px solid var(--border-color,#444);
  padding:10px 0 4px; display:flex; flex-direction:column; gap:8px; }
.h3d-status { font-size:12px; opacity:0.85; min-height:16px; }
.h3d-video { width:100%; border-radius:8px; background:#000; }
`;

/* ---------------- 面板构建 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function buildPanel(root) {
  const styleEl = document.createElement("style");
  styleEl.textContent = CSS;
  root.appendChild(styleEl);
  const wrap = el("div", "h3d-root");
  root.appendChild(wrap);

  let busy = false;
  const statusLine = el("div", "h3d-status", "就绪");
  const setStatus = (t) => (statusLine.textContent = t);

  const segs = findSegments();
  const found = Object.keys(segs).length;

  const head = el("div", "h3d-head");
  head.appendChild(el("div", "h3d-title", "H3 长序列分镜融合台"));
  const btnRefresh = el("button", "h3d-btn", "刷新/重载面板");
  head.appendChild(btnRefresh);
  wrap.appendChild(head);

  if (found < SEG_COUNT) {
    wrap.appendChild(el("div", "h3d-hint",
      `只识别到 ${found}/${SEG_COUNT} 个分段。请先打开配套工作流「漫剧_导演台.json」。识别依据：节点标题「段N / 段N 提示词 / 段N 成片」。`));
  }

  const cards = {};

  for (let i = 1; i <= SEG_COUNT; i++) {
    const s = segs[i] || {};
    const card = el("div", "h3d-card");

    // 标题行
    const h = el("div", "h3d-head");
    h.appendChild(el("div", "h3d-title", `段 ${i}`));
    const badges = el("div", "h3d-row");
    const bTail = el("span", "h3d-badge no", "尾帧✗");
    const bVid = el("span", "h3d-badge no", "成片✗");
    badges.appendChild(bTail);
    badges.appendChild(bVid);
    h.appendChild(badges);
    card.appendChild(h);

    // 提示词
    const ta = el("textarea", "h3d-ta");
    if (s.prompt) {
      const w = s.prompt.widgets.find((x) => x.name === "value");
      ta.value = w ? w.value : "";
      ta.addEventListener("change", () => { if (w) { w.value = ta.value; } });
    } else {
      ta.placeholder = "未找到该段提示词节点";
      ta.disabled = true;
    }
    card.appendChild(ta);

    // 种子 + 参考图
    const row2 = el("div", "h3d-row");
    row2.appendChild(el("span", null, "种子"));
    const seed = el("input", "h3d-seed");
    seed.type = "number";
    if (s.noise) {
      const w = s.noise.widgets.find((x) => x.name === "noise_seed");
      seed.value = w ? w.value : 0;
      seed.addEventListener("change", () => { if (w) w.value = Number(seed.value); });
    } else seed.disabled = true;
    row2.appendChild(seed);
    card.appendChild(row2);

    // 参考图区
    const refBox = el("div", "h3d-ref");
    card.appendChild(el("div", "h3d-hint", "额外参考图（接入该段空闲 ref_image 槽，提示词里按顺序叫 <Picture 5>、<Picture 6>…）"));
    card.appendChild(refBox);

    const refreshRefs = () => {
      refBox.innerHTML = "";
      if (!s.h3) return;
      for (const n of app.graph._nodes.slice()) {
        if (n.type !== "LoadImage" || !(n.title || "").startsWith(`段${i} 参考图`)) continue;
        const w = n.widgets.find((x) => x.name === "image");
        const box = el("div", "h3d-refimg");
        const img = document.createElement("img");
        img.src = "/view?filename=" + encodeURIComponent(w ? w.value : "") + "&type=input";
        const del = el("button", "x", "✕");
        del.addEventListener("click", () => { app.graph.remove(n); app.graph.setDirtyCanvas(true, true); refreshRefs(); });
        box.appendChild(img);
        box.appendChild(del);
        refBox.appendChild(box);
      }
    };
    refreshRefs();

    // 按钮行
    const row3 = el("div", "h3d-row");
    const btnAddRef = el("button", "h3d-btn", "+ 参考图");
    btnAddRef.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.addEventListener("change", async () => {
        if (!inp.files[0] || !s.h3) return;
        const fd = new FormData();
        fd.append("image", inp.files[0], inp.files[0].name);
        fd.append("overwrite", "true");
        const r = await (await fetch("/upload/image", { method: "POST", body: fd })).json();
        const imgName = (r.subfolder ? r.subfolder + "/" : "") + r.name;
        const slot = s.h3.inputs.find((x) => x.name.startsWith("ref_images.ref_image_") && !x.link);
        if (!slot) { alert("该段参考图槽已满"); return; }
        const node = LiteGraph.createNode("LoadImage");
        node.title = `段${i} 参考图`;
        node.pos = [s.h3.pos[0] - 340, s.h3.pos[1] + 120];
        app.graph.add(node);
        const w = node.widgets.find((x) => x.name === "image");
        if (w) { w.value = imgName; if (w.callback) w.callback(w.value); }
        node.connect(0, s.h3, s.h3.inputs.indexOf(slot));
        app.graph.setDirtyCanvas(true, true);
        refreshRefs();
      });
      inp.click();
    });
    row3.appendChild(btnAddRef);

    const btnRun = el("button", "h3d-btn primary", "▶ 运行此段");
    btnRun.addEventListener("click", async () => {
      if (busy || !s.savev) return;
      busy = true; setStatus(`段${i} 已提交，生成中…`);
      try {
        await queueSubgraph([s.savev.id]);
        await waitForIdle();
        setStatus(`段${i} 完成`);
      } catch (e) { setStatus(`段${i} 出错: ${e.message}`); }
      busy = false; refreshStatus();
    });
    row3.appendChild(btnRun);

    const btnPrev = el("button", "h3d-btn", "预览");
    btnPrev.addEventListener("click", () => {
      const old = card.querySelector("video");
      if (old) { old.remove(); return; }
      const st = cards[i].status;
      if (!st || !st.video) { setStatus(`段${i} 还没有成片`); return; }
      const v = document.createElement("video");
      v.className = "h3d-video";
      v.controls = true;
      v.src = "/view?filename=" + encodeURIComponent(st.video) + "&t=" + Date.now();
      card.appendChild(v);
      v.play();
    });
    row3.appendChild(btnPrev);

    if (i >= 2) {
      const btnCont = el("button", "h3d-btn", "从视频续接");
      btnCont.title = "上传任意 mp4，抽最后一帧作为本段的起点（<Picture 4>）";
      btnCont.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/mp4,video/*";
        inp.addEventListener("change", async () => {
          if (!inp.files[0]) return;
          setStatus(`正在为段${i} 提取续接尾帧…`);
          const fd = new FormData();
          fd.append("target_seg", String(i));
          fd.append("video", inp.files[0], inp.files[0].name);
          const r = await (await fetch("/h3director/extract_tail", { method: "POST", body: fd })).json();
          setStatus(r.ok ? `段${i} 续接帧已就绪` : `失败: ${r.error}`);
          refreshStatus();
        });
        inp.click();
      });
      row3.appendChild(btnCont);
    }

    card.appendChild(row3);
    cards[i] = { card, bTail, bVid, status: null };
    wrap.appendChild(card);
  }

  // 底部全局操作
  const foot = el("div", "h3d-global");
  const grow = el("div", "h3d-row");
  const btnAll = el("button", "h3d-btn primary", "▶▶ 全部运行（段1→6 顺序生成）");
  btnAll.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    for (let i = 1; i <= SEG_COUNT; i++) {
      const s = findSegments()[i];
      if (!s || !s.savev) { setStatus(`段${i} 节点缺失，中止`); busy = false; return; }
      setStatus(`全部运行：段${i}/${SEG_COUNT} 生成中…`);
      try {
        await queueSubgraph([s.savev.id]);
        await waitForIdle();
      } catch (e) { setStatus(`段${i} 出错: ${e.message}`); busy = false; return; }
      refreshStatus();
    }
    setStatus("全部完成，可点击「合并成片」");
    busy = false;
  });
  grow.appendChild(btnAll);

  const btnMerge = el("button", "h3d-btn primary", "合并成片");
  btnMerge.addEventListener("click", async () => {
    if (busy) return;
    busy = true; setStatus("合并中…");
    try {
      await api.queuePrompt(0, { output: {
        "900": { class_type: "H3DirectorMerge", inputs: { "段数": SEG_COUNT, "输出文件名": "漫剧_60s_合并" } }
      }});
      await waitForIdle();
      setStatus("合并完成 → output/video/漫剧_60s_合并.mp4");
    } catch (e) { setStatus(`合并出错: ${e.message}`); }
    busy = false; refreshStatus();
  });
  grow.appendChild(btnMerge);

  const btnPlayMerged = el("button", "h3d-btn", "预览成片");
  btnPlayMerged.addEventListener("click", async () => {
    const st = await fetchStatus();
    if (!st || !st.merged) { setStatus("还没有合并成片"); return; }
    const old = wrap.querySelector(".h3d-merged-video");
    if (old) { old.remove(); return; }
    const v = document.createElement("video");
    v.className = "h3d-video h3d-merged-video";
    v.controls = true;
    v.src = "/view?filename=" + encodeURIComponent(st.merged) + "&t=" + Date.now();
    foot.appendChild(v);
    v.play();
  });
  grow.appendChild(btnPlayMerged);
  foot.appendChild(grow);
  foot.appendChild(statusLine);
  foot.appendChild(el("div", "h3d-hint",
    "提示：请用本面板的按钮运行（单段运行靠文件接力，互不牵连）；不要直接点 ComfyUI 的 Queue 全图运行。"));
  wrap.appendChild(foot);

  async function refreshStatus() {
    const st = await fetchStatus();
    if (!st) return;
    for (let i = 1; i <= SEG_COUNT; i++) {
      const c = cards[i];
      c.status = st.segments[String(i)];
      const set = (b, ok, tOk, tNo) => {
        b.textContent = ok ? tOk : tNo;
        b.className = "h3d-badge " + (ok ? "ok" : "no");
      };
      set(c.bTail, c.status.tail, "尾帧✓", "尾帧✗");
      set(c.bVid, !!c.status.video, "成片✓", "成片✗");
    }
  }
  btnRefresh.addEventListener("click", () => { wrap.innerHTML = ""; buildPanel(root); });
  refreshStatus();
}

/* ---------------- 注册扩展 ---------------- */

app.registerExtension({
  name: "H3ContextDirector.Panel",
  async setup() {
    app.extensionManager.registerSidebarTab({
      id: "h3Director",
      icon: "pi pi-video",
      title: "导演台",
      tooltip: "H3 长序列分镜融合台",
      type: "custom",
      render: (el) => buildPanel(el),
    });
  },
});
