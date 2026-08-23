import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { H3_TEXT_TEMPLATES } from "./h3_templates.js";

/* 前端版本号：与 routes.py 的 BACKEND_VERSION 对应。
   status 接口返回的后端版本若与此不一致（用户改了代码但没重启/没强刷），状态栏红字提示。 */
const H3S_VERSION = "2.25.4";
const activeProjectIds = new Map();

function newProjectId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return "h3_" + globalThis.crypto.randomUUID();
    }
  } catch (e) { /* 使用时间戳回退 */ }
  const rand = Math.random().toString(36).slice(2, 12);
  return "h3_" + Date.now().toString(36) + "_" + rand;
}

/* 画布缩放系数：DOM 拖拽拿到的 clientX/Y 是屏幕像素，节点/面板尺寸是画布坐标，
   两者差 ds.scale 倍（如 59% 缩放时差 1.69 倍）。所有拖拽位移必须除以它，
   否则低缩放下拖一点就跳一大截（"缩放不可控"的根因）。 */
const canvasScale = () => {
  try { return (app.canvas && app.canvas.ds && app.canvas.ds.scale) || 1; } catch (e) { return 1; }
};

/* 音频波形峰值缓存：文件名 -> {peaks, duration}，避免每次渲染重复解码 */
const _waveCache = {};
async function loadWavePeaks(name, n = 520) {
  if (_waveCache[name]) return _waveCache[name];
  const buf = await (await api.fetchApi("/view?filename=" + encodeURIComponent(name) + "&type=input")).arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = new AC();
  const ab = await actx.decodeAudioData(buf.slice(0));
  const ch = ab.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const off = i * step;
    for (let j = 0; j < step; j += 16) {
      const v = Math.abs(ch[off + j] || 0);
      if (v > m) m = v;
    }
    peaks[i] = m;
  }
  try { actx.close(); } catch (e) { /* 忽略 */ }
  const out = { peaks, duration: ab.duration };
  _waveCache[name] = out;
  return out;
}

const PANEL_CSS = `
.h3s { display:flex; flex-direction:column; gap:8px; width:100%; height:100%; padding:8px;
  box-sizing:border-box; font-size:12px; color:#ddd; background:#1a1a1e; overflow:auto; }
.h3s * { box-sizing:border-box; }
.h3s-bar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.h3s-btn { cursor:pointer; border:1px solid #555; border-radius:7px; padding:4px 10px;
  background:#2a2a30; color:#ddd; font-size:12px; }
.h3s-btn:hover { filter:brightness(1.3); }
.h3s-btn.primary { background:#185FA5; border-color:#185FA5; color:#fff; }
.h3s-btn:disabled { opacity:0.5; cursor:not-allowed; }
.h3s-status { font-size:11px; opacity:0.8; margin-left:auto; }
.h3s-total { font-size:11px; color:#9fd0ff; opacity:0.9; }
.h3s-tl { display:flex; flex-wrap:wrap; gap:6px; overflow-y:auto; overflow-x:hidden;
  align-content:flex-start; padding:4px; flex:1; min-width:0; position:relative; max-height:224px; }
.h3s-slot { flex:none; width:96px; height:64px; border:2px solid #444; border-radius:8px;
  cursor:pointer; background:#000; position:relative; overflow:hidden; }
.h3s-slot.sel { border-color:#378ADD; }
.h3s-slot.boxsel { outline:2px dashed #ffd166; box-shadow:0 0 0 2px rgba(255,209,102,0.22); }
.h3s-slot.sel.boxsel { border-color:#378ADD; outline:2px dashed #ffd166; }
.h3s-marquee { position:absolute; border:1px dashed #ffd166; background:rgba(255,209,102,0.12);
  pointer-events:none; z-index:5; }
.h3s-slot.done { border-color:#0F6E56; }
.h3s-slot.sel.done { border-color:#378ADD; outline:2px solid #0F6E56; }
.h3s-slot img { width:100%; height:100%; object-fit:cover; display:block; }
.h3s-slot .lab { position:absolute; left:4px; top:2px; font-size:11px; color:#fff;
  text-shadow:0 1px 2px #000; pointer-events:none; white-space:nowrap; }
.h3s-slot .dur { position:absolute; left:4px; bottom:2px; font-size:10px; color:#9fd0ff;
  text-shadow:0 1px 2px #000; pointer-events:none; }
.h3s-slot .off { position:absolute; right:4px; bottom:2px; font-size:10px; color:#f0ad4e;
  text-shadow:0 1px 2px #000; pointer-events:none; }
.h3s-slot .rz { position:absolute; right:0; top:0; width:8px; height:100%;
  cursor:ew-resize; background:transparent; z-index:2; }
.h3s-slot .rz:hover, .h3s-slot.dragging .rz { background:rgba(55,138,221,0.45); }
.h3s-slot.dragging { border-color:#378ADD; }
.h3s-slot .dur.pickable { pointer-events:auto; cursor:pointer; padding:1px 4px; margin-left:-4px;
  border-radius:4px; }
.h3s-slot .dur.pickable:hover { background:rgba(55,138,221,0.4); color:#fff; }
.h3s-durpick { position:fixed; z-index:9999; background:#1b1f24; border:1px solid #3a3f46;
  border-radius:7px; padding:5px; display:grid; grid-template-columns:repeat(5,auto); gap:3px;
  box-shadow:0 4px 16px rgba(0,0,0,0.55); }
.h3s-durpick button { font-size:11px; padding:2px 6px; background:#23282f; color:#cde;
  border:1px solid #3a3f46; border-radius:4px; cursor:pointer; }
.h3s-durpick button:hover { background:#378ADD; color:#fff; }
.h3s-durpick button.cur { background:#0F6E56; color:#fff; border-color:#0F6E56; }
.h3s-durspec { flex:1; min-width:220px; border-radius:7px; border:1px solid #555;
  background:#101014; color:#ddd; font-size:12px; padding:5px 8px; }
.h3s-editor { display:flex; flex-direction:column; gap:6px; border-top:1px solid #333; padding-top:6px;
  flex:1; min-height:120px; overflow:auto; resize:none; padding-bottom:8px; }
.h3s-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.h3s-ta { width:100%; flex:none; height:110px; min-height:60px; resize:both;
  border-radius:7px; border:1px solid #555; white-space:pre-wrap; overflow-wrap:break-word;
  background:#101014; color:#ddd; font-size:12px; padding:6px; }
.h3s-seed { width:130px; border-radius:7px; border:1px solid #555; background:#101014; color:#ddd;
  font-size:12px; padding:3px 6px; }
.h3s-seedmode { width:82px; border-radius:7px; border:1px solid #555; background:#101014; color:#ddd;
  font-size:11px; padding:3px 4px; }
.h3s-durinput { width:70px; border-radius:7px; border:1px solid #555; background:#101014; color:#ddd;
  font-size:12px; padding:3px 6px; }
.h3s-refs { display:flex; gap:4px; flex-wrap:wrap; align-items:center;
  resize:none; overflow:hidden; height:64px; min-height:48px; max-width:100%;
  border:1px solid #333; border-radius:6px; padding:4px; }
.h3s-ref { position:relative; width:48px; height:48px; border-radius:6px; overflow:hidden; border:1px solid #666; }
.h3s-ref img { width:100%; height:100%; object-fit:cover; }
.h3s-ref .x { position:absolute; top:0; right:0; background:rgba(0,0,0,0.7); color:#fff; border:none;
  cursor:pointer; font-size:10px; padding:1px 4px; }
/* 参考图缩略图随 refs 容器高度等比放大——拉高框=看清细节 */
.h3s-pic { position:relative; height:100%; width:auto; aspect-ratio:1/1; border-radius:6px; overflow:hidden;
  border:1px solid #666; cursor:pointer; flex:none; }
.h3s-pic:hover { border-color:#378ADD; }
.h3s-pic img { width:100%; height:100%; object-fit:cover; }
.h3s-pic .num { position:absolute; left:0; top:0; background:rgba(24,95,165,0.9); color:#fff;
  font-size:10px; padding:1px 5px; border-bottom-right-radius:6px; }
.h3s-pic .tag { position:absolute; left:0; bottom:0; right:0; background:rgba(0,0,0,0.55); color:#eee;
  font-size:9px; text-align:center; }
.h3s-pic .x { position:absolute; top:0; right:0; background:rgba(0,0,0,0.7); color:#fff; border:none;
  cursor:pointer; font-size:10px; padding:1px 4px; z-index:2; }
.h3s-role-card { display:flex; flex-direction:column; gap:3px; align-items:stretch; flex:none; height:100%; }
.h3s-role-card .h3s-pic { height:auto; flex:1; min-height:40px; }
.h3s-role-name { flex:none; height:22px; min-width:64px; border:1px solid #4a5662; border-radius:5px;
  background:#10151b; color:#cfe8ff; font-size:10px; padding:2px 5px; text-align:center; }
.h3s-role-name:focus { border-color:#378ADD; outline:none; }
.h3s-role-static { flex:none; height:22px; color:#9aa6b2; font-size:9px; line-height:22px;
  text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.h3s-track { display:flex; gap:6px; align-items:center; flex:none; }
.h3s-track .atag { flex:none; width:44px; text-align:right; font-size:10px; color:#9fd8c3; opacity:0.75; }
.h3s-atl { display:flex; gap:4px; overflow-x:auto; flex:1; align-items:center; }
.h3s-ablk { flex:none; height:24px; border-radius:5px; background:#123c30; border:1px solid #1f6a52;
  color:#9fd8c3; font-size:10px; display:flex; align-items:center; gap:5px; padding:0 6px;
  overflow:hidden; cursor:pointer; box-sizing:border-box; white-space:nowrap; position:relative; }
.h3s-ablk.off { background:#26262b; border-color:#3a3a40; color:#777; }
/* 视频界面加载对话框（v2.4）：虚线拖放区 */
.h3s-vdz { flex:1; min-height:240px; border:2px dashed #3a5a7a; border-radius:10px;
  display:flex; align-items:center; justify-content:center; text-align:center;
  color:#9fd0ff; font-size:13px; line-height:2; cursor:pointer; background:#14181e; padding:20px; }
.h3s-vdz:hover { border-color:#4a9eff; background:#16202a; }
.h3s-vdz.drop { border-color:#35d07f; background:#14261c; }
.h3s-ablk.sel { outline:1px solid #378ADD; }
.h3s-ablk .asw { flex:none; background:#1f6a52; border-radius:3px; padding:0 5px; font-size:9px; color:#dff; }
.h3s-ablk.off .asw { background:#444; color:#999; }
.h3s-ablk .awarn { flex:none; color:#ffd166; font-size:9px; }
.h3s-ablk.drop { outline:2px dashed #378ADD; background:#1a3a52; }
.h3s-slrow { display:flex; gap:6px; align-items:center; flex-wrap:wrap; padding:3px 6px;
  border:1px dashed #2f567a; border-radius:6px; background:#16222e; }
.h3s-audio-warn { color:#ffd166; font-size:11px; }
.h3s-ablk .alab { overflow:hidden; text-overflow:ellipsis; }
.h3s-trim { display:flex; flex-direction:column; gap:3px; }
.h3s-wave { width:100%; max-width:520px; height:46px; background:#0d1411; border:1px solid #2a4a3e;
  border-radius:6px; cursor:ew-resize; touch-action:none; display:block; }
.h3s-pvbox { resize: none; overflow: hidden; width: 100%; height: 270px;
  min-width: 240px; min-height: 135px; max-width: 100%;
  border: 1px solid #333; border-radius: 6px; background: #000; }
.h3s-pvbox video { width: 100%; height: 100%; display: block; object-fit: contain; }
.h3s-prog { height:5px; border-radius:3px; background:#333; overflow:hidden; }
.h3s-prog > div { height:100%; width:0%; background:#378ADD; transition:width 0.3s; }
.h3s-hint { font-size:10px; opacity:0.6; }
.h3s-pichint { font-size:10px; color:#8fd0a0; opacity:0.9; }
`;

const PX_PER_SEC = 24;
/* v2.13.15：段卡片统一小方块（换行网格排列 + 鼠标框选删除），不再按时长拉伸宽度；
   SLOT_W/H 为固定卡片尺寸，DRAG_PX_PER_SEC 为右缘拖拽调时长的灵敏度 */
const SLOT_W = 96;
const SLOT_H = 64;
const DRAG_PX_PER_SEC = 12;
const DUR_MIN = 1.6;
const DUR_MAX = 15;
// 点击时间轴段落时，在节点内显示对应成片；有文件则立即播放。
const SHOW_SAVED_SEGMENT_PREVIEW = true;

/* 与 ComfyUI 内置 Resolution Selector（comfy_extras/nodes_resolution.py）完全一致。 */
const H3S_ASPECT_RATIOS = {
  "1:1 (Square)": [1, 1],
  "2:3 (Portrait Photo)": [2, 3],
  "3:2 (Photo)": [3, 2],
  "3:4 (Portrait Standard)": [3, 4],
  "4:3 (Standard)": [4, 3],
  "9:16 (Portrait Widescreen)": [9, 16],
  "16:9 (Widescreen)": [16, 9],
  "21:9 (Ultrawide)": [21, 9],
};
const H3S_DEFAULT_ASPECT = "16:9 (Widescreen)";
const H3S_DEFAULT_MEGAPIXELS = 0.5;
const H3S_DEFAULT_MULTIPLE = 32;

function calculateSegmentResolution(aspectRatio, megapixels, multiple) {
  const ratio = H3S_ASPECT_RATIOS[aspectRatio] || H3S_ASPECT_RATIOS[H3S_DEFAULT_ASPECT];
  const mp = Math.round(Math.min(16, Math.max(0.1,
    Number(megapixels) || H3S_DEFAULT_MEGAPIXELS)) * 10) / 10;
  const mul = Math.min(128, Math.max(8, Math.round(Number(multiple) || H3S_DEFAULT_MULTIPLE)));
  const pyRound = (value) => {
    const lower = Math.floor(value);
    const fraction = value - lower;
    if (Math.abs(fraction - 0.5) < 1e-10) return lower % 2 === 0 ? lower : lower + 1;
    return Math.round(value);
  };
  const scale = Math.sqrt(mp * 1024 * 1024 / (ratio[0] * ratio[1]));
  return [Math.max(mul, pyRound(ratio[0] * scale / mul) * mul),
    Math.max(mul, pyRound(ratio[1] * scale / mul) * mul)];
}

function defaultResolutionFields() {
  const [width, height] = calculateSegmentResolution(
    H3S_DEFAULT_ASPECT, H3S_DEFAULT_MEGAPIXELS, H3S_DEFAULT_MULTIPLE);
  return {
    aspect_ratio: H3S_DEFAULT_ASPECT,
    megapixels: H3S_DEFAULT_MEGAPIXELS,
    multiple: H3S_DEFAULT_MULTIPLE,
    width,
    height,
  };
}

const DEFAULT_PROMPT_FIRST =
  "A 10-second opening clip of a comic-drama episode. <Picture 1>, <Picture 2> and <Picture 3> define the characters' appearance, outfits and the scene - keep them perfectly consistent.\n\nEvery shot is framed in MEDIUM SHOT or MEDIUM CLOSE-UP (waist-up). The camera NEVER pulls back to a wide or long shot.\n\n[0s-3s] ...\n[3s-7s] ...\n[7s-10s] ...\n\nAudio: ambient sound + character voices + soft BGM. No subtitles on screen.\nConstraints: keep the exact appearance from the reference images. Medium-shot framing only, no new characters, no scene changes, no text overlays.";
const DEFAULT_PROMPT_NEXT =
  "A 10-second continuation clip. <Picture 1>, <Picture 2> and <Picture 3> define the characters and scene. <Picture 4> is the FINAL FRAME of the previous clip: continue seamlessly from that exact moment - same characters, same positions, same lighting, matching motion, no jump-cut feeling.\n\nEvery shot is framed in MEDIUM SHOT or MEDIUM CLOSE-UP (waist-up). The camera NEVER pulls back to a wide or long shot.\n\n[0s-3s] ...\n[3s-7s] ...\n[7s-10s] ...\n\nAudio: ambient sound + character voices + soft BGM. No subtitles on screen.\nConstraints: keep the exact appearance from the reference images. Medium-shot framing only, no new characters, no scene changes, no text overlays.";

function defaultSegs() {
  const segs = [];
  for (let i = 0; i < 6; i++) {
    segs.push({
      prompt: i === 0 ? DEFAULT_PROMPT_FIRST : DEFAULT_PROMPT_NEXT,
      seed: 916261814925780 + (i + 1) * 777,
      refs: [],
      ...defaultResolutionFields(),
      duration: 10,
      inherit_shared: true,
      generation_mode: "multi_ref",
      use_tail: false,
      motion_context: false,
      motion_context_source: "local_latent",
      enabled: true,
      force: false,
    });
  }
  return segs;
}

/* 文本界面默认段（v2.11）：纯提示词生成，无参考图/视频/音频 */
function defaultTextSegs() {
  return [{
    prompt: "",
    seed: Math.floor(Math.random() * 1e15),
    refs: [],
    ...defaultResolutionFields(),
    duration: 10,
    inherit_shared: true,
    use_tail: false,
    motion_context: false,
    motion_context_source: "local_latent",
    motion_context_index: 0,
    enabled: true,
    force: false,
  }];
}

/* v2.16：角色参考图只需命名一次。角色名按文件名自动生成，并以文件路径为键保存到工作流属性；
   同一张图被复制到多个段时会共用一个角色名，修改一次即可全局生效。 */
function roleNameFromFilename(value) {
  let name = String(value || "").replace(/\\/g, "/").split("/").pop() || "角色";
  try { name = decodeURIComponent(name); } catch (e) { /* 非 URI 文件名 */ }
  name = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  name = name.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  return name || "角色";
}

function ensureRoleNameMap(node) {
  if (!node.properties || typeof node.properties !== "object") node.properties = {};
  const current = node.properties.h3_ref_role_names;
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    node.properties.h3_ref_role_names = {};
  }
  return node.properties.h3_ref_role_names;
}

function getRefRoleName(node, file, originalName = "") {
  const map = ensureRoleNameMap(node);
  if (!String(map[file] || "").trim()) map[file] = roleNameFromFilename(originalName || file);
  return String(map[file] || "").trim();
}

function collectRoleLibrary(node, segments) {
  const seen = new Set();
  const out = [];
  for (const seg of segments || []) {
    for (const file of (Array.isArray(seg.refs) ? seg.refs : [])) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, name: getRefRoleName(node, file) });
    }
  }
  return out;
}

function normalizedRoleText(value) {
  let text = String(value || "").toLowerCase();
  try { text = text.normalize("NFKC"); } catch (e) { /* 旧浏览器 */ }
  return text.replace(/[^a-z0-9一-龥]+/g, "");
}

function roleAliases(name) {
  const generic = new Set([
    "角色", "人物", "主角", "配角", "参考图", "立绘", "正面", "侧面", "全身", "半身",
    "role", "character", "subject", "player", "image", "picture", "reference", "front", "side", "fullbody",
  ]);
  const source = String(name || "").trim();
  const pieces = [source, ...source.split(/[\s_\-—|｜/\\,，.。()（）\[\]【】]+/)];
  const aliases = [];
  const seen = new Set();
  for (const piece of pieces) {
    const clean = normalizedRoleText(piece);
    if (clean.length < 2 || generic.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    aliases.push(clean);
  }
  return aliases.sort((a, b) => b.length - a.length);
}

function locallyMatchedRoles(prompt, library) {
  const body = normalizedRoleText(prompt);
  if (!body) return [];
  return (library || []).filter((role) => roleAliases(role.name).some((alias) => body.includes(alias)));
}

/* 从官方 Ref2VA 的 subject_definitions 中读取“角色名 … <Picture N>”关系。
   已识别的图放回对应 Picture 槽，未命名的首帧/场景图按上传顺序填空槽。 */
function officialRef2VARoleLayout(parsed, library) {
  const text = (parsed || []).map((part) => part.prompt || "").join("\n");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const pictureByFile = new Map();
  let p1AssetMapped = false;
  let p1RoleLike = false;
  for (const role of library || []) {
    const aliases = roleAliases(role.name);
    for (const line of lines) {
      const normalized = normalizedRoleText(line);
      if (!aliases.some((alias) => normalized.includes(alias))) continue;
      const pictures = [...line.matchAll(/<Picture\s+(\d+)>/gi)];
      if (!pictures.length) continue;
      const picture = parseInt(pictures[pictures.length - 1][1], 10);
      pictureByFile.set(role.file, picture);
      if (picture === 1) {
        p1AssetMapped = true;
        if (/<Subject\s+\d+>|\b(?:character|player)\b|角色|人物/i.test(line)) p1RoleLike = true;
      }
      break;
    }
  }

  const slots = new Array((library || []).length).fill(null);
  const remaining = [];
  for (const role of library || []) {
    const picture = pictureByFile.get(role.file);
    if (picture >= 1 && picture <= slots.length && !slots[picture - 1]) slots[picture - 1] = role;
    else remaining.push(role);
  }
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i]) slots[i] = remaining.shift() || null;
  }
  const ordered = slots.filter(Boolean);
  const mappedPictures = [...pictureByFile.values()].filter(Number.isFinite);
  const p1IsNamedRole = p1RoleLike;
  const hasDedicatedP1Asset = !p1IsNamedRole
    && (p1AssetMapped || (library || []).some((role) => !pictureByFile.has(role.file)));
  const maxPicture = mappedPictures.length ? Math.max(...mappedPictures) : 0;
  return { ordered, pictureByFile, p1IsNamedRole, hasDedicatedP1Asset, maxPicture };
}

function bindOrdinaryPromptToRoles(prompt, roles, useTail) {
  const text = String(prompt || "").trim();
  if (!roles.length || /<Picture\s+\d+>/i.test(text) || /^\s*subject_definitions\s*[:：]/im.test(text)) return text;
  const first = useTail ? 2 : 1;
  const bindings = roles.map((role, i) => `<Picture ${first + i}> 是角色「${role.name}」的唯一身份参考图`).join("；");
  return "角色参考图绑定（严格保持姓名、脸、发型与服装一致，不得互换）：" + bindings + "。\n\n" + text;
}

/* MiniMax H3 官方带字段模板：Base（三字段）与 Ref2VA（六字段）。
   字段结构必须完整保留；超过单次生成上限时，只切分镜头正文并为每段重建完整模板。 */
function parseStructuredOfficialScript(text) {
  let t = String(text || "").replace(/^\uFEFF/, "");
  t = t.replace(/^[ \t]*\x60{3}(?:text|txt|markdown)?[ \t]*$/gim, "").trim();

  const fieldRe = /(?:^|\n)[ \t]*(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music)[ \t]*[:：][ \t]*/gi;
  const fieldMarks = [];
  let fm;
  while ((fm = fieldRe.exec(t))) {
    fieldMarks.push({
      name: fm[1].toLowerCase(),
      start: fm.index + (fm[0].charAt(0) === "\n" ? 1 : 0),
      end: fieldRe.lastIndex,
    });
  }
  if (!fieldMarks.length) return null;

  const fields = {};
  for (let i = 0; i < fieldMarks.length; i++) {
    const mark = fieldMarks[i];
    const end = i + 1 < fieldMarks.length ? fieldMarks[i + 1].start : t.length;
    if (fields[mark.name] == null) fields[mark.name] = t.slice(mark.end, end).trim();
  }

  const isRef = fields.detailed_description != null
    || fields.subject_definitions != null
    || fields.retention_analysis != null;
  const isBase = !isRef && fields.integrated_multimodal_description != null;
  if (!isRef && !isBase) return null;

  const warnings = [];
  const addWarning = (msg) => { if (msg && !warnings.includes(msg)) warnings.push(msg); };
  const required = isRef
    ? ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]
    : ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"];
  for (const name of required) {
    if (!(fields[name] || "").trim()) addWarning("缺少或留空字段 " + name);
  }
  if (/【[^】]+】|\b(?:TODO|PLACEHOLDER)\b|<INSERT(?:\s+[^>]*)?>/i.test(t)) {
    addWarning("仍有未替换的模板占位符");
  }

  const mainName = isRef ? "detailed_description" : "integrated_multimodal_description";
  const description = (fields[mainName] || "").trim();
  const mainMark = fieldMarks.find((x) => x.name === mainName);
  const instruction = isBase && mainMark ? t.slice(0, mainMark.start).trim() : "";

  let mode = isRef ? "Ref2VA" : "T2VA";
  if (isBase && /Picture\s*2[\s\S]{0,240}aligns\s+with\s+the\s+\d+(?:\.\d+)?\s*-\s*second\s+mark/i.test(instruction)) {
    mode = "FL2VA";
  } else if (isBase && /at\s+0(?:\.0+)?\s+seconds?\s+into\s+the\s+target\s+video[\s\S]{0,160}fully\s+referenced/i.test(instruction)) {
    mode = "I2VA";
  } else if (isBase && /aligns\s+with\s+the\s+\d+(?:\.\d+)?\s*-\s*second\s+mark/i.test(instruction)) {
    mode = "L2VA";
  }

  let alignmentDuration = 0;
  for (const am of instruction.matchAll(/aligns\s+with\s+the\s+(\d+(?:\.\d+)?)\s*-\s*second\s+mark/gi)) {
    alignmentDuration = Math.max(alignmentDuration, parseFloat(am[1]));
  }

  const shotRe = /\[Shot\s+(\d+)\s*\]/gi;
  const shotMarks = [];
  let sm;
  while ((sm = shotRe.exec(description))) {
    shotMarks.push({ num: parseInt(sm[1], 10), idx: sm.index, end: shotRe.lastIndex });
  }
  const descriptionLead = shotMarks.length ? description.slice(0, shotMarks[0].idx).trim() : description;
  const atRe = /^[\s,，]*At\s+(?:(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?|(\d+(?:\.\d+)?)\s*s)\s*[,，]?\s*/i;
  const shots = [];
  for (let i = 0; i < shotMarks.length; i++) {
    const mark = shotMarks[i];
    const end = i + 1 < shotMarks.length ? shotMarks[i + 1].idx : description.length;
    let body = description.slice(mark.end, end).trim();
    let start = null;
    const am = body.match(atRe);
    if (am) {
      start = am[1] != null
        ? parseInt(am[1], 10) * 60 + parseInt(am[2], 10) + (am[3] ? parseFloat("0." + am[3]) : 0)
        : parseFloat(am[4]);
      body = body.slice(am[0].length).trim();
    }
    shots.push({ num: mark.num, start, body, dur: 0 });
  }

  if (shots.length) {
    if (shots[0].start == null) shots[0].start = 0;
    let sequential = shots[0].num === 1;
    for (let i = 1; i < shots.length; i++) {
      if (shots[i].num !== shots[i - 1].num + 1) sequential = false;
    }
    if (!sequential) addWarning("Shot 编号不是从 1 开始连续递增");

    let timelineValid = Number.isFinite(shots[0].start);
    for (let i = 1; i < shots.length; i++) {
      if (!Number.isFinite(shots[i].start)) {
        timelineValid = false;
        addWarning("Shot " + shots[i].num + " 缺少 At 时间标记");
      } else if (Number.isFinite(shots[i - 1].start) && shots[i].start <= shots[i - 1].start) {
        timelineValid = false;
        addWarning("Shot 时间没有严格递增");
      }
    }

    let lastGap = 0;
    for (let i = 0; i + 1 < shots.length; i++) {
      if (Number.isFinite(shots[i].start) && Number.isFinite(shots[i + 1].start) && shots[i + 1].start > shots[i].start) {
        shots[i].dur = shots[i + 1].start - shots[i].start;
        lastGap = shots[i].dur;
      }
    }
    if (timelineValid && alignmentDuration > shots[shots.length - 1].start) {
      shots[shots.length - 1].dur = alignmentDuration - shots[shots.length - 1].start;
    } else if (timelineValid && alignmentDuration > 0) {
      addWarning("图片对齐终点不晚于最后一个 Shot 起点");
      shots[shots.length - 1].dur = lastGap;
    } else if (timelineValid) {
      shots[shots.length - 1].dur = lastGap;
    }
  } else if (description) {
    addWarning("未找到 [Shot N]，已按一个完整段导入");
  }

  if (isRef) {
    const definedSubjects = new Set();
    for (const m of (fields.subject_definitions || "").matchAll(/<Subject\s+(\d+)>/gi)) definedSubjects.add(m[1]);
    for (const m of description.matchAll(/<Subject\s+(\d+)>/gi)) {
      if (!definedSubjects.has(m[1])) addWarning("<Subject " + m[1] + "> 在 subject_definitions 中未定义");
    }
  }

  const buildPrompt = (body) => {
    const parts = [];
    if (isBase) {
      if (instruction) parts.push(instruction);
      parts.push("integrated_multimodal_description:\n" + body.trim());
    } else {
      if ((fields.subject_definitions || "").trim()) parts.push("subject_definitions:\n" + fields.subject_definitions.trim());
      if ((fields.summary || "").trim()) parts.push("summary:\n" + fields.summary.trim());
      if ((fields.retention_analysis || "").trim()) parts.push("retention_analysis:\n" + fields.retention_analysis.trim());
      parts.push("detailed_description:\n" + body.trim());
    }
    if ((fields.overall_soundscape || "").trim()) parts.push("overall_soundscape:\n" + fields.overall_soundscape.trim());
    if ((fields.non_diegetic_music || "").trim()) parts.push("non_diegetic_music:\n" + fields.non_diegetic_music.trim());
    return parts.join("\n\n");
  };

  const fmtTs = (sec) => {
    const totalMs = Math.max(0, Math.round(sec * 1000));
    const mm = Math.floor(totalMs / 60000);
    const rem = totalMs - mm * 60000;
    const ss = Math.floor(rem / 1000);
    const ms = rem - ss * 1000;
    return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + "." + String(ms).padStart(3, "0");
  };
  const recon = (bucket, bucketStart) => {
    const timeline = bucket.map((shot, i) => {
      const rel = Number.isFinite(shot.start) ? shot.start - bucketStart : null;
      const head = "[Shot " + (i + 1) + "]";
      if (i === 0 || rel == null || rel < 0.05) return head + " " + shot.body;
      return head + " At " + fmtTs(rel) + ", " + shot.body;
    }).join("\n");
    return [descriptionLead, timeline].filter(Boolean).join("\n");
  };

  let globalStyle = "";
  if (isBase && shots.length) {
    const splitSentences = (value) => (String(value || "").match(/[^.!?。！？\n]+[.!?。！？]?/g) || [])
      .map((x) => x.trim()).filter(Boolean);
    const baseline = [];
    const constraints = [];
    const seen = new Set();
    const addUnique = (list, sentence) => {
      const clean = sentence.replace(/\s+/g, " ").trim();
      const key = clean.toLowerCase();
      if (clean && !seen.has(key)) { seen.add(key); list.push(clean); }
    };
    const STYLE_KW = /(stylized|style|anime|animation|cartoon|pixar|3d|2d|cinematic|realistic|render|painting|illustration|comic|toon|graphic[\s-]?novel|dieselpunk|steampunk|commercial game|visual treatment)/i;
    const PALETTE_KW = /(palette|color system|main color|text color|accent color|midnight navy|warm ivory|cyan|amber|调色板|色彩|主色|强调色)/i;
    const LOCK_KW = /(identit|remain(?:s)? locked|keep.*consistent|appearance|height contrast|body proportions?|hairstyles?|outfits?|left-side|right-side|left side|right side|身份|一致|体型|发型|服装|左侧|右侧)/i;
    const CHARACTER_KW = /(?:PLAYER\s*[12]|Character\s*[AB]|<Subject\s+\d+>)/i;
    const LOOK_KW = /(tall|slim|shorter|broad|young|man|woman|hair|jacket|shirt|pants|boots|wears?|mechanical|claw|gauntlet|outfit|face|高挑|修长|宽厚|头发|夹克|机械)/i;
    for (const sentence of splitSentences([descriptionLead, shots[0].body].filter(Boolean).join("\n"))) {
      if (STYLE_KW.test(sentence) || PALETTE_KW.test(sentence) || LOCK_KW.test(sentence)
          || (CHARACTER_KW.test(sentence) && LOOK_KW.test(sentence))) {
        addUnique(baseline, sentence);
      }
      if (baseline.length >= 8) break;
    }
    for (const sentence of splitSentences(shots.map((shot) => shot.body).join("\n"))) {
      if (/^(?:No|Never|Avoid|Do not|Global constraints?)\b/i.test(sentence)
          || /(no subtitles|no watermark|禁止字幕|不要字幕|无水印)/i.test(sentence)) {
        addUnique(constraints, sentence);
      }
    }
    constraints.sort((a, b) => b.length - a.length);
    if (baseline.length) {
      globalStyle = "Global visual and identity baseline:\n" + baseline.join(" ");
      if (constraints.length) globalStyle += "\n\nGlobal constraints:\n" + constraints.slice(0, 3).join(" ");
    } else {
      const b0 = shots[0].body;
      const camM = b0.match(/,\s+(?=a\s+(?:extreme\s+)?(?:low|high|wide|close(?:-up)?|medium|distant|tracking|side|top|bird'?s?-?eye|over[\s-]?the[\s-]?shoulder|POV|profile|three[\s-]?quarter)[\w' -]{0,24}?(?:shot|angle|view|frames?\b))|,\s+(?=the camera\b)/i);
      if (camM && camM.index >= 40 && STYLE_KW.test(b0.slice(0, camM.index))) {
        globalStyle = b0.slice(0, camM.index).trim();
      }
    }
  }

  const MAXGEN = 362 / 24;
  let total = 0;
  const timelineValid = shots.length
    && shots.every((shot) => Number.isFinite(shot.start))
    && shots[shots.length - 1].dur > 0;
  if (timelineValid) {
    total = shots[shots.length - 1].start + shots[shots.length - 1].dur - shots[0].start;
  }

  const segs = [];
  if (!shots.length || !(total > 0)) {
    segs.push({ duration: 0, prompt: buildPrompt(description) });
  } else if (total <= MAXGEN + 0.001) {
    segs.push({ duration: clampDur(total), prompt: buildPrompt(recon(shots, shots[0].start)) });
  } else {
    if (instruction) addWarning("关键帧对齐模板超过 15 秒，拆段后请检查各段 Picture 对齐时间");
    const buckets = [];
    let cur = [];
    let curStart = 0;
    for (const shot of shots) {
      const end = shot.start + shot.dur;
      if (cur.length && end - curStart > MAXGEN) {
        buckets.push(cur);
        cur = [];
      }
      if (!cur.length) curStart = shot.start;
      cur.push(shot);
      if (shot.dur > MAXGEN) addWarning("存在单个 Shot 超过 15 秒，导入后需要手动拆镜");
    }
    if (cur.length) buckets.push(cur);
    for (const bucket of buckets) {
      const bucketStart = bucket[0].start;
      const bucketEnd = bucket[bucket.length - 1].start + bucket[bucket.length - 1].dur;
      segs.push({
        duration: clampDur(bucketEnd - bucketStart),
        prompt: buildPrompt(recon(bucket, bucketStart)),
      });
    }
  }

  segs.globalExtra = "";
  segs.globalStyle = segs.length > 1 && isBase ? globalStyle : "";
  segs.official = true;
  segs.officialFormat = isRef ? "ref2va" : "base";
  segs.officialMode = mode;
  segs.officialLabel = isRef ? "官方 Ref2VA" : "官方 " + mode;
  segs.warnings = warnings;
  return segs;
}

/* v2.13.5：官方 integrated_multimodal_description 格式直导（整段连写、[Shot N] 在行中，
   逐行解析器认不出来，所以独立整串解析，优先于逐行解析）。
   识别特征：含 "integrated_multimodal_description:" 标签；或 ≥2 个 [Shot N] 标记且带 "At mm:ss.mmm"。
   规则：
   - 按 [Shot N] 切镜；"At mm:ss(.mmm)" 是该镜绝对起点，本镜时长 = 下一镜起点 - 本镜起点
   - 首镜无 At 视为 0s；末镜无终点沿用上一镜时长；时间戳缺失/乱序的镜沿用上一镜
   - overall_soundscape / non_diegetic_music 不丢：拼成 Soundscape:/Music: 挂返回值 .globalExtra，
     由调用方并入全局提示词框（这两个是整片级描述，属于全局不属于某一镜）
   - Shot 1 开头常带整片风格定调句：在首个运镜词（a low-angle shot / the camera…）前切开，
     风格挂 .globalStyle 进全局框，2~N 段才有统一风格基准；切不出则原样保留（安全兜底）
   返回段数组（附 .globalExtra/.globalStyle/.official），不是官方格式返回 null。 */
function parseOfficialScript(text) {
  const structured = parseStructuredOfficialScript(text);
  if (structured) return structured;

  const t = String(text || "");
  const shotRe = /\[Shot\s+(\d+)\s*\]/gi;
  const marks = [];
  let m;
  while ((m = shotRe.exec(t))) marks.push({ idx: m.index, end: m.index + m[0].length });
  const hasLabel = /integrated_multimodal_description\s*[:：]/i.test(t);
  if (!hasLabel && !(marks.length >= 2 && /At\s+\d{1,3}:\d{2}/.test(t))) return null;
  if (!marks.length) return null;

  /* 两个整片级声音字段（可能缺省、顺序任意）：正文 = 字段标签后 → 下一个字段标签前 */
  const sndM = t.match(/overall_soundscape\s*[:：]/i);
  const musM = t.match(/non_diegetic_music\s*[:：]/i);
  const fieldText = (mm, other) => {
    if (!mm) return "";
    let e = t.length;
    if (other && other.index > mm.index) e = other.index;
    return t.slice(mm.index + mm[0].length, e).trim();
  };
  const sndTxt = fieldText(sndM, musM);
  const musTxt = fieldText(musM, sndM);

  /* 镜头区右边界：声音字段开始前（防止末镜把 soundscape 正文吃进来） */
  let regionEnd = t.length;
  for (const mm of [sndM, musM]) if (mm && mm.index > marks[0].idx) regionEnd = Math.min(regionEnd, mm.index);

  /* "At 00:03.000," / "At 0:03" / "At 3s" 前缀 → 绝对起点秒；注意 "At dusk" 这类无数字不误吃 */
  const atRe = /^[\s,，]*At\s+(?:(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?|(\d+(?:\.\d+)?)\s*s)\s*[,，]?\s*/i;
  const shots = [];
  for (let i = 0; i < marks.length; i++) {
    const to = (i + 1 < marks.length) ? marks[i + 1].idx : regionEnd;
    let body = t.slice(marks[i].end, to).trim();
    let start = null;
    const am = body.match(atRe);
    if (am) {
      start = am[1] != null
        ? parseInt(am[1], 10) * 60 + parseInt(am[2], 10) + (am[3] ? parseFloat("0." + am[3]) : 0)
        : parseFloat(am[4]);
      body = body.slice(am[0].length).trim();
    }
    if (body) body = body.charAt(0).toUpperCase() + body.slice(1);
    shots.push({ start, body });
  }
  if (!shots.length) return null;
  if (shots[0].start == null) shots[0].start = 0;

  /* Shot 1 风格定调句提取：首个运镜词之前 = 整片风格（≥40 字符且含风格词才取）。
     v2.13.8：不再从段里删掉——段提示词保留完整官方文本（含 Shot1 风格句，自包含，H3 一次生成整段），
     全局框同时也放一份（globalStyle），多生成时各段通过全局注入共享风格。宁可重复也不丢。 */
  let globalStyle = "";
  {
    const b0 = shots[0].body;
    const camM = b0.match(/,\s+(?=a\s+(?:extreme\s+)?(?:low|high|wide|close(?:-up)?|medium|distant|tracking|side|top|bird'?s?-?eye|over[\s-]?the[\s-]?shoulder|POV|profile|three[\s-]?quarter)[\w' -]{0,24}?(?:shot|angle|view|frames?\b))|,\s+(?=the camera\b)/i);
    if (camM && camM.index >= 40 && /(anime|animation|cartoon|pixar|3d|2d|cinematic|realistic|style|render|painting|illustration|comic|toon)/i.test(b0.slice(0, camM.index))) {
      globalStyle = b0.slice(0, camM.index).trim();
    }
  }

  /* 每镜时长 = 下一镜起点 - 本镜起点；末镜/缺时间戳沿用上一镜。先算出每镜 start/dur。 */
  let lastRaw = 0;
  for (let i = 0; i < shots.length; i++) {
    let d = 0;
    if (shots[i].start != null) {
      for (let j = i + 1; j < shots.length; j++) {
        if (shots[j].start != null) { d = shots[j].start - shots[i].start; break; }
      }
    }
    if (!(d > 0)) d = lastRaw;
    if (d > 0) lastRaw = d;
    shots[i].dur = d > 0 ? d : 0;
  }
  const total = shots.length ? shots[shots.length - 1].start + shots[shots.length - 1].dur : 0;

  /* v2.13.8：H3 单次可原生生成 ≤15s，官方格式内部就用 [Shot N] At mm:ss 排子镜头时间轴——
     所以 ≤15s 的片子不再按 Shot 拆成多段（多次生成易断连），而是合并成「一段=一次生成」，
     段提示词保留 [Shot N] At 结构让 H3 自己卡内部节奏；>15s 才按贪心把连续 Shot 装进 ≤15s 生成桶，
     桶内 Shot 重新相对桶起点计时（每次生成都从 0s 起）。 */
  const MAXGEN = 362 / 24;   // 15.083s，H3 单次原生上限（VAE 对齐最高档）
  const fmtTs = (sec) => {
    sec = Math.max(0, sec);
    const mm = Math.floor(sec / 60), ss = sec - mm * 60;
    const whole = Math.floor(ss), ms = Math.round((ss - whole) * 1000);
    return String(mm).padStart(2, "0") + ":" + String(whole).padStart(2, "0") + "." + String(ms).padStart(3, "0");
  };
  const recon = (bucket, bStart) => bucket.map((sh, k) => {
    const rel = sh.start - bStart;
    return (k === 0 && rel < 0.05)
      ? "[Shot " + (k + 1) + "] " + sh.body
      : "[Shot " + (k + 1) + "] At " + fmtTs(rel) + ", " + sh.body;
  }).join(" ");

  /* 单段（≤15s 一次生成）：把音效/配乐也并进段提示词，让这一段成为完整自包含的官方提示词，
     不依赖全局框开关；多段（>15s）才交给全局框共享。 */
  const sndSuffix = (sndTxt ? "\n\noverall_soundscape: " + sndTxt : "") + (musTxt ? "\n\nnon_diegetic_music: " + musTxt : "");
  const segs = [];
  if (total > 0 && total <= MAXGEN + 0.001) {
    segs.push({ duration: clampDur(total), prompt: recon(shots, shots[0].start) + sndSuffix });
  } else if (total > 0) {
    const buckets = [];
    let cur = [], curStart = 0;
    for (const sh of shots) {
      const end = sh.start + sh.dur;
      if (cur.length && (end - curStart) > MAXGEN) { buckets.push(cur); cur = []; }
      if (!cur.length) curStart = sh.start;
      cur.push(sh);
    }
    if (cur.length) buckets.push(cur);
    for (const b of buckets) {
      const bStart = b[0].start, bEnd = b[b.length - 1].start + b[b.length - 1].dur;
      segs.push({ duration: clampDur(bEnd - bStart), prompt: recon(b, bStart) });
    }
  }
  if (!segs.length && shots.length) segs.push({ duration: 0, prompt: recon(shots, shots[0].start) + sndSuffix });

  const single = segs.length <= 1;
  const gp = [];
  if (sndTxt) gp.push("Soundscape: " + sndTxt);
  if (musTxt) gp.push("Music: " + musTxt);
  /* 单段（≤15s 一次生成）：风格句 + 音效/配乐都已并入段提示词（完整自包含官方文本），全局框不再重复；
     多段（>15s 分桶）：风格 + 音效/配乐放全局框，各生成桶通过全局注入共享（桶2+ 段内没有）。 */
  segs.globalExtra = single ? "" : gp.join("\n\n");
  segs.globalStyle = single ? "" : globalStyle;
  segs.official = true;
  segs.officialFormat = "base";
  segs.officialMode = "auto";
  segs.officialLabel = "官方 Shot 时间线";
  segs.warnings = [];
  return segs;
}

/* v2.13.9：无时间标记的长文案 → 按"朗读时长"智能分段（每段 8~15 秒，标准语速 4.5 字/秒，
   与台词时长建议同套估算：CJK 1 字 = 1 单位，拉丁词 = 2.5 单位）。
   断点优先级：段落换行 > 句末标点（。！？；…!.?）> 从句标点（，、：）——优先断在完整
   情节/镜头边界，绝不在句中硬断（仅对无标点超长句按字数兜底硬切）。
   返回 [{duration, prompt}]，duration 已吸附 VAE 档位。 */
function autoSplitByDuration(text, minDur = 8, maxDur = 15, target = 12) {
  const RATE = 4.5;   // 标准语速（字/秒）
  const durOf = (t) => {
    const cjk = (t.match(/[一-鿿　-〿＀-￦]/g) || []).length;
    const latin = (t.replace(/[一-鿿　-〿＀-￦]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
    return (cjk + latin * 2.5) / RATE + 0.2;   // 句末换气 0.2s
  };
  // 1) 切单元：{text, para}，para=true 表示它前面是段落边界
  const units = [];
  const hardSplit = (sentence, para) => {
    const clauses = sentence.match(/[^，、：,;:]+[，、：,;:]?/g) || [sentence];
    let buf = "", first = para;
    for (const c of clauses) {
      if (buf && durOf(buf + c) > maxDur) { units.push({ text: buf, para: first }); buf = c; first = false; }
      else buf += c;
    }
    while (buf && durOf(buf) > maxDur) {   // 无标点长句兜底：按字数硬切
      const n = Math.max(1, Math.floor((maxDur - 0.2) * RATE));
      units.push({ text: buf.slice(0, n), para: first }); first = false;
      buf = buf.slice(n);
    }
    if (buf.trim()) units.push({ text: buf, para: first });
  };
  for (const para of String(text).split(/\r?\n+/)) {
    const p = para.trim();
    if (!p) continue;
    // 句末标点：中文全角 。！？；… + 英文 .!?（英文句点需后跟空格/行尾，避免误切小数点）
    const sents = p.match(/[^。！？；…!?]*?(?:[。！？；…!?]+|\.(?=\s|$)|$)/g) || [p];
    let first = true;
    for (const s of sents) {
      if (!s.trim()) continue;
      if (durOf(s) > maxDur) hardSplit(s, first);
      else units.push({ text: s, para: first });
      first = false;
    }
  }
  // 2) 贪心打包：满 minDur 后，到 target / 再加会超 maxDur / 遇段落边界 → 断。
  //    硬顶 maxDur+1.2s 宽容值：即使未满 minDur，超过硬顶也断（防极端溢出被 clamp 吞掉文案时长）
  const segs = [];
  let cur = [], curDur = 0;
  const flush = () => {
    if (!cur.length) return;
    segs.push({ duration: clampDur(Math.min(15, Math.max(1.6, curDur))), prompt: cur.join("").trim() });
    cur = []; curDur = 0;
  };
  for (const u of units) {
    const d = durOf(u.text);
    const would = curDur + d;
    if (cur.length && ((curDur >= minDur && (would > maxDur || curDur >= target || u.para)) || would > maxDur + 1.2)) flush();
    cur.push(u.text); curDur += d;
  }
  flush();
  return segs.filter((s) => s.prompt);
}

/* ---- 分镜脚本解析（v2.11 文本界面）----
   把"带时间标记的文本"拆成段：每识别到一个行首时间标记就开新段，
   时长=标记里的时间（区间取差值），提示词=标记后的正文（可跨行）。
   支持三类写法（官方 Shot 格式优先，余下两类混用时以「段N」类标记优先切分）：
   0. 官方格式：integrated_multimodal_description: [Shot 1] … [Shot 2] At 00:03.000, …（整段连写）
   A. 段标记：段1（6秒）：… / 第2段 8s / 镜头3：…（无时间则看正文里的时间轴标签）
   B. 区间标记：[0s-6.6s] … / 0:00-0:06 … / 0至6秒：… / 6.6秒 | …
   C. 整篇无标记（v2.13.9）：按朗读时长自动分段，每段 8~15 秒，断在句/段边界 */
function parseScript(text) {
  const off = parseOfficialScript(text);   // v2.13.5：官方 Shot 格式优先
  if (off) return off;
  const lines = String(text || "").split(/\r?\n/);
  const namedRe = /^\s*(?:【\s*)?(?:第\s*\d+\s*(?:段|镜|镜头)|(?:段|镜头|shot|scene)\s*\d+)/i;
  const hasNamed = lines.some((l) => namedRe.test(l));

  // 从一行行首提取时间区间/时长，返回 {dur, rest} 或 null
  const timeHdr = (L) => {
    let m;
    // [0s-6.6s] / 0s-6.6s / 0秒-6.6秒
    if ((m = L.match(/^\s*\[?\s*(\d+(?:\.\d+)?)\s*(?:s|秒)\s*[-–~—]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*\]?\s*[:：]?\s*/i)))
      return { dur: parseFloat(m[2]) - parseFloat(m[1]), rest: L.slice(m[0].length) };
    // 0:00-0:06
    if ((m = L.match(/^\s*\[?\s*(\d{1,2}):(\d{2})\s*[-–~—]\s*(\d{1,2}):(\d{2})\s*\]?\s*[:：]?\s*/)))
      return { dur: (parseInt(m[3], 10) * 60 + parseInt(m[4], 10)) - (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)), rest: L.slice(m[0].length) };
    // 0至6秒：/ 0到6秒
    if ((m = L.match(/^\s*(\d+(?:\.\d+)?)\s*(?:至|到)\s*(\d+(?:\.\d+)?)\s*秒?\s*[:：，,]?\s*/)))
      return { dur: parseFloat(m[2]) - parseFloat(m[1]), rest: L.slice(m[0].length) };
    // 6.6秒 | …（时长直写，必须带 |｜:： 分隔符，避免误吃正文里的秒数）
    if ((m = L.match(/^\s*(?:时长\s*)?(\d+(?:\.\d+)?)\s*(?:s|秒)\s*[|｜:：]\s*/i)))
      return { dur: parseFloat(m[1]), rest: L.slice(m[0].length) };
    return null;
  };
  // 段标记行（可带时长）：段1（6秒）：… / 第2段 8s … / 镜头3：…
  const namedHdr = (L) => {
    const m = L.match(/^\s*(?:【\s*)?(?:第\s*(\d+)\s*(?:段|镜|镜头)|(?:段|镜头|shot|scene)\s*(\d+))\s*(?:】)?\s*[（(\[：:]?\s*(?:(\d+(?:\.\d+)?)\s*(?:s|秒))?\s*[）)\]]?\s*[:：]?\s*/i);
    if (!m) return null;
    return { dur: m[3] ? parseFloat(m[3]) : null, rest: L.slice(m[0].length) };
  };

  const segs = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cur.prompt = cur.prompt.replace(/^\s+|\s+$/g, "");
    if (cur.prompt) segs.push(cur);
    cur = null;
  };
  for (const raw of lines) {
    const L = raw.replace(/\s+$/, "");
    if (!L.trim()) { if (cur) cur.prompt += "\n"; continue; }
    let h = null;
    if (hasNamed) {
      h = namedHdr(L);                      // 有段标记的脚本：只有段标记切分
    } else {
      h = timeHdr(L);                       // 无段标记：每个时间区间行就是一段
    }
    if (h) {
      flush();
      cur = { duration: h.dur, prompt: h.rest || "" };
    } else if (cur) {
      cur.prompt += (cur.prompt ? "\n" : "") + L;
    }
    // 第一个标记之前的散行（标题/说明）忽略
  }
  flush();

  /* 段标记没写时长：看正文里的时间轴标签（[0s-3s]/0至3秒/mm:ss）取最大结束秒 */
  const bodyEnd = (p) => {
    let end = 0;
    for (const m of p.matchAll(/\[?\s*(\d+(?:\.\d+)?)\s*s\s*[-–~—]\s*(\d+(?:\.\d+)?)\s*s\s*\]?/gi))
      end = Math.max(end, parseFloat(m[2]));
    for (const m of p.matchAll(/(\d+(?:\.\d+)?)\s*(?:至|到)\s*(\d+(?:\.\d+)?)\s*秒/g))
      end = Math.max(end, parseFloat(m[2]));
    for (const m of p.matchAll(/(\d{1,2}):(\d{2})\s*[-–~—]\s*(\d{1,2}):(\d{2})/g))
      end = Math.max(end, parseInt(m[3], 10) * 60 + parseInt(m[4], 10));
    return end;
  };
  for (const s of segs) {
    let d = (s.duration != null && s.duration > 0) ? s.duration : bodyEnd(s.prompt);
    if (!(d > 0)) d = 10;                       // 实在没写时间：默认 10 秒
    s.duration = clampDur(Math.min(15, Math.max(1.6, d)));
    delete s.dur;
  }

  /* 整篇没有任何标记（v2.13.9）：按朗读时长自动分段（每段 8~15s，断在句/段边界），
     替代旧的整篇单段导入——3 分钟小说直接粘贴即可自动拆段 */
  if (!segs.length && String(text || "").trim()) {
    return autoSplitByDuration(String(text).trim());
  }
  return segs;
}

/* v2.13.2：解析脚本时自动抽出"所有段共用"的风格/角色/场景常量，填进全局提示词框，
   免去每段重复抄写。只在全局框为空时填（不覆盖用户手填内容）。返回字符串或 ""。
   结构：风格公共前缀（所有段一致才保留）+ 首段场景搭建句 + 角色定义（≥2段出现，取最详尽版）+ 约束句。 */
function extractGlobalPrompt(segs) {
  const prompts = segs.map((s) => (s.prompt || "").trim()).filter(Boolean);
  if (prompts.length < 2) return "";   // 单段/不足两段无意义

  const STYLE_KW = /(pixar|3d|cartoon|animation|cgi|render|h3 render|16:9|cinematic|anime|realistic|oil painting|watercolor|stop[\s-]?motion|claymation|pixel|low poly|unreal|blender|toon|storybook|illustration|ink wash|comic|风格|动画|写实)/i;
  const LOOKS = /(scale|belly|head-tall|head tall|tall|eye|horn|wing|fur|hair|wears|costume|body|skin|color|green|red|blue|orange|yellow|white|black|creature|dragon|character|鳞片|腹|肚|角|翅膀|眼睛|毛发|服装|身高)/i;

  // 1) 风格公共前缀：所有段的最长公共前缀。
  //    必须用"运行中的公共前缀"逐段收缩——每轮都拿 prompts[0] 比会留下首尾两段的公共前缀（bug）
  let pref = prompts[0];
  for (let i = 1; i < prompts.length; i++) {
    const a = pref, b = prompts[i];
    let j = 0;
    while (j < a.length && j < b.length && a[j] === b[j]) j++;
    pref = a.slice(0, j);
    if (!pref) break;
  }
  // 若前缀结束在单词中间（首段该位置是字母数字），回退到上一个空格，避免截出半个词
  const nxt = prompts[0][pref.length];
  if (nxt && /\w/.test(nxt)) {
    const sp = pref.lastIndexOf(" ");
    if (sp > 0) pref = pref.slice(0, sp);
  }
  pref = pref.trim();
  const styleLine = (pref.length >= 20 && STYLE_KW.test(pref)) ? pref : "";

  // 2) 场景：取首段在风格前缀之后、首个角色定义括号/时间轴标签之前的场景搭建句。
  //    各段场景会变（如明亮营地→暗处），只拿首段全场景当基准，段内自己的场景句仍写在全局之后覆盖。
  let sceneLine = "";
  {
    const seg0 = prompts[0];
    const rest = (styleLine && seg0.startsWith(styleLine)) ? seg0.slice(styleLine.length) : seg0;
    let cut = rest.length;
    const cutRe = /[A-Za-z一-龥][\w'’\- 一-龥]{1,30}?\s*[\(（]([^()（）]{6,200})[\)）]/g;
    let cm;
    while ((cm = cutRe.exec(rest))) {
      if (LOOKS.test(cm[1])) { cut = Math.min(cut, cm.index); break; }
    }
    const tm = rest.match(/\d+(?:\.\d+)?\s*[-–~—:]\s*\d+(?:\.\d+)?\s*s|\[\s*\d|\d+(?:\.\d+)?\s*秒?\s*[|｜]/);
    if (tm) cut = Math.min(cut, tm.index);
    sceneLine = rest.slice(0, cut).replace(/^[\s,.;:，。；：]+|[\s,.;:，。；：]+$/g, "").trim();
    if (sceneLine.length < 10) sceneLine = "";
  }

  // 3) 角色定义：抓 "名称 (外貌括号)"（兼容中英文括号与中文名），取每角色最详尽版本，
  //    只保留出现在 >=2 段、且括号里含外貌词的（过滤 "(warm group)" 这类非角色括号）
  const charRe = /([A-Za-z一-龥][\w'’\- 一-龥]{1,30}?)\s*[\(（]([^()（）]{6,200})[\)）]/g;
  const chars = new Map();   // key -> {name, def, len}
  for (const p of prompts) {
    charRe.lastIndex = 0;
    let m;
    while ((m = charRe.exec(p))) {
      const name = m[1].trim();
      const def = m[2].trim();
      if (!LOOKS.test(def)) continue;
      const key = name.toLowerCase().replace(/\s+/g, " ");
      const prev = chars.get(key);
      if (!prev || def.length > prev.len) chars.set(key, { name, def, len: def.length });
    }
  }
  const charLines = [];
  for (const { name, def } of chars.values()) {
    const cnt = prompts.filter((p) => p.includes(name)).length;
    if (cnt >= 2) charLines.push(`${name} (${def})`);
  }

  // 4) 约束句：所有段都含 "No dialogue" → 纳入；统一补 "No subtitles on screen."（用户模板硬性要求）
  const allNoDialogue = prompts.every((p) => /no dialogue/i.test(p));
  const mentionsSub = prompts.some((p) => /subtitle/i.test(p));
  const constraints = [];
  if (allNoDialogue) constraints.push("No dialogue.");
  if (!mentionsSub) constraints.push("No subtitles on screen.");

  const parts = [];
  if (styleLine) parts.push(styleLine);
  if (sceneLine) parts.push("Scene: " + sceneLine);
  if (charLines.length) parts.push("Character definitions:\n- " + charLines.join("\n- "));
  if (constraints.length) parts.push(constraints.join(" "));
  return parts.join("\n\n").trim();
}

function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* 区域下方显式拖拽条：一条全宽可见横条（≡ 按住拖动），上下调高、左右调宽。
   比角标/边缘条醒目，不会被滚动条遮挡，也不依赖浏览器原生 resize。 */
function attachBottomBar(el, minW = 80, minH = 40, onResize = null, afterEl = null) {
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;justify-content:center;height:16px;flex:none;"
    + "cursor:ns-resize;background:#23282f;border:1px solid #3a3f46;border-radius:5px;"
    + "color:#8ab4f8;font-size:10px;user-select:none;letter-spacing:1px;margin-top:2px;";
  bar.textContent = "≡ 按住拖动：上下调高 · 左右调宽";
  const anchor = afterEl && afterEl.parentNode === el.parentNode ? afterEl : el;
  anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  bar.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const x0 = ev.clientX, y0 = ev.clientY;
    const w0 = el.clientWidth, h0 = el.clientHeight;
    const sc = canvasScale();
    el.style.flex = "none";  // 脱离 flex 布局约束，允许自由尺寸
    const onMove = (e2) => {
      el.style.width = Math.max(minW, w0 + (e2.clientX - x0) / sc) + "px";
      el.style.height = Math.max(minH, h0 + (e2.clientY - y0) / sc) + "px";
      if (onResize) onResize(el.clientWidth, el.clientHeight, false);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (onResize) onResize(el.clientWidth, el.clientHeight, true);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  bar.addEventListener("click", (ev) => ev.stopPropagation());
}

/* 时长吸附到 VAE 对齐档位：帧数 ≡5 (mod 17) @24fps → 39/56/73/.../362 帧，
   即 1.6/2.3/3.0/.../15.1 秒。填/拖任意值自动吸附到最近档位。
   返回值是精确秒数（帧数/24，如 14.375），后端据此算出的帧数刚好对齐不再二次取整。 */
function clampDur(v) {
  if (isNaN(v)) return 10;
  let f = Math.round(v * 24);
  f = Math.min(362, Math.max(39, f));
  const rem = (f - 5) % 17;
  const down = f - rem;
  const up = down + 17;
  let snap = (f - down < up - f) ? down : up;
  snap = Math.min(362, Math.max(39, snap));
  return snap / 24;
}

/* v2.13.8：VAE 对齐档位帧表（39~362，≡5 mod 17）+ 就近取档。
   供「手动调时长」的上下限夹取（clampManual）与时间轴点选器共用，与解析用的 clampDur 解耦。 */
const TIER_FRAMES = [];
for (let _f = 39; _f <= 362; _f += 17) TIER_FRAMES.push(_f);
function nearestTierFrame(f) {
  let best = TIER_FRAMES[0];
  for (const tf of TIER_FRAMES) if (Math.abs(tf - f) < Math.abs(best - f)) best = tf;
  return best;
}

function fmtSec(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/* ---- 台词时长估算（参考 WhatDreamsCost 的 Speech Length Calculator，适配中文）----
   提取引号内台词；CJK 字符按 1 字计，拉丁词按 2.5 字折算。
   三档语速（字/秒）：慢 3.5 / 标准 4.5 / 快 5.5——中文配音常见区间。 */
function speechUnits(text) {
  const re = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’/g;
  let m, all = "";
  while ((m = re.exec(text)) !== null) all += (m[1] || m[2] || m[3] || m[4] || "") + " ";
  if (!all.trim()) return 0;
  const cjk = (all.match(/[一-鿿　-〿＀-￦]/g) || []).length;
  const latin = (all.replace(/[一-鿿　-〿＀-￦]/g, " ").match(/[A-Za-z0-9]+/g) || []).length;
  return Math.round(cjk + latin * 2.5);
}
const SPEECH_RATES = [["慢", 3.5], ["标准", 4.5], ["快", 5.5]];

/* AI 提示词的系统提示（v1.13 强化）：教 LLM 按"导演台约定"写段提示词——
   时间轴 [0s-xs]、<Picture N>、音色槽 <Audio N>+(Sx) 绑定、尾帧衔接、Final frame。
   附完整 few-shot 示例（小模型跟示例走比跟规则走靠谱——v1.11 实测整段中文叙述/标签滥用教训）。 */
function buildAiSys(ctx) {
  return "你是 H3 长序列分镜融合台的段提示词撰写助手。用户给你一句创意或一份草稿，你输出一段可直接使用的【单段视频提示词】。\n"
    + "硬性规则：\n"
    + "1. 只输出提示词正文：不要解释、前言、标题、markdown 代码块。\n"
    + "2. 全文用英文撰写；只有引号内的台词用中文。禁止整段中文叙述。\n"
    + "3. 时间轴分镜用 [0s-xs] 标签，每个标签独占一行，总时长必须正好 " + ctx.dur + " 秒；全片 3~5 个时间轴块为宜，每块不短于 0.8 秒，严禁切成一堆 0.3~0.5 秒的碎片（句中换气/短暂停顿不要单独成块）。\n"
    + (ctx.pics > 0
      ? "4. 参考图共 " + ctx.pics + " 张（" + ctx.picDesc + "）：照片已在消息里提供，人物外貌/穿着/场景必须严格依据照片描述，禁止凭空编造与照片不符的人物或场景；只在句子里用 <Picture N> 标签引用（如 the young man from <Picture 1>），禁止写 <Picture 1>=... 这种定义句。\n"
      : "4. 本段没有参考图，完全按文字创作；不要输出任何 <Picture N> 标签。\n")
    + "5. " + (ctx.tail
        ? "本段从上一段尾帧续接：开头先写一句 Continuing seamlessly from the final frame of the previous clip，动作从半途继续，人物/场景/光线保持一致。"
        : "本段是第一段，直接开场景，不要写续接。") + "\n"
    + "6. 最后一行必须是 Final frame: ...（动作停在半途中，方便下一段无缝续接）。\n"
    + "7. " + ctx.voices + "\n"
    + "8. 多角色对话用 (S1)/(S2) 区分说话人；环境音写具体拟声（如 wind chime rings, ding, ding），不要写 ambient sound 这种抽象词。\n"
    + "9. 镜头以 medium shot / medium close-up 为主，不要拉全景；不要出现字幕、文字水印。\n"
    + (ctx.hasAudio
      ? "10. 【对口型专项】本段有配音音频：\n"
        + "  a. 禁止自己编台词（引号内不要写任何具体台词）——台词以音频内容为准，写了会带偏模型。\n"
        + "  b. 用户消息里有配音节奏分析（说话段/停顿段）：说话段写 Speaker (S1) speaks exactly following <Audio 1>, his mouth fully visible and his lips moving clearly in perfect sync with <Audio 1>；停顿段只写反应镜头（倾听/点头/微笑/花瓣），禁止在停顿段写 speaks/says。\n"
        + "  c. 时间轴切分必须贴着节奏分析的段落边界，不要糊成一整段说话。\n"
      : "")
    + "【格式示例】（创意：老人在庭院乘凉，5.2 秒，2 张参考图，无音色槽）：\n"
    + "[0s-1.5s] In the ancient quiet courtyard from <Picture 2>, medium shot. The elderly man from <Picture 1> (white hair in a neat bun, kind wrinkled face, loose grey linen robe) sits on a stone bench, a gentle breeze stirring the old trees, speckled sunlight on his robe.\n"
    + "[1.5s-3.6s] The elderly man slowly fans himself with a palm-leaf fan, then looks up into the distance with deep serene eyes, a faint smile forming. He says softly in a calm deep elderly voice: \"风起了，花也就开了。\"\n"
    + "[3.6s-5.2s] He closes his eyes contentedly, the fan resting on his knee, petals drifting past. Final frame: he is leaning back on the bench, eyes half closed, the fan slipping slightly from his hand."
    + (ctx.hasAudio
      ? "\n【对口型示例】（7.3 秒，2 张参考图，配音说话段 1.2~3.5s 与 4.0~6.3s）：\n"
        + "[0s-1.2s] In the blossom courtyard from <Picture 2>, medium close-up. The young man from <Picture 1> (dark topknot with a green leaf pin, warm brown eyes, cream hanfu with brown waist sash) stands under the cherry tree, hands gently clasped, taking a calm breath. <Audio 1> is the dialogue of speaker (S1), the young man from <Picture 1>.\n"
        + "[1.2s-3.5s] Speaker (S1) speaks exactly following <Audio 1>, his mouth fully visible and his lips moving clearly in perfect sync with <Audio 1>, gaze steady and warm.\n"
        + "[3.5s-4.0s] A brief pause: no one speaks. Speaker (S1) smiles softly, a petal landing on his sleeve.\n"
        + "[4.0s-6.3s] Speaker (S1) continues speaking exactly following <Audio 1>, his lips moving clearly in perfect sync with <Audio 1>, one hand making small gentle gestures.\n"
        + "[6.3s-7.3s] Speaker (S1) lowers his hand slowly, eyes lingering on the falling petals. Final frame: he is mid-smile, hand still near his chest, one foot slightly lifted as if about to step forward."
      : "");
}

/* 视频界面的 AI 系统提示词（v2.9）：四段式视频参考提示词，先看视频关键帧+照片再写 */
function buildVideoAiSys(ctx) {
  return "你是 H3 长序列分镜融合台「视频参考」模式的提示词撰写助手。用户会给你：参考视频的关键帧（以图片形式，按时间顺序）、参考照片、一句创意或草稿。你输出一段可直接使用的【视频参考提示词】。\n"
    + "硬性规则：\n"
    + "1. 只输出提示词正文：不要解释、前言、标题、markdown 代码块。\n"
    + "2. 用中文撰写；<Video 1>、<Picture N> 标签保留原样。\n"
    + "3. 严格使用四段式结构（参考机智罗教程实测有效的写法）：\n"
    + "【素材关系分配】声明全局动作/运镜/节奏 1:1 复刻 <Video 1>、节奏卡点参考 <Video 1> 的音轨；然后逐个写明人物强制替换映射：原视频中的<角色描述> 替换为 <Picture N>（外貌穿着照参考照片），结尾加“100% 替换每一个，不允许保留原人物特征”。\n"
    + "【画面美学与质感】风格/光线/材质/氛围（参考照片是写实就写照片级写实，是动画就写对应渲染风格）。\n"
    + "【详细时间线调度】按“X 至 Y 秒”分段，总时长必须正好 " + ctx.dur + " 秒，3~4 段为宜；每段必须先写出从关键帧里看到的具体动作（谁、在做什么、往哪动，如“转身走向车旁”“抬手挥舞”），再回挂“姿态完全复刻 <Video 1>”这类锚定句；只写锚定句不描述动作=不合格。最后一段结尾写“与 <Video 1> 的终局画面一致”。禁止编造关键帧里没有的动作。\n"
    + "【限制】全程一镜到底，禁止切镜头/画面闪烁/转场，禁止任何文字、字幕与 UI 元素。\n"
    + "4. 参考照片共 " + ctx.pics + " 张：人物外貌/穿着/场景必须严格依据照片描述，禁止凭空编造；只在句子里用 <Picture N> 引用。\n"
    + "5. 时间线分段时间点要贴着参考视频关键帧展示的动作变化来切。\n"
    + "6. 四个【】小标题必须原样出现在输出里，每段独占一块——这是硬性格式，不许写成流水段落。\n"
    + "【格式范例】（仅为格式示范，内容必须换成本次视频关键帧和照片里的真实内容）：\n"
    + "【素材关系分配】\n全局的镜头运动轨迹、人物动作与节奏，请完全 1:1 复制参考视频 <Video 1>；视频的背景音乐与节奏卡点参考 <Video 1> 的音轨。\n人物角色强制替换：将 <Video 1> 中的<角色A> 100% 替换为 <Picture 1>（<外貌穿着>），不允许保留原人物的任何外貌特征。\n"
    + "【画面美学与质感】\n<风格/光线/场景氛围/材质>。\n"
    + "【详细时间线调度】\n0 至 2.5 秒：<景别>，<角色> <具体动作，照关键帧写>，姿态完全复刻 <Video 1> 开头人物的动作。\n2.5 至 5 秒：<镜头运动>，<角色> <具体动作>，与 <Video 1> 的中段一致。\n5 至 <末秒> 秒：<镜头收尾>，构图与 <Video 1> 的终局画面一致。\n"
    + "【限制】\n全程一镜到底，绝对禁止切镜头、画面闪烁或任何形式的转场，画面禁止出现任何文字、字幕与 UI 元素。\n";
}

/* 音频经裁剪后的有效时长（与后端 ffmpeg 逻辑一致：keep=选中区，cut=去掉选中区） */
function usableAudioLen(s, dur) {
  let t0 = Math.min(Math.max(0, s.audio_trim_start || 0), dur);
  let t1 = (s.audio_trim_end > 0 && s.audio_trim_end <= dur) ? s.audio_trim_end : dur;
  if (t1 - t0 < 0.1) { t0 = 0; t1 = dur; }
  return s.audio_trim_mode === "cut" ? dur - (t1 - t0) : t1 - t0;
}

function buildStudio(node) {
  if (typeof node.__h3Cleanup === "function") node.__h3Cleanup();
  const jsonWidget = node.widgets.find((w) => w.name === "segments_json");
  const vJsonWidget = node.widgets.find((w) => w.name === "vsegments_json");
  const tJsonWidget = node.widgets.find((w) => w.name === "tsegments_json");
  const modeWidget = node.widgets.find((w) => w.name === "ui_mode");
  const globalPromptWidget = node.widgets.find((w) => w.name === "global_prompt");
  const stepsWidget = node.widgets.find((w) => w.name === "steps");
  const summaryWidget = node.widgets.find((w) => w.name === "汇总输出");
  const tailModeWidget = node.widgets.find((w) => w.name === "续接方式");
  const unloadWidget = node.widgets.find((w) => w.name === "每段后卸载模型");
  const contextSaveWidget = node.widgets.find((w) => w.name === "上下文保存目录");
  const contextLoadWidget = node.widgets.find((w) => w.name === "上下文加载目录");
  const motionFrameWidget = node.widgets.find((w) => w.name === "MotionContext画面帧数");
  const motionAudioWidget = node.widgets.find((w) => w.name === "MotionContext音频帧数");
  const outputDirWidget = node.widgets.find((w) => w.name === "output_dir");
  const filenamePrefixWidget = node.widgets.find((w) => w.name === "filename_prefix");
  const externalTextTargetWidget = node.widgets.find((w) => w.name === "外部文本目标段");
  const projectWidget = node.widgets.find((w) => w.name === "project_id");
  const textSharedRefsWidget = node.widgets.find((w) => w.name === "text_shared_refs_json");
  if (!jsonWidget) {
    const warn = mk("div", "h3s", "segments_json widget 未找到，导演台初始化失败");
    return warn;
  }
  jsonWidget.hidden = true;
  jsonWidget.computeSize = () => [0, -4];
  if (vJsonWidget) { vJsonWidget.hidden = true; vJsonWidget.computeSize = () => [0, -4]; }
  if (tJsonWidget) { tJsonWidget.hidden = true; tJsonWidget.computeSize = () => [0, -4]; }
  if (modeWidget) { modeWidget.hidden = true; modeWidget.computeSize = () => [0, -4]; }
  if (globalPromptWidget) { globalPromptWidget.hidden = true; globalPromptWidget.computeSize = () => [0, -4]; }
  if (tailModeWidget) { tailModeWidget.hidden = true; tailModeWidget.computeSize = () => [0, -4]; }
  if (unloadWidget) { unloadWidget.hidden = true; unloadWidget.computeSize = () => [0, -4]; }
  if (projectWidget) { projectWidget.hidden = true; projectWidget.computeSize = () => [0, -4]; }
  if (textSharedRefsWidget) { textSharedRefsWidget.hidden = true; textSharedRefsWidget.computeSize = () => [0, -4]; }
  if (externalTextTargetWidget) { externalTextTargetWidget.hidden = true; externalTextTargetWidget.computeSize = () => [0, -4]; }

  const summaryChoices = ["仅预览帧(推荐)", "单段视频输出", "完整帧和音频(高内存)"];
  const normalizeSummaryWidget = () => {
    if (!summaryWidget) return;
    if (!summaryChoices.includes(summaryWidget.value)) summaryWidget.value = summaryChoices[0];
    // 后端保留一个空字符串兼容项，让旧 prompt 能先通过校验；界面只显示正式选项。
    if (summaryWidget.options && Array.isArray(summaryWidget.options.values)) {
      summaryWidget.options.values = summaryChoices.slice();
    }
  };
  const normalizeMotionContextWidgets = () => {
    // 兼容升级前已经存在的导演台节点：新增 widget 在旧工作流中可能被保存为空。
    // 保存字段是“目录”，后端会自动追加 /clip，因此 h3_context 对应原生
    // Save Latent 的默认前缀 h3_context/clip；加载目录与原生节点同为 h3_context。
    if (contextSaveWidget && !String(contextSaveWidget.value ?? "").trim()) {
      contextSaveWidget.value = "h3_context";
    }
    if (contextLoadWidget && !String(contextLoadWidget.value ?? "").trim()) {
      contextLoadWidget.value = "h3_context";
    }
    if (motionFrameWidget && !["22", "5", "39", "56"].includes(String(motionFrameWidget.value))) {
      motionFrameWidget.value = "22";
    }
    if (motionAudioWidget) {
      const raw = String(motionAudioWidget.value ?? "").trim();
      const parsed = Number(raw);
      if (!raw || !Number.isFinite(parsed) || parsed < 0 || parsed > 240) {
        motionAudioWidget.value = 24;
      }
    }
  };
  const normalizeExportWidgets = () => {
    // 默认使用 ComfyUI/output；同时迁移 2.20.x 曾误写入的项目专用默认值。
    const oldDir = "E:\\短剧项目\\骗子\\片段\\第二场";
    if (outputDirWidget && (!String(outputDirWidget.value ?? "").trim()
        || String(outputDirWidget.value).trim() === oldDir)) {
      outputDirWidget.value = "output";
    }
    if (filenamePrefixWidget && (!String(filenamePrefixWidget.value ?? "").trim()
        || String(filenamePrefixWidget.value).trim() === "骗子_736")) {
      filenamePrefixWidget.value = "ComfyUI";
    }
  };
  const syncAutomaticModelMode = () => {
    const flInput = (node.inputs || []).find((input) => input.name === "fl2va_model");
    if (tailModeWidget) {
      tailModeWidget.value = flInput && flInput.link != null
        ? "硬首帧FL2VA(不跳帧)"
        : "软参考Ref2VA(保人物)";
    }
  };
  normalizeSummaryWidget();
  normalizeMotionContextWidgets();
  normalizeExportWidgets();
  syncAutomaticModelMode();

  if (!node.properties) node.properties = {};
  const ensureProjectId = () => {
    let id = String(node.properties.h3_project_id || (projectWidget && projectWidget.value) || "").trim();
    if (!id) id = newProjectId();
    id = id.replace(/[^0-9A-Za-z_-]+/g, "_").slice(0, 80).replace(/^_+|_+$/g, "") || newProjectId();
    const previous = node.__h3ClaimedProjectId;
    if (previous && previous !== id && activeProjectIds.get(previous) === node) activeProjectIds.delete(previous);
    while (activeProjectIds.has(id) && activeProjectIds.get(id) !== node) id = newProjectId();
    activeProjectIds.set(id, node);
    node.__h3ClaimedProjectId = id;
    node.properties.h3_project_id = id;
    if (projectWidget) projectWidget.value = id;
    return id;
  };
  const loadSharedRefsWidget = () => {
    let parsed = null;
    if (textSharedRefsWidget) {
      try {
        const value = JSON.parse(textSharedRefsWidget.value || "[]");
        if (Array.isArray(value)) parsed = value.filter((x) => typeof x === "string" && x);
      } catch (e) { /* 损坏数据由后端运行时给出明确提示 */ }
    }
    if (!Array.isArray(node.properties.h3_text_refs)) node.properties.h3_text_refs = parsed || [];
    else if (parsed && parsed.length && node.properties.h3_text_refs.length === 0) node.properties.h3_text_refs = parsed;
  };
  ensureProjectId();
  loadSharedRefsWidget();

  /* 三界面数据完全独立（v2.3 视频 / v2.11 文本）：创作读 segments_json，
     视频读 vsegments_json，文本读 tsegments_json；segs 指向当前活动数据集，
     切页签=换数据集。ui_mode widget 同步给后端，后端按它选数据集、
     并用独立输出文件名（漫剧v_/漫剧t_），三页产出互不覆盖。 */
  let createSegs = defaultSegs();
  let videoSegs = defaultSegs().slice(0, 1);  // 视频界面=单视频工作区（v2.5.6）
  let textSegs = defaultTextSegs();           // 文本界面=纯提示词工作区（v2.11）
  let segs = createSegs;
  const curMode = () => node.properties.h3_mode || "create";
  const nodeDefaultDimensions = () => {
    const ww = node.widgets.find((w) => w.name === "width");
    const hw = node.widgets.find((w) => w.name === "height");
    return [Math.max(32, Number(ww && ww.value) || 832), Math.max(32, Number(hw && hw.value) || 480)];
  };
  const closestAspect = (width, height) => {
    const target = Math.max(0.0001, Number(width) / Math.max(1, Number(height)));
    let best = H3S_DEFAULT_ASPECT;
    let bestError = Infinity;
    for (const [name, ratio] of Object.entries(H3S_ASPECT_RATIOS)) {
      const error = Math.abs(Math.log(target / (ratio[0] / ratio[1])));
      if (error < bestError) { best = name; bestError = error; }
    }
    return best;
  };
  const normalizeSegmentResolution = (seg) => {
    if (!seg || typeof seg !== "object") return [832, 480];
    const defaults = nodeDefaultDimensions();
    const existingWidth = Number(seg.width) > 0 ? Number(seg.width) : defaults[0];
    const existingHeight = Number(seg.height) > 0 ? Number(seg.height) : defaults[1];
    if (!H3S_ASPECT_RATIOS[seg.aspect_ratio]) {
      seg.aspect_ratio = closestAspect(existingWidth, existingHeight);
    }
    const mp = Number(seg.megapixels);
    seg.megapixels = Math.round((Number.isFinite(mp) && mp >= 0.1
      ? Math.min(16, mp)
      : Math.min(16, Math.max(0.1, existingWidth * existingHeight / (1024 * 1024)))) * 10) / 10;
    const multiple = Number(seg.multiple);
    seg.multiple = Math.min(128, Math.max(8,
      Math.round(Number.isFinite(multiple) ? multiple : H3S_DEFAULT_MULTIPLE)));
    const dims = calculateSegmentResolution(seg.aspect_ratio, seg.megapixels, seg.multiple);
    seg.width = dims[0];
    seg.height = dims[1];
    return dims;
  };
  const segmentContinuityBlocked = (items, idx) => {
    if (!Array.isArray(items) || idx <= 0 || !items[idx] || !items[idx - 1]) return false;
    const previous = normalizeSegmentResolution(items[idx - 1]);
    const current = normalizeSegmentResolution(items[idx]);
    return items[idx - 1].aspect_ratio !== items[idx].aspect_ratio
      || previous[0] !== current[0] || previous[1] !== current[1];
  };
  const normalizeResolutionContinuity = (items) => {
    if (!Array.isArray(items)) return;
    items.forEach((seg) => normalizeSegmentResolution(seg));
    items.forEach((seg, idx) => {
      if (!segmentContinuityBlocked(items, idx)) return;
      if (seg.motion_context === true) {
        syncSegmentToPrevious(items, idx);
        seg.use_tail = false;
      } else {
        seg.use_tail = false;
        seg.motion_context = false;
      }
    });
  };
  const syncSegmentToPrevious = (items, idx) => {
    if (!Array.isArray(items) || idx <= 0 || !items[idx] || !items[idx - 1]) return null;
    const previous = items[idx - 1];
    const current = items[idx];
    normalizeSegmentResolution(previous);
    for (const key of ["aspect_ratio", "megapixels", "multiple", "width", "height"]) {
      current[key] = previous[key];
    }
    const previousFps = Number(previous.fps);
    current.fps = Number.isFinite(previousFps)
      ? Math.min(24, Math.max(8, Math.round(previousFps))) : 24;
    return [current.width, current.height, current.fps];
  };
  const normalizeContinuityModes = (items) => {
    if (!Array.isArray(items)) return;
    items.forEach((seg, idx) => {
      if (seg.motion_context === true) {
        if (!["local_latent", "upload_latent", "aliyun_oss", "video"].includes(seg.motion_context_source)) {
          seg.motion_context_source = "local_latent";
        }
        if (seg.motion_context_source === "local_latent") {
          const index = Number(seg.motion_context_index);
          seg.motion_context_index = Number.isFinite(index) && index >= 0
            ? Math.min(9998, Math.floor(index)) : idx;
        }
        seg.motion_context = true;
        seg.use_tail = false;
      } else {
        seg.motion_context = false;
        seg.use_tail = seg.use_tail === true;
      }
    });
  };
  const appendLocalMotionIndex = (row, seg, segmentIndex) => {
    if (seg.motion_context !== true) return;
    if (!["local_latent", "upload_latent", "aliyun_oss", "video"].includes(seg.motion_context_source)) {
      seg.motion_context_source = "local_latent";
    }
    if (seg.motion_context_source !== "local_latent") return;
    const label = mk("span", "h3s-hint", "Clip_index");
    const input = mk("input", "h3s-durinput");
    input.type = "number";
    input.min = "0";
    input.max = "9998";
    input.step = "1";
    const current = Number(seg.motion_context_index);
    input.value = String(Number.isFinite(current) && current >= 0 ? Math.floor(current) : segmentIndex);
    input.title = "读取 clip 的编号。0=不读取旧 latent；本段生成后保存为 clip_(Index+1)。";
    input.addEventListener("change", () => {
      const parsed = Math.floor(Number(input.value));
      seg.motion_context_index = Number.isFinite(parsed)
        ? Math.min(9998, Math.max(0, parsed)) : segmentIndex;
      input.value = String(seg.motion_context_index);
      save();
    });
    row.append(label, input, mk("span", "h3s-hint", "0=不加载；本段保存 clip " + (Number(input.value) + 1)));
  };
  const _modeQ = () => new URLSearchParams({ mode: curMode(), project_id: ensureProjectId() }).toString();
  const migrateTextRefs = () => {
    if (!Array.isArray(node.properties.h3_text_refs)) node.properties.h3_text_refs = [];
    const refLists = textSegs.map((seg) => Array.isArray(seg.refs) ? seg.refs.slice() : []);
    let shared = node.properties.h3_text_refs.slice();

    // 旧工作流只在每段 refs 里保存共享图：抽取所有段共同的前缀。
    if (!shared.length && refLists.length && refLists.every((refs) => refs.length)) {
      shared = refLists[0].slice();
      for (const refs of refLists.slice(1)) {
        let n = 0;
        while (n < shared.length && n < refs.length && shared[n] === refs[n]) n++;
        shared.length = n;
        if (!shared.length) break;
      }
      if (shared.length) node.properties.h3_text_refs = shared.slice();
    }

    // v2.13 及更早版本会在每次保存时再次把共享图拼到每段前面；循环剥离所有重复前缀。
    if (shared.length) {
      for (const seg of textSegs) {
        let refs = Array.isArray(seg.refs) ? seg.refs.slice() : [];
        const hasPrefix = () => shared.every((name, i) => refs[i] === name);
        while (refs.length >= shared.length && hasPrefix()) refs = refs.slice(shared.length);
        seg.refs = refs;
      }
    }
  };
  let syncLowVramButton = () => {};
  const save = () => {
    normalizeSummaryWidget();
    normalizeMotionContextWidgets();
    normalizeExportWidgets();
    syncAutomaticModelMode();
    ensureProjectId();
    normalizeContinuityModes(createSegs);
    normalizeContinuityModes(videoSegs);
    normalizeContinuityModes(textSegs);
    normalizeResolutionContinuity(createSegs);
    normalizeResolutionContinuity(videoSegs);
    normalizeResolutionContinuity(textSegs);
    jsonWidget.value = JSON.stringify(createSegs);
    if (vJsonWidget) vJsonWidget.value = JSON.stringify(videoSegs);
    if (tJsonWidget) tJsonWidget.value = JSON.stringify(textSegs);
    if (textSharedRefsWidget) textSharedRefsWidget.value = JSON.stringify(node.properties.h3_text_refs || []);
    if (modeWidget) modeWidget.value = curMode();
    syncLowVramButton();
  };
  const appendResolutionControls = (row, seg) => {
    normalizeSegmentResolution(seg);
    const group = mk("span", null);
    group.style.cssText = "display:inline-flex;align-items:center;gap:5px;flex-wrap:nowrap;white-space:nowrap;";
    group.appendChild(mk("span", "h3s-hint", "宽高比"));
    const aspect = document.createElement("select");
    aspect.className = "h3s-seedmode";
    aspect.style.width = "164px";
    for (const name of Object.keys(H3S_ASPECT_RATIOS)) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      aspect.appendChild(option);
    }
    aspect.value = seg.aspect_ratio;
    aspect.title = "本段独立宽高比；算法与 ComfyUI 的“分辨率 和像素”节点一致";

    group.appendChild(aspect);
    group.appendChild(mk("span", "h3s-hint", "百万像素"));
    const megapixels = mk("input", "h3s-durinput");
    megapixels.type = "number";
    megapixels.min = "0.1";
    megapixels.max = "16";
    megapixels.step = "0.1";
    megapixels.style.width = "62px";
    megapixels.value = Number(seg.megapixels).toFixed(1);
    megapixels.addEventListener("input", () => {
      const raw = String(megapixels.value || "");
      const dot = raw.indexOf(".");
      if (dot >= 0 && raw.length > dot + 2) megapixels.value = raw.slice(0, dot + 2);
    });

    group.appendChild(megapixels);
    group.appendChild(mk("span", "h3s-hint", "倍数"));
    const multiple = mk("input", "h3s-durinput");
    multiple.type = "number";
    multiple.min = "8";
    multiple.max = "128";
    multiple.step = "4";
    multiple.style.width = "52px";
    multiple.value = String(seg.multiple);
    const dimensions = mk("span", "h3s-hint", `${seg.width}×${seg.height}`);
    dimensions.style.color = "#9fd0ff";
    group.append(multiple, dimensions);

    const commit = () => {
      seg.aspect_ratio = aspect.value;
      seg.megapixels = Math.round(Math.min(16, Math.max(0.1,
        Number(megapixels.value) || H3S_DEFAULT_MEGAPIXELS)) * 10) / 10;
      seg.multiple = Math.min(128, Math.max(8,
        Math.round(Number(multiple.value) || H3S_DEFAULT_MULTIPLE)));
      const dims = normalizeSegmentResolution(seg);
      const hadBlockedContinuity = segs.some((item, idx) => idx > 0
        && segmentContinuityBlocked(segs, idx) && (item.use_tail === true || item.motion_context === true));
      normalizeResolutionContinuity(segs);
      save();
      status.textContent = `段${sel + 1} 分辨率：${dims[0]}×${dims[1]}`
        + (hadBlockedContinuity ? "；尺寸不同的段已关闭尾帧续接和 MotionContext" : "");
      renderTimeline();
      renderEditor();
    };
    aspect.addEventListener("change", commit);
    megapixels.addEventListener("change", commit);
    multiple.addEventListener("change", commit);
    row.appendChild(group);
  };
  const reloadFromWidget = () => {
    normalizeSummaryWidget();
    syncAutomaticModelMode();
    try {
      const parsed = JSON.parse(jsonWidget.value || "[]");
      if (Array.isArray(parsed) && parsed.length) createSegs = parsed;
    } catch (e) { /* 保持默认 */ }
    if (vJsonWidget) {
      try {
        const vparsed = JSON.parse(vJsonWidget.value || "[]");
        if (Array.isArray(vparsed) && vparsed.length) videoSegs = vparsed;
      } catch (e) { /* 保持默认 */ }
    }
    if (tJsonWidget) {
      try {
        const tparsed = JSON.parse(tJsonWidget.value || "[]");
        if (Array.isArray(tparsed) && tparsed.length) {
          textSegs = tparsed;
          loadSharedRefsWidget();
          migrateTextRefs();
        }
      } catch (e) { /* 保持默认 */ }
    }
    segs = curMode() === "video" ? videoSegs : curMode() === "text" ? textSegs : createSegs;
    if (sel >= segs.length) sel = segs.length - 1;
    save();
    renderTimeline();
    renderEditor();
  };
  try {
    const parsed = JSON.parse(jsonWidget.value || "[]");
    if (Array.isArray(parsed) && parsed.length) createSegs = parsed;
  } catch (e) { /* 保持默认 */ }
  if (vJsonWidget) {
    try {
      const vparsed = JSON.parse(vJsonWidget.value || "[]");
      if (Array.isArray(vparsed) && vparsed.length) videoSegs = vparsed;
    } catch (e) { /* 保持默认 */ }
  }
  if (tJsonWidget) {
    try {
      const tparsed = JSON.parse(tJsonWidget.value || "[]");
      if (Array.isArray(tparsed) && tparsed.length) {
        textSegs = tparsed;
        migrateTextRefs();
      }
    } catch (e) { /* 保持默认 */ }
  }
  save();

  let sel = 0;
  // 仅由时间轴段卡片点击设置。它让 video.play() 保持在用户点击的调用链中，
  // 这样浏览器可以连同音频一起自动播放，而不是被自动播放策略拦截。
  let autoPlaySegment = null;
  /* v2.13.15：鼠标框选选中的段集合（拖框高亮，配合「删选中」按钮批量删除） */
  const boxSel = new Set();
  const clearBoxSel = () => { boxSel.clear(); };
  let busy = false;
  let durInput = null;
  let picHintEl = null;
  let voicePreviewPlayer = null;
  let voicePreviewButton = null;
  let voicePreviewName = null;
  const stopVoicePreview = () => {
    if (voicePreviewPlayer) {
      try { voicePreviewPlayer.pause(); voicePreviewPlayer.currentTime = 0; } catch (e) { /* ignore */ }
    }
    if (voicePreviewButton) voicePreviewButton.textContent = "▶ 播放";
    voicePreviewPlayer = null;
    voicePreviewButton = null;
    voicePreviewName = null;
  };
  const editorObservers = new Set();
  const disconnectEditorObservers = () => {
    for (const observer of editorObservers) observer.disconnect();
    editorObservers.clear();
  };
  const observeEditorSize = (element, callback) => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(callback);
    observer.observe(element);
    editorObservers.add(observer);
  };

  const segDur = (s) => clampDur(Number(s.duration ?? 10));

  /* v2.13.8：手动调时长的上下限（文本界面可改，默认 8~15s）。解析/显示仍用 clampDur（1.6~15.1），
     只有"手动调"（时间轴点选/±/输入/拖拽/每段时长覆盖）走 clampManual——
     这样解析出的短段（如 3s）保持原样，不会被强行抬到 8s；但你手动去调时只能落在 8~15s。 */
  const manualBounds = () => {
    let lo = parseFloat(node.properties.h3_dur_min), hi = parseFloat(node.properties.h3_dur_max);
    if (isNaN(lo)) lo = 8;
    if (isNaN(hi)) hi = 15;
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    let loF = nearestTierFrame(Math.round(lo * 24));
    let hiF = nearestTierFrame(Math.round(hi * 24));
    if (hiF < loF) { const t = loF; loF = hiF; hiF = t; }
    return [loF, hiF];
  };
  const clampManual = (v) => {
    if (isNaN(v)) v = 8;
    const bd = manualBounds();
    const f = nearestTierFrame(Math.round(v * 24));
    return Math.min(bd[1], Math.max(bd[0], f)) / 24;
  };

  /* 音频上传共用逻辑（「+音频」按钮 / 拖放到 AUDIO 轨道块 都走这里）。
     目标段还没选音频来源时自动切到「自定义替换」。 */
  async function uploadAudioToSeg(file, idx) {
    const fd = new FormData();
    fd.append("audio", file, file.name);
    const resp = await api.fetchApi("/h3director/upload_audio", { method: "POST", body: fd });
    const r = await resp.json();
    if (!(r.ok && r.name)) throw new Error(r.error || ("HTTP " + resp.status));
    const seg = segs[idx];
    seg.audio = r.name;
    seg.audio_label = r.label || r.name;  // 原始文件名（界面显示用）
    if (!seg.audio_src || seg.audio_src === "model") { seg.audio_src = "replace"; seg.audio_mode = "replace"; }
    save();
  }

  const box = mk("div", "h3s");
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  box.appendChild(style);

  /* 整面板缩放条（固定在面板顶部，永远可见）：拖着它放大/缩小整个导演台节点 */
  const nodeBar = document.createElement("div");
  nodeBar.style.cssText = "display:flex;align-items:center;justify-content:center;height:16px;flex:none;"
    + "cursor:ns-resize;background:#1c3145;border:1px solid #2f567a;border-radius:5px;"
    + "color:#9fc8ff;font-size:10px;user-select:none;letter-spacing:1px;";
  nodeBar.textContent = "≡ 按住拖动：放大 / 缩小整个导演台面板";
  box.appendChild(nodeBar);
  nodeBar.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const x0 = ev.clientX, y0 = ev.clientY;
    const w0 = node.size[0], h0 = node.size[1];
    const sc = canvasScale();
    const onMove = (e2) => {
      node.setSize([
        Math.max(760, w0 + (e2.clientX - x0) / sc),
        Math.max(500, h0 + (e2.clientY - y0) / sc),
      ]);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  nodeBar.addEventListener("click", (ev) => ev.stopPropagation());

  /* 顶栏（运行按钮已按用户要求移除：直接在 ComfyUI 队列里跑节点即可） */
  const bar = mk("div", "h3s-bar");
  /* 界面页签（v2.1 视频 / v2.11 文本）：创作=完整编辑器 / 视频=参考视频驱动 / 文本=纯提示词。
     存 node.properties（随工作流保存），不走 segments_json（后端按数组解析）。 */
  const btnTabC = mk("button", "h3s-btn", "创作界面");
  const btnTabV = mk("button", "h3s-btn", "视频界面");
  const btnTabT = mk("button", "h3s-btn", "文本界面");
  const btnFullSegmentPrompt = mk("button", "h3s-btn", "全段提示词");
  const btnAssignSegmentPrompt = mk("button", "h3s-btn", "分配提示词");
  btnTabC.title = "提示词 + 照片 + 配音/音色的创作模式";
  btnTabV.title = "参考视频驱动：上方视频（动作/运镜）+ 下方照片（外观），白模→成片、照片人物替换视频人物";
  btnTabT.title = "纯提示词生成：可上传共用参考图保持角色一致；粘贴带时间的分镜脚本一键解析成段";
  const syncTabs = () => {
    const m = node.properties.h3_mode || "create";
    btnTabC.classList.toggle("primary", m === "create");
    btnTabV.classList.toggle("primary", m === "video");
    btnTabT.classList.toggle("primary", m === "text");
    /* v2.7：视频界面恢复分段——+段/-段显示；全选/尾帧组只在创作界面用（隐藏）
       v2.11：文本界面恢复全选/尾帧组（段间可续接尾帧），与创作界面一致 */
    const disp = m === "video" ? "none" : "";
    for (const b of [btnSelAll, btnSelNone, btnTailAll, btnTailNone]) b.style.display = disp;
    btnAdd.style.display = "";
    btnDel.style.display = "";
  };
  /* 切页签 = 换数据集 + 重渲轨道和编辑区（v2.3 前只 renderEditor，轨道残留另一
     界面的样式——"创作界面却显示波形"的泄漏 bug 根因） */
  const switchMode = (m) => {
    if (m === "text" && !tJsonWidget) {
      status.textContent = "文本界面需要新版后端：请完全重启 ComfyUI 再 Ctrl+F5";
      status.style.color = "#ff8080";
      return;
    }
    node.properties.h3_mode = m;
    if (!node.properties.h3_prompt_tabs_visited || typeof node.properties.h3_prompt_tabs_visited !== "object") {
      node.properties.h3_prompt_tabs_visited = {};
    }
    // 只有实际点过三个页签，才允许把全段文本批量覆盖到三套独立分段中。
    node.properties.h3_prompt_tabs_visited[m] = true;
    segs = m === "video" ? videoSegs : m === "text" ? textSegs : createSegs;
    sel = 0;
    clearBoxSel();
    syncTabs();
    syncPromptAssignmentControls();
    save();
    renderTimeline();
    renderEditor();
  };
  btnTabC.addEventListener("click", () => switchMode("create"));
  btnTabV.addEventListener("click", () => switchMode("video"));
  btnTabT.addEventListener("click", () => switchMode("text"));
  const btnAdd = mk("button", "h3s-btn", "+段");
  const btnDel = mk("button", "h3s-btn", "-段");
  /* 一键勾选/取消全部段的"启用"——批量跑/批量停时不用逐段点 */
  const btnSelAll = mk("button", "h3s-btn", "全选");
  btnSelAll.title = "勾选全部段（全部启用）";
  const btnSelNone = mk("button", "h3s-btn", "全不选");
  btnSelNone.title = "取消全部段的勾选（全部停用）";
  /* 全局续接方式：尾帧与 MotionContext 严格二选一。 */
  const btnTailAll = mk("button", "h3s-btn", "尾帧全勾");
  btnTailAll.title = "段2以后全部选择尾帧续接，并关闭 MotionContext";
  const btnTailNone = mk("button", "h3s-btn", "Motion全勾");
  btnTailNone.title = "段2以后全部选择 MotionContext，并关闭尾帧续接";
  const totalLab = mk("span", "h3s-total", "");
  const status = mk("span", "h3s-status", "就绪");
  const bulkPromptGroups = () => {
    const source = String(node.properties.h3_full_segment_prompt || "").trim();
    if (!source) return [];
    const separator = String(node.properties.h3_full_segment_separator ?? "===").trim();
    return (separator ? source.split(separator) : [source])
      .map((part) => part.trim())
      .filter(Boolean);
  };
  const allPromptTabsVisited = () => {
    const visited = node.properties.h3_prompt_tabs_visited || {};
    return ["create", "video", "text"].every((mode) => visited[mode] === true);
  };
  function syncPromptAssignmentControls() {
    const groups = bulkPromptGroups();
    const ready = allPromptTabsVisited() && groups.length > 0;
    btnFullSegmentPrompt.classList.toggle("primary", node.properties.h3_full_segment_prompt_open === true);
    btnAssignSegmentPrompt.disabled = !ready;
    btnAssignSegmentPrompt.classList.toggle("primary", ready);
    btnAssignSegmentPrompt.title = ready
      ? `将 ${groups.length} 组提示词依次填入三个界面的现有片段`
      : !groups.length
        ? "先在“全段提示词”中填写至少一组内容"
        : "请依次点击创作界面、视频界面、文本界面后再分配";
  }
  btnFullSegmentPrompt.title = "展开 / 收起全段提示词编辑框";
  btnFullSegmentPrompt.addEventListener("click", () => {
    node.properties.h3_full_segment_prompt_open = node.properties.h3_full_segment_prompt_open !== true;
    save();
    syncPromptAssignmentControls();
    renderEditor();
  });
  btnAssignSegmentPrompt.addEventListener("click", () => {
    const groups = bulkPromptGroups();
    if (!allPromptTabsVisited() || !groups.length) {
      syncPromptAssignmentControls();
      status.textContent = !groups.length
        ? "先填写“全段提示词”内容"
        : "请依次点击创作界面、视频界面、文本界面后再分配";
      return;
    }
    const mode = curMode();
    const modeLabel = mode === "video" ? "视频界面" : mode === "text" ? "文本界面" : "创作界面";
    const count = Math.min(groups.length, segs.length);
    for (let i = 0; i < count; i++) segs[i].prompt = groups[i];
    save();
    renderTimeline();
    renderEditor();
    status.textContent = `已把 ${groups.length} 组提示词按顺序分配到当前${modeLabel}的 ${count}/${segs.length} 段（未对应片段保持原提示词）`;
  });
  /* 前端版本号常显：用户截图可直接确认 JS 是否最新，终止"缓存旧版"猜谜 */
  const verLab = mk("span", "h3s-hint", "v" + H3S_VERSION);
  /* ▶ 运行（v2.9.3）：面板内直接触发生成，等价于点 ComfyUI 的队列按钮 */
  const btnRun = mk("button", "h3s-btn primary", "▶ 运行");
  btnRun.title = "开始生成（等价于点 ComfyUI 的运行/队列按钮）";
  btnRun.addEventListener("click", () => {
    try {
      app.queuePrompt(0, 1);
      status.textContent = "已加入队列，开始生成…";
    } catch (e) {
      const qb = document.querySelector("#queue-button, button.comfy-queue-btn");
      if (qb) qb.click();
      else status.textContent = "触发失败，请点 ComfyUI 自带的运行按钮";
    }
  });
  /* 复用旧的“每段后卸载模型”隐藏 widget，避免新增 required widget 造成旧工作流错位。 */
  const btnLowVram = mk("button", "h3s-btn", "8GB稳定");
  btnLowVram.title = "8GB 显存稳定模式：最多 20 步、强制仅预览汇总，并在每段模型工作结束后深度卸载。建议单段约 5.2 秒。";
  syncLowVramButton = () => {
    const enabled = !!(unloadWidget && unloadWidget.value);
    btnLowVram.textContent = enabled ? "☑ 8GB稳定" : "8GB稳定";
    btnLowVram.classList.toggle("primary", enabled);
  };
  btnLowVram.addEventListener("click", () => {
    if (!unloadWidget) {
      status.textContent = "8GB稳定模式需要新版后端，请完全重启 ComfyUI 再 Ctrl+F5";
      status.style.color = "#ff8080";
      return;
    }
    const enabled = !unloadWidget.value;
    unloadWidget.value = enabled;
    if (enabled) {
      if (summaryWidget) summaryWidget.value = summaryChoices[0];
      if (stepsWidget) stepsWidget.value = 20;
      status.textContent = "8GB稳定已开启：20步、仅预览；建议单段约5.2秒";
      status.style.color = "#8ee6a0";
    } else {
      status.textContent = "8GB稳定已关闭（步数和汇总输出保持当前值）";
      status.style.color = "";
    }
    save();
  });
  syncLowVramButton();
  const btnPreviewToggle = mk("button", "h3s-btn", "隐藏播放器");
  const syncPreviewToggle = () => {
    const hidden = node.properties.h3_segment_preview_hidden === true;
    btnPreviewToggle.textContent = hidden ? "显示播放器" : "隐藏播放器";
    btnPreviewToggle.classList.toggle("primary", !hidden);
    btnPreviewToggle.title = hidden
      ? "显示当前段已生成的视频播放器"
      : "隐藏当前段视频播放器（不删除任何视频文件）";
  };
  btnPreviewToggle.addEventListener("click", () => {
    node.properties.h3_segment_preview_hidden = node.properties.h3_segment_preview_hidden !== true;
    save();
    syncPreviewToggle();
    applyPreviewLayout();
    if (!previewIsHidden()) {
      node.setSize([Math.max(760, node.size[0]), Math.max(620, node.size[1])]);
    }
    renderEditor();
  });
  syncPreviewToggle();
  bar.append(btnTabC, btnTabV, btnTabT, btnFullSegmentPrompt, btnAssignSegmentPrompt,
    btnRun, btnLowVram, btnPreviewToggle, btnAdd, btnDel, btnSelAll, btnSelNone, btnTailAll, btnTailNone, totalLab, verLab, status);
  syncTabs();
  syncPromptAssignmentControls();
  box.appendChild(bar);

  /* 进度条 */
  const prog = mk("div", "h3s-prog");
  const progIn = document.createElement("div");
  prog.appendChild(progIn);
  box.appendChild(prog);

  /* 时间轴（左侧标签列对齐 MAIN / AUDIO 两行轨道，Bernini 式） */
  const tl = mk("div", "h3s-tl");
  const trackV = mk("div", "h3s-track");
  trackV.appendChild(mk("span", "atag", "MAIN"));
  trackV.appendChild(tl);
  box.appendChild(trackV);

  /* 音频轨道（与段时间轴同宽对齐，显示每段音频状态 + 开/关切换） */
  const tla = mk("div", "h3s-atl");
  const trackA = mk("div", "h3s-track");
  trackA.appendChild(mk("span", "atag", "AUDIO"));
  trackA.appendChild(tla);
  box.appendChild(trackA);
  /* 两行轨道横向滚动同步，避免段多时 MAIN/AUDIO 错位 */
  tl.addEventListener("scroll", () => { tla.scrollLeft = tl.scrollLeft; });
  tla.addEventListener("scroll", () => { tl.scrollLeft = tla.scrollLeft; });

  /* v2.13.15：鼠标在段时间轴空白处按住左键拖出矩形框，框住的段卡片高亮（配合「删选中」）。
     用 Pointer Capture：监听都挂在 tl 上，节点删除时 tl 移除、监听自动清理，无 window 泄漏。
     点在段卡片/时长标签/拖拽柄上不启动框选（保留单选、点选时长、拖时长）。 */
  let mDown = false, mMoved = false, mStart = null, marquee = null;
  /* PointerEvent 的 clientX/Y 是屏幕 CSS 像素；tl 内绝对定位使用的是节点布局坐标。
     ComfyUI 画布缩放后两者不再是 1:1，必须用元素实际屏幕尺寸 / 布局尺寸分别换算 X/Y。
     不能只使用全局 canvasScale：浏览器缩放、非等比变换和滚动条都会造成细微差异。 */
  const timelinePointerPoint = (ev) => {
    const rect = tl.getBoundingClientRect();
    const fallback = Math.max(0.0001, canvasScale());
    const rawScaleX = tl.offsetWidth > 0 ? rect.width / tl.offsetWidth : fallback;
    const rawScaleY = tl.offsetHeight > 0 ? rect.height / tl.offsetHeight : fallback;
    const scaleX = Number.isFinite(rawScaleX) && rawScaleX > 0.0001 ? rawScaleX : fallback;
    const scaleY = Number.isFinite(rawScaleY) && rawScaleY > 0.0001 ? rawScaleY : fallback;
    return {
      x: (ev.clientX - rect.left) / scaleX + tl.scrollLeft,
      y: (ev.clientY - rect.top) / scaleY + tl.scrollTop,
    };
  };
  tl.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest(".h3s-slot, .h3s-durpick")) return;
    const point = timelinePointerPoint(ev);
    mDown = true; mMoved = false;
    mStart = { x: point.x, y: point.y, screenX: ev.clientX, screenY: ev.clientY };
    try { tl.setPointerCapture(ev.pointerId); } catch (e) {}
  });
  tl.addEventListener("pointermove", (ev) => {
    if (!mDown || !mStart) return;
    if (!mMoved && Math.hypot(ev.clientX - mStart.screenX, ev.clientY - mStart.screenY) < 5) return;
    if (!mMoved) { mMoved = true; marquee = mk("div", "h3s-marquee"); tl.appendChild(marquee); }
    const point = timelinePointerPoint(ev);
    marquee.style.left = Math.min(mStart.x, point.x) + "px";
    marquee.style.top = Math.min(mStart.y, point.y) + "px";
    marquee.style.width = Math.abs(point.x - mStart.x) + "px";
    marquee.style.height = Math.abs(point.y - mStart.y) + "px";
    /* 以黄色框实际渲染到屏幕上的范围做命中判断，保证视觉框和选中结果永远一致。 */
    const selectRect = marquee.getBoundingClientRect();
    boxSel.clear();
    Array.from(tl.querySelectorAll(".h3s-slot")).forEach((el) => {
      const r = el.getBoundingClientRect();
      const hit = !(r.right < selectRect.left || r.left > selectRect.right
        || r.bottom < selectRect.top || r.top > selectRect.bottom);
      const idx = Number(el.dataset.idx);
      if (hit) { boxSel.add(idx); el.classList.add("boxsel"); }
      else el.classList.remove("boxsel");
    });
  });
  const endMarquee = (ev) => {
    if (!mDown) return;
    mDown = false;
    try { tl.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (marquee) { marquee.remove(); marquee = null; }
    if (mMoved) { renderTimeline(); }
    mMoved = false; mStart = null;
  };
  tl.addEventListener("pointerup", endMarquee);
  tl.addEventListener("pointercancel", endMarquee);

  /* 编辑区：保持 flex:1 自动填充节点剩余空间——节点（面板）放大时它跟着放大，
     不需要也不允许横条锁死它的尺寸 */
  const editor = mk("div", "h3s-editor");
  box.appendChild(editor);

  const previewIsHidden = () => !SHOW_SAVED_SEGMENT_PREVIEW || node.properties.h3_segment_preview_hidden === true;
  const applyPreviewLayout = () => {
    if (previewIsHidden()) {
      box.style.height = "auto";
      box.style.minHeight = "0";
      editor.style.flex = "none";
      editor.style.minHeight = "0";
      editor.style.overflow = "visible";
    } else {
      box.style.height = "";
      box.style.minHeight = "";
      editor.style.flex = "";
      editor.style.minHeight = "";
      editor.style.overflow = "";
    }
  };
  // 已关闭成片预览时，编辑区不再需要占满播放器原有的空间。改成内容高度，
  // 每次重绘后同步收缩/扩展整个节点，避免“播放器没了但黑色空白还在”。
  const autoFitCompactPanel = () => {
    if (!previewIsHidden()) return;
    applyPreviewLayout();
    // 添加或删除锚点卡片后，须等待布局完成再取高度；否则会量到上一帧的旧高度。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // box 已在紧凑模式下设为 height:auto；scrollHeight 才是所有真实内容
      // （含帧锚点卡片）的高度。不能用元素当前可视高度，否则会把旧节点的
      // 空白高度又带回新的计算结果。
      const contentHeight = Math.ceil(box.scrollHeight);
      // 与 DOMWidget 的 TOP_RESERVED 保持一致：标题、接口和常规 widget 区约 210px。
      const wantedHeight = Math.max(320, contentHeight + 218);
      if (Math.abs((node.size && node.size[1] || 0) - wantedHeight) > 2) {
        node.setSize([Math.max(node.size[0], 760), wantedHeight]);
      }
    }));
  };
  applyPreviewLayout();

  function hideSegmentPreview() {
    node.properties.h3_segment_preview_hidden = true;
    save();
    syncPreviewToggle();
    applyPreviewLayout();
    renderEditor();
  }

  async function queueThis() {
    const { output } = await app.graphToPrompt();
    const keep = new Set();
    const stack = [String(node.id)];
    while (stack.length) {
      const id = stack.pop();
      if (keep.has(id) || !output[id]) continue;
      keep.add(id);
      for (const v of Object.values(output[id].inputs)) {
        if (Array.isArray(v)) stack.push(String(v[0]));
      }
    }
    const sub = {};
    for (const id of keep) sub[id] = output[id];
    await api.queuePrompt(0, { output: sub });
  }

  async function waitIdle() {
    await new Promise((r) => setTimeout(r, 500));
    let fails = 0;
    for (;;) {
      try {
        const q = await api.getQueue();
        fails = 0;
        const running = (q.queue_running || q.Running || []).length;
        const pending = (q.queue_pending || q.Pending || []).length;
        if (running + pending === 0) return;
      } catch (e) {
        /* getQueue 偶发失败（网络/重启中）容忍，连续 5 次失败才放弃，防止 busy 永久锁死 */
        if (++fails >= 5) throw new Error("队列状态查询连续失败（ComfyUI 是否在运行？）");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function run(all) {
    if (busy) return;
    busy = true;
    try {
      if (!all) {
        for (let i = 0; i < segs.length; i++) segs[i].force = i === sel;
      } else {
        for (const s of segs) s.force = false;
      }
      save();
      status.style.color = "";
      status.textContent = all ? "全部运行中…" : `段${sel + 1} 运行中…`;
      await queueThis();
      await waitIdle();
      status.textContent = "完成";
    } catch (e) {
      /* 任何失败必须可见 + busy 必须复位——否则按钮静默"不管用"（曾经的锁死 bug） */
      status.style.color = "#ff8080";
      status.textContent = "出错: " + (e && e.message ? e.message : e);
      console.error("[H3导演台] 运行失败:", e);
    } finally {
      for (const s of segs) s.force = false;
      try { save(); } catch (e2) { console.error("[H3导演台] save 失败:", e2); }
      busy = false;
      renderTimeline();
    }
  }

  /* 顶栏运行按钮已移除（v1.14.4）：run/queueThis 保留供未来恢复 */
  btnAdd.addEventListener("click", () => {
    /* 视频/文本界面新建段：时长取节点「时长秒」（段级覆盖的唯一默认值来源，v2.7） */
    const _durW = node.widgets.find((w) => w.name === "时长秒");
    const _defDur = (curMode() !== "create" && _durW) ? (Number(_durW.value) || 10) : 10;
    segs.push({
      prompt: curMode() === "text" ? "" : DEFAULT_PROMPT_NEXT,  // 文本界面：空白提示词（v2.11）
      seed: Math.floor(Math.random() * 1e15),
      refs: [],
      video_refs: [],
      ...defaultResolutionFields(),
      duration: _defDur,
      inherit_shared: true,
      use_tail: false,
      motion_context: true,
      enabled: true,
      force: false,
    });
    save(); renderTimeline(); renderEditor();
  });
  // 所有单段删除均采用两次点击确认；确认状态 8 秒后失效，避免误删。
  const btnDelText = btnDel.textContent;
  let delTailArmed = false;
  let delTailTimer = null;
  const disarmDelTail = () => {
    delTailArmed = false;
    clearTimeout(delTailTimer);
    btnDel.textContent = btnDelText;
    btnDel.style.background = "";
    btnDel.style.borderColor = "";
  };
  btnDel.addEventListener("click", () => {
    if (segs.length <= 1) { status.textContent = "至少保留 1 段"; return; }
    if (!delTailArmed) {
      delTailArmed = true;
      btnDel.textContent = "再点确认删除末段";
      btnDel.style.background = "#8a2f2f";
      btnDel.style.borderColor = "#c05555";
      status.textContent = "请再次点击确认删除最后一段（8 秒内）";
      delTailTimer = setTimeout(disarmDelTail, 8000);
      return;
    }
    disarmDelTail();
    segs.pop();
    if (sel >= segs.length) sel = segs.length - 1;
    clearBoxSel();
    save(); renderTimeline(); renderEditor();
  });
  /* 删段（v2.10.16）：删除当前选中的段（-段 只能删末尾段） */
  const btnDelSel = mk("button", "h3s-btn", "删段");
  btnDelSel.title = "删除当前选中的段（需再次点击确认；至少保留 1 段）";
  let delSelArmed = false;
  let delSelTarget = -1;
  let delSelTimer = null;
  const disarmDelSel = () => {
    delSelArmed = false;
    delSelTarget = -1;
    clearTimeout(delSelTimer);
    btnDelSel.textContent = "删段";
    btnDelSel.style.background = "";
    btnDelSel.style.borderColor = "";
  };
  btnDelSel.addEventListener("click", () => {
    if (segs.length <= 1) { status.textContent = "至少保留 1 段"; return; }
    if (!delSelArmed || delSelTarget !== sel) {
      disarmDelSel();
      delSelArmed = true;
      delSelTarget = sel;
      btnDelSel.textContent = "再点确认删除段" + (sel + 1);
      btnDelSel.style.background = "#8a2f2f";
      btnDelSel.style.borderColor = "#c05555";
      status.textContent = "请再次点击确认删除段" + (sel + 1) + "（8 秒内）";
      delSelTimer = setTimeout(disarmDelSel, 8000);
      return;
    }
    const removed = sel + 1;
    disarmDelSel();
    segs.splice(sel, 1);
    if (sel >= segs.length) sel = segs.length - 1;
    clearBoxSel();
    save(); renderTimeline(); renderEditor();
    status.textContent = "已删除段" + removed;
  });
  bar.insertBefore(btnDelSel, btnSelAll);
  /* v2.13.15：删除鼠标框选选中的段（框选只负责高亮选中，点本按钮才删；两段式确认，至少留 1 段） */
  const btnDelBox = mk("button", "h3s-btn", "删选中");
  btnDelBox.title = "删除鼠标框选选中的段（至少保留 1 段）";
  let delBoxArmed = false;
  let delBoxTimer = null;
  const disarmDelBox = () => {
    delBoxArmed = false;
    clearTimeout(delBoxTimer);
    btnDelBox.textContent = "删选中";
    btnDelBox.style.background = "";
    btnDelBox.style.borderColor = "";
  };
  btnDelBox.addEventListener("click", () => {
    if (boxSel.size === 0) { status.textContent = "先在段时间轴空白处按住左键拖框选要删的段"; return; }
    if (segs.length - boxSel.size < 1) { status.textContent = "至少保留 1 段"; disarmDelBox(); return; }
    if (!delBoxArmed) {
      delBoxArmed = true;
      btnDelBox.textContent = "再点确认删除 " + boxSel.size + " 段";
      btnDelBox.style.background = "#8a2f2f";
      btnDelBox.style.borderColor = "#c05555";
      status.textContent = "请再次点击确认删除选中的 " + boxSel.size + " 段（8 秒内）";
      delBoxTimer = setTimeout(disarmDelBox, 8000);
      return;
    }
    disarmDelBox();
    const removed = Array.from(boxSel).map((i) => i + 1).sort((a, b) => a - b);
    const keep = segs.filter((_, i) => !boxSel.has(i));
    segs.length = 0;
    segs.push(...keep);
    sel = Math.min(sel, segs.length - 1);
    clearBoxSel();
    save(); renderTimeline(); renderEditor();
    status.textContent = "已删除段 " + removed.join(",") + "（共 " + removed.length + " 段）";
  });
  bar.insertBefore(btnDelBox, btnSelAll);
  /* 清空分段（v2.11.1 修订）：一键删除当前界面时间轴上的全部分段块，重置为 1 个空白段。
     用户明确：不删已生成的成片文件，只清分段配置（初版"清空成片"理解错了需求，后端
     clear_outputs 路由保留但 UI 不再调用）。
     两段式确认（第一次点变红"再点确认"），不用 confirm()（内嵌浏览器静默拦截）。 */
  const btnClearOut = mk("button", "h3s-btn", "清空分段");
  btnClearOut.title = "删除当前界面的全部分段，重置为 1 个空白段（不删除已生成的视频文件）";
  let clearArmed = false;
  const disarmClear = () => {
    clearArmed = false;
    btnClearOut.textContent = "清空分段";
    btnClearOut.style.background = "";
    btnClearOut.style.borderColor = "";
  };
  btnClearOut.addEventListener("click", () => {
    if (!clearArmed) {
      clearArmed = true;
      btnClearOut.textContent = "再点确认删除当前界面全部 " + segs.length + " 段";
      btnClearOut.style.background = "#8a2f2f";
      btnClearOut.style.borderColor = "#c05555";
      return;
    }
    disarmClear();
    /* 原地重置为 1 个该界面的默认段（segs 是指向数据集的引用，不能重新赋值） */
    const fresh = curMode() === "text"
      ? defaultTextSegs()[0]
      : JSON.parse(JSON.stringify(defaultSegs()[0]));
    segs.length = 0;
    segs.push(fresh);
    sel = 0;
    clearBoxSel();
    save(); renderTimeline(); renderEditor();
    status.textContent = "已清空分段，重置为 1 个空白段（成片文件保留在 output 目录，未被删除）";
  });
  bar.insertBefore(btnClearOut, btnSelAll);
  btnSelAll.addEventListener("click", () => {
    segs.forEach((s) => { s.enabled = true; });
    save(); renderTimeline(); renderEditor();
    status.textContent = "已勾选全部 " + segs.length + " 段";
  });
  btnSelNone.addEventListener("click", () => {
    segs.forEach((s) => { s.enabled = false; });
    save(); renderTimeline(); renderEditor();
    status.textContent = "已取消全部勾选（运行将跳过所有段）";
  });
  btnTailAll.addEventListener("click", () => {
    segs.forEach((s, idx) => {
      s.use_tail = idx > 0 && !segmentContinuityBlocked(segs, idx);
      s.motion_context = false;
    });
    save(); renderTimeline(); renderEditor();
    status.textContent = "同分辨率的段已切换为「续接上段尾帧」；尺寸不同的段保持禁用";
  });
  btnTailNone.addEventListener("click", () => {
    segs.forEach((s, idx) => {
      s.use_tail = false;
      if (idx > 0) syncSegmentToPrevious(segs, idx);
      s.motion_context = idx > 0;
    });
    save(); renderTimeline(); renderEditor();
    status.textContent = "段2以后已切换为 MotionContext，并逐段同步上段的比例、分辨率和帧率";
  });

  function updateTotal() {
    const on = segs.filter((s) => s.enabled).length;
    /* 视频界面：时长以节点「时长秒」为准（段配置不生效），顶栏显示同步（v2.5.4） */

    const total = segs.reduce((a, s) => a + segDur(s), 0);
    totalLab.textContent = `共 ${segs.length} 段 · 启用 ${on} · 总 ${total.toFixed(1)}s`;
  }

  function renderTimeline() {
    tl.innerHTML = "";
    tla.innerHTML = "";
    updateTotal();
    /* v2.4：①AUDIO 轨道（开/关 模型音频块）从两个界面移除（用户要求）；
       ②视频界面不显示共享时间轴（整页重做中，布局用户另定） */
    const _vm = curMode() === "video";
    trackA.style.display = "none";  // AUDIO 轨道已按用户要求从两个界面移除
    trackV.style.display = "";      // v2.7：视频界面恢复 MAIN 段时间轴（分段运行）
    let acc = 0;
    segs.forEach((s, i) => {
      const dur = segDur(s);
      const start = acc;
      const end = acc + dur;
      acc = end;
      const slot = mk("div", "h3s-slot" + (i === sel ? " sel" : "") + (boxSel.has(i) ? " boxsel" : ""));
      slot.dataset.idx = i;
      slot.style.width = SLOT_W + "px";
      const img = document.createElement("img");
      img.src = api.apiURL("/h3director/tail?seg=" + (i + 1) + "&" + _modeQ() + "&t=" + Date.now());
      img.onerror = () => { img.style.display = "none"; };
      slot.appendChild(img);
      slot.appendChild(mk("span", "lab", `段${i + 1} · ${fmtSec(start)}-${fmtSec(end)}s`));
      /* v2.13.7：时长标签可点选——弹出 VAE 对齐档位选择器（39~362 帧 ≡5 mod 17，共 20 档）。
         slot 是 overflow:hidden，弹层必须挂 body 用 fixed 定位；点外部自动关闭 */
      const durLab = mk("span", "dur pickable", `${fmtSec(dur)}s`);
      durLab.title = "点选时长档位（VAE 对齐，范围见下方「时长范围」设置）";
      durLab.addEventListener("click", (ev) => {
        ev.stopPropagation();
        document.querySelectorAll(".h3s-durpick").forEach((e) => e.remove());
        const pick = mk("div", "h3s-durpick");
        const _bd = manualBounds();
        for (const f of TIER_FRAMES) {
          if (f < _bd[0] || f > _bd[1]) continue;
          const sec = f / 24;
          const b = mk("button", Math.abs(sec - dur) < 0.05 ? "cur" : null, sec.toFixed(1) + "s");
          b.addEventListener("click", (e2) => {
            e2.stopPropagation();
            s.duration = sec;   // 档位本身已对齐，无需再吸附
            pick.remove();
            save(); renderTimeline(); renderEditor();
          });
          pick.appendChild(b);
        }
        document.body.appendChild(pick);
        pick.style.left = Math.max(8, Math.min(ev.clientX - 10, window.innerWidth - pick.offsetWidth - 12)) + "px";
        pick.style.top = Math.max(8, Math.min(ev.clientY + 8, window.innerHeight - pick.offsetHeight - 12)) + "px";
        const close = (e3) => {
          if (!pick.contains(e3.target)) { pick.remove(); document.removeEventListener("pointerdown", close, true); }
        };
        document.addEventListener("pointerdown", close, true);
      });
      slot.appendChild(durLab);
      if (!s.enabled) slot.appendChild(mk("span", "off", "停用"));
      slot.addEventListener("click", () => {
        clearBoxSel();
        sel = i;
        autoPlaySegment = node.properties.h3_segment_preview_hidden === true ? null : i;
        renderTimeline();
        renderEditor();
      });

      /* 右缘拖拽柄：拖动调整本段时长 */
      const rz = mk("div", "rz");
      rz.title = "拖拽调整时长";
      rz.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const startX = ev.clientX;
        const startDur = segDur(s);
        const sc = canvasScale();
        slot.classList.add("dragging");
        const onMove = (e2) => {
          const d = (e2.clientX - startX) / sc / DRAG_PX_PER_SEC;
          s.duration = clampManual(startDur + d);
          renderTimeline();
          if (durInput && i === sel) durInput.value = s.duration.toFixed(1);
          const cur = tl.children[i];
          if (cur) cur.classList.add("dragging");
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          renderTimeline();
          save();
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      rz.addEventListener("click", (ev) => ev.stopPropagation());
      slot.appendChild(rz);

      tl.appendChild(slot);
    });

    /* AUDIO 轨道：与段时间轴同宽对齐；点「开/关」切换该段是否带声音，点块选中该段 */
    tla.innerHTML = "";
    segs.forEach((s, i) => {
      const en = s.audio_enabled !== false;
      const asrcVal = s.audio_src || (s.audio ? (s.audio_mode === "mix" ? "mix" : "replace") : "model");
      const blk = mk("div", "h3s-ablk" + (en ? "" : " off") + (i === sel ? " sel" : ""));
      blk.style.width = Math.round(segDur(s) * PX_PER_SEC) + "px";
      const sw = mk("span", "asw", en ? "开" : "关");
      sw.title = en ? "点击关闭本段音频（输出无声视频）" : "点击开启本段音频";
      sw.addEventListener("click", (ev) => {
        ev.stopPropagation();
        s.audio_enabled = !en;
        save(); renderTimeline(); renderEditor();
      });
      blk.appendChild(sw);
      const lab = !en ? "已静音" : (asrcVal === "model" ? "模型音频" : (asrcVal === "ref" ? ((s.audio_ref_mode || "copy") === "timbre" ? "音色 ♪" : "复刻 ♪") : (asrcVal === "mix" ? "混合 ♪" : "自定义 ♪")));
      blk.appendChild(mk("span", "alab", lab));
      blk.title = "段" + (i + 1) + " 音频：" + lab + "（可把音频文件拖到这里直接上传）";
      blk.addEventListener("click", () => { sel = i; renderTimeline(); renderEditor(); });
      /* 拖放上传（参考 WhatDreamsCost Load Audio UI）：拖音频文件到段块即上传并分配给该段 */
      blk.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); blk.classList.add("drop"); });
      blk.addEventListener("dragleave", () => blk.classList.remove("drop"));
      blk.addEventListener("drop", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        blk.classList.remove("drop");
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (!f) return;
        if (!/\.(wav|mp3|m4a|ogg|flac|aac)$/i.test(f.name)) {
          status.textContent = "只支持音频文件（wav/mp3/m4a/ogg/flac/aac）";
          return;
        }
        status.textContent = "正在上传音频到段" + (i + 1) + "…";
        try {
          await uploadAudioToSeg(f, i);
          sel = i;
          status.textContent = "音频已拖入段" + (i + 1);
          renderTimeline(); renderEditor();
        } catch (e) {
          status.textContent = "音频上传失败: " + e.message;
        }
      });
      tla.appendChild(blk);
    });
    markDone();
    /* 音长警示角标（参考 WhatDreamsCost 的 duration 输出）：音频有效时长 ≠ 段时长时
       在 AUDIO 块上标 ⚠短（尾部将无声）/ ⚠长（将被截断）。peaks 有缓存，几乎即时。 */
    segs.forEach((s, i) => {
      const blk = tla.children[i];
      if (!blk || !s.audio || s.audio_enabled === false) return;
      loadWavePeaks(s.audio).then((wv) => {
        if (!wv || !wv.duration || !blk.isConnected) return;
        const need = segDur(s) - (s.audio_offset || 0);
        const usable = usableAudioLen(s, wv.duration);
        if (usable < need - 0.3) blk.appendChild(mk("span", "awarn", "⚠短" + (need - usable).toFixed(1) + "s"));
        else if (usable > need + 0.3) blk.appendChild(mk("span", "awarn", "⚠长" + (usable - need).toFixed(1) + "s"));
      }).catch(() => { /* 解码失败不标注 */ });
    });
  }

  async function markDone() {
    try {
      const st = await (await api.fetchApi("/h3director/status?" + _modeQ())).json();
      /* 前后端版本自诊断：后端是旧进程（未重启）或无版本字段时红字提醒 */
      if (st.version !== H3S_VERSION) {
        status.textContent = "⚠ 后端代码过旧（" + (st.version || "无版本号") + " ≠ 前端 " + H3S_VERSION + "），请完全重启 ComfyUI 再 Ctrl+F5";
        status.style.color = "#ff8080";
      } else if (status.style.color) {
        status.style.color = "";
      }
      segs.forEach((s, i) => {
        const slot = tl.children[i];
        if (!slot) return;
        const info = st.segments[String(i + 1)];
        slot.classList.toggle("done", !!(info && info.video));
      });
    } catch (e) { /* 状态接口不可用时忽略 */ }
  }

  /* 根据当前开关计算 Picture 编号引用提示 */
  function picHintText(s, idx) {
    const generationMode = s.generation_mode || "multi_ref";
    if (generationMode === "text_to_video") {
      return "文生视频：不加载下方参考图、上段尾帧或 Motion Context；本段生成完成后仍会保存 Motion Context latent，供下一段续接。";
    }
    if (generationMode === "first_frame") {
      return "首帧生视频：下方从左到右第 1 张图是首帧；其余图不会参与本段生成。";
    }
    if (generationMode === "first_last_frame") {
      return "首尾帧生视频：下方从左到右第 1 张图是首帧，第 2 张图是尾帧；其余图不会参与本段生成。";
    }
    if (generationMode === "last_frame") {
      return "尾帧生视频：下方第 2 张图是尾帧；若只上传 1 张图，则该图作为尾帧。";
    }
    let n = 1;
    const parts = [];
    if (s.use_tail !== false && idx > 0) {
      parts.push(`Picture ${n}=上段尾帧`);
      n += 1;
    }
    parts.push(`Picture ${n}+=本段参考图`);
    return parts.join(", ") + "。提示词写 @图N 会自动转成 <Picture N>，点下面缩略图可直接插入引用。";
  }

  /* 段级 Add Guide 轨道。它不改变参考图/配音的既有语义：参考素材仍作用于
     整段，Guide 则在指定时间把图片、音频或两者锚到 H3 的采样时间线上。 */
  function ensureSegmentGuides(s) {
    if (!Array.isArray(s.guides)) s.guides = [];
    s.guides = s.guides.filter((g) => g && typeof g === "object").map((g) => ({
      kind: ["image", "audio", "image_audio"].includes(g.kind) ? g.kind
        : (g.image && g.audio ? "image_audio" : g.audio ? "audio" : "image"),
      image: g.image || "",
      image_label: g.image_label || "",
      audio: g.audio || "",
      audio_label: g.audio_label || "",
      at_seconds: Math.max(0, Number(g.at_seconds) || 0),
    }));
    return s.guides;
  }

  function appendGuideTrack(s, scopeLabel = "") {
    const guides = ensureSegmentGuides(s);
    const wrap = document.createElement("details");
    wrap.className = "h3s-slrow";
    wrap.style.cssText = "display:block;margin-top:5px;min-width:260px;min-height:64px;overflow:visible;";
    const savedGuideSize = s.guide_area_size;
    if (savedGuideSize && Number.isFinite(Number(savedGuideSize.width))) {
      wrap.style.flex = "none";
      wrap.style.width = Math.max(260, Math.round(Number(savedGuideSize.width))) + "px";
    }
    // 仅恢复新版把手主动保存的高度。旧工作流里的历史高度没有 manual_height
    // 标记，仍按内容自动撑开，避免把“添加锚点”按钮或卡片裁掉。
    const hasManualGuideHeight = !!(savedGuideSize && savedGuideSize.manual_height === true
      && Number.isFinite(Number(savedGuideSize.height)));
    if (hasManualGuideHeight) {
      wrap.style.height = Math.max(64, Math.round(Number(savedGuideSize.height))) + "px";
      wrap.style.overflow = "auto";
    }
    // 新建段默认展开；用户折叠后的状态也随该段保存，避免编辑素材后重新渲染又弹开。
    wrap.open = s.guide_area_open !== false;
    wrap.addEventListener("toggle", () => { s.guide_area_open = wrap.open; save(); });
    const summary = document.createElement("summary");
    summary.style.cssText = "cursor:pointer;color:#9fd0ff;user-select:none;";
    summary.textContent = "帧锚点 Add Guide（" + guides.length + " 个）";
    wrap.appendChild(summary);
    const body = mk("div", null);
    body.style.cssText = "display:flex;flex-direction:column;gap:6px;padding:8px 0 2px;";
    body.appendChild(mk("div", "h3s-hint",
      "图片、音频或两者均可在指定秒数锚定；多个锚点会按时间自动排序并连续串联。"
      + (s.motion_context === true
        ? " 已开启 MotionContext：时间以导出片段为准，系统自动避开被裁掉的接力前缀。"
        : "")));

    // 用户拖出的宽度继续保留；一旦卡片数量或卡片内容变化，高度交还给
    // 浏览器按内容计算，因此添加会撑开、删除会收回。
    const resetGuideAutoHeight = () => {
      const old = s.guide_area_size || {};
      s.guide_area_size = Number.isFinite(Number(old.width))
        ? { width: Math.round(Number(old.width)), height: null, manual_height: false }
        : null;
    };

    // 帧锚点把手不仅调容器：已上传的图片缩略图也按可用高度同步缩放。
    // 多个图片锚点会均分空间，避免放大后把后面的卡片挤出区域。
    const guideImagePreviews = [];
    const resizeGuideImages = (areaHeight) => {
      if (!guideImagePreviews.length) return;
      const fixedHeight = 100 + guides.length * 36;
      const imageHeight = Math.max(30, Math.min(240,
        Math.floor((Number(areaHeight) - fixedHeight) / guideImagePreviews.length)));
      const imageWidth = Math.max(44, Math.round(imageHeight * 4 / 3));
      guideImagePreviews.forEach((preview) => {
        preview.style.width = imageWidth + "px";
        preview.style.height = imageHeight + "px";
      });
    };

    const addGuide = (kind) => {
      guides.push({ kind, image: "", image_label: "", audio: "", audio_label: "", at_seconds: 0 });
      resetGuideAutoHeight();
      save(); renderEditor();
    };
    const addRow = mk("div", "h3s-row");
    [["image", "+ 图片锚点"], ["audio", "+ 音频锚点"], ["image_audio", "+ 音画锚点"]]
      .forEach(([kind, label]) => {
        const btn = mk("button", "h3s-btn", label);
        btn.title = kind === "image" ? "在目标时间固定一张图片"
          : kind === "audio" ? "在目标时间固定一段音频"
          : "在同一时间固定图片和音频";
        btn.addEventListener("click", () => addGuide(kind));
        addRow.appendChild(btn);
      });
    body.appendChild(addRow);

    const pickImage = (guide) => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*"; inp.style.display = "none";
      document.body.appendChild(inp);
      inp.addEventListener("change", async () => {
        try {
          const file = inp.files && inp.files[0];
          if (!file) return;
          status.textContent = "正在上传锚点图片…";
          const fd = new FormData();
          fd.append("image", file, file.name); fd.append("overwrite", "true");
          const r = await (await api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
          if (!r || !r.name) throw new Error((r && r.error) || "上传接口没有返回文件名");
          guide.image = (r.subfolder ? r.subfolder + "/" : "") + r.name;
          guide.image_label = file.name;
          resetGuideAutoHeight();
          save(); renderEditor();
          status.textContent = "锚点图片已添加";
        } catch (e) { status.textContent = "锚点图片上传失败: " + e.message; }
        finally { inp.remove(); }
      });
      inp.click();
    };
    const pickAudio = (guide) => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac"; inp.style.display = "none";
      document.body.appendChild(inp);
      inp.addEventListener("change", async () => {
        try {
          const file = inp.files && inp.files[0];
          if (!file) return;
          status.textContent = "正在上传锚点音频…";
          const fd = new FormData(); fd.append("audio", file, file.name);
          const r = await (await api.fetchApi("/h3director/upload_audio", { method: "POST", body: fd })).json();
          if (!(r && r.ok && r.name)) throw new Error((r && r.error) || "上传接口没有返回文件名");
          guide.audio = r.name; guide.audio_label = r.label || file.name;
          resetGuideAutoHeight();
          save(); renderEditor();
          status.textContent = "锚点音频已添加";
        } catch (e) { status.textContent = "锚点音频上传失败: " + e.message; }
        finally { inp.remove(); }
      });
      inp.click();
    };

    guides.forEach((guide, index) => {
      const card = mk("div", null);
      card.style.cssText = "border:1px solid #2f567a;border-radius:7px;padding:6px;background:#141b23;";
      const head = mk("div", "h3s-row");
      const kinds = { image: "图片", audio: "音频", image_audio: "音画" };
      head.appendChild(mk("span", "num", "G" + (index + 1)));
      head.appendChild(mk("span", "h3s-hint", kinds[guide.kind] + "锚点"));
      const seconds = document.createElement("input");
      seconds.type = "number"; seconds.min = "0"; seconds.max = String(Math.max(0, segDur(s) - 1 / PX_PER_SEC)); seconds.step = "0.05";
      seconds.value = Number(guide.at_seconds || 0).toFixed(2); seconds.style.width = "58px";
      seconds.title = "导出片段内的锚定时间（秒）；H3 按 24 fps 自动换算";
      const frameHint = mk("span", "h3s-hint", "秒 · 帧 " + Math.round((guide.at_seconds || 0) * PX_PER_SEC));
      const syncGuideTime = (saveValue) => {
        const max = Math.max(0, segDur(s) - 1 / PX_PER_SEC);
        guide.at_seconds = Math.min(max, Math.max(0, Number(seconds.value) || 0));
        frameHint.textContent = "秒 · 帧 " + Math.round(guide.at_seconds * PX_PER_SEC);
        if (saveValue) { seconds.value = guide.at_seconds.toFixed(2); save(); }
      };
      // input 负责立即刷新帧号并保存数值；save 不会重绘编辑器，因此不会打断输入。
      seconds.addEventListener("input", () => { syncGuideTime(false); save(); });
      seconds.addEventListener("change", () => syncGuideTime(true));
      head.append(mk("span", "h3s-hint", "时间"), seconds, frameHint);
      const del = mk("button", "h3s-btn", "删除");
      del.addEventListener("click", () => {
        guides.splice(index, 1); resetGuideAutoHeight(); save(); renderEditor();
      });
      head.appendChild(del);
      card.appendChild(head);

      if (guide.kind === "image" || guide.kind === "image_audio") {
        const row = mk("div", "h3s-row");
        row.appendChild(mk("span", "h3s-hint", "图片："));
        if (guide.image) {
          const preview = document.createElement("img");
          preview.src = api.apiURL("/view?filename=" + encodeURIComponent(guide.image) + "&type=input");
          preview.style.cssText = "width:44px;height:30px;object-fit:cover;border-radius:3px;background:#000;";
          guideImagePreviews.push(preview);
          row.append(preview, mk("span", "h3s-hint", guide.image_label || guide.image));
          const clear = mk("button", "h3s-btn", "移除");
          clear.addEventListener("click", () => {
            guide.image = ""; guide.image_label = ""; resetGuideAutoHeight(); save(); renderEditor();
          });
          row.appendChild(clear);
        }
        const upload = mk("button", "h3s-btn", guide.image ? "替换图片" : "上传图片");
        upload.addEventListener("click", () => pickImage(guide));
        row.appendChild(upload);
        if (Array.isArray(s.refs) && s.refs.length) {
          const refPick = document.createElement("select");
          refPick.innerHTML = '<option value="">使用本段参考图…</option>';
          s.refs.forEach((name) => {
            const opt = document.createElement("option"); opt.value = name; opt.textContent = name; refPick.appendChild(opt);
          });
          refPick.addEventListener("change", () => {
            if (!refPick.value) return;
            guide.image = refPick.value; guide.image_label = refPick.value;
            resetGuideAutoHeight(); save(); renderEditor();
          });
          row.appendChild(refPick);
        }
        card.appendChild(row);
      }

      if (guide.kind === "audio" || guide.kind === "image_audio") {
        const row = mk("div", "h3s-row");
        row.appendChild(mk("span", "h3s-hint", "音频："));
        if (guide.audio) {
          row.appendChild(mk("span", "h3s-hint", "♪ " + (guide.audio_label || guide.audio)));
          const play = document.createElement("audio");
          play.controls = true; play.preload = "metadata";
          play.src = api.apiURL("/view?filename=" + encodeURIComponent(guide.audio) + "&type=input");
          play.style.cssText = "height:24px;max-width:160px;";
          row.appendChild(play);
          const clear = mk("button", "h3s-btn", "移除");
          clear.addEventListener("click", () => {
            guide.audio = ""; guide.audio_label = ""; resetGuideAutoHeight(); save(); renderEditor();
          });
          row.appendChild(clear);
        }
        const upload = mk("button", "h3s-btn", guide.audio ? "替换音频" : "上传音频");
        upload.addEventListener("click", () => pickAudio(guide));
        row.appendChild(upload);
        const library = document.createElement("select");
        library.style.maxWidth = "150px"; library.innerHTML = '<option value="">音频库…</option>';
        library.addEventListener("change", () => {
          if (!library.value) return;
          guide.audio = library.value; guide.audio_label = library.value;
          resetGuideAutoHeight(); save(); renderEditor();
        });
        row.appendChild(library);
        api.fetchApi("/h3director/list_audio").then((r) => r.json()).then((data) => {
          (data.files || []).forEach((file) => {
            const opt = document.createElement("option"); opt.value = file.name; opt.textContent = file.name; library.appendChild(opt);
          });
        }).catch(() => { /* 旧后端无音频库时仍可上传 */ });
        card.appendChild(row);
      }
      body.appendChild(card);
    });
    wrap.appendChild(body);
    editor.appendChild(wrap);
    if (hasManualGuideHeight) resizeGuideImages(Number(savedGuideSize.height));
    // Guide 轨道与视频参考区使用独立尺寸字段、独立把手，调一边不会影响另一边。
    attachBottomBar(wrap, 260, 64, (width, height, finished) => {
      resizeGuideImages(height);
      if (!finished) return;
      // 用户手动调整时保存高度；新增/删除锚点会通过 resetGuideAutoHeight 回到自动高度。
      s.guide_area_size = { width: Math.round(width), height: Math.round(height), manual_height: true };
      save();
    });
  }

  /* ================= 视频界面（v2.1 独立整版）=================
     布局参考 WhatDreamsCost：上方参考视频大缩略图（点击即播放预览），
     下方参考照片（外观），底部成片预览。动作/运镜/节奏跟 <Video N>，
     外观跟 <Picture N>（后端自动追加官方 reference 声明）。 */
  /* ================= 视频界面（v2.4 重做第一步：加载视频）=================
     参考 WhatDreamsCost Load Video：拖视频进来（或点选）即加载并播放预览。
     与创作界面数据完全独立（vsegments_json），产出文件名也独立（漫剧v_）。 */
  /* ================= 视频界面（v2.5 WDC 布局）=================
     自上而下：①视频和图片 ②音频（波形）③参考视频 ④播放键 ⑤底部提示词。
     数据独立（vsegments_json）：图片→refs（<Picture N>），视频→video_refs[0]（<Video 1>），
     音频→audio+audio_src=ref（参考音频驱动，口型原生同步）。 */
  function renderVideoEditor(s) {
    if (!Array.isArray(s.refs)) s.refs = [];
    if (!Array.isArray(s.video_refs)) s.video_refs = [];
    if (!s.video_labels) s.video_labels = {};

    /* 底部提示词（先建后挂，各区块的 P/V 标点击插入） */
    const vta = document.createElement("textarea");
    vta.className = "h3s-ta";
    vta.value = s.prompt || "";
    vta.placeholder = "提示词：描述外观 / 风格 / 剧情（动作和运镜会跟随参考视频）。点区块上的 P / V 标可插入 <Picture N> / <Video N>";
    vta.addEventListener("input", () => { s.prompt = vta.value; save(); });
    const insertV = (tag) => {
      const st = vta.selectionStart != null ? vta.selectionStart : vta.value.length;
      vta.value = vta.value.slice(0, st) + tag + vta.value.slice(st);
      s.prompt = vta.value; save();
      vta.focus();
      vta.selectionStart = vta.selectionEnd = st + tag.length;
    };

    /* 三个上传器 */
    const upImage = async (f) => {
      const fd = new FormData();
      fd.append("image", f, f.name);
      fd.append("overwrite", "true");
      const r = await (await api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
      s.refs.push((r.subfolder ? r.subfolder + "/" : "") + r.name);
    };
    const upAudio = async (f) => {
      const fd = new FormData();
      fd.append("audio", f, f.name);
      const r = await (await api.fetchApi("/h3director/upload_audio", { method: "POST", body: fd })).json();
      if (!(r.ok && r.name)) throw new Error(r.error || "上传失败");
      s.audio = r.name;
      s.audio_label = r.label || f.name;
      s.audio_src = "ref";  // 视频界面的音频=参考音频驱动（对口型）
    };
    const upVideo = async (f) => {
      const fd = new FormData();
      fd.append("video", f, f.name);
      const r = await (await api.fetchApi("/h3director/upload_video", { method: "POST", body: fd })).json();
      if (!(r.ok && r.name)) throw new Error(r.error || "上传失败");
      s.video_refs = [r.name];
      s.video_labels[r.name] = r.label || f.name;
    };
    /* 拖放/点选 通用接线 */
    const wireDrop = (zone, acceptRe, handler) => {
      zone.addEventListener("dragover", (ev) => { ev.preventDefault(); ev.stopPropagation(); zone.classList.add("drop"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drop"));
      zone.addEventListener("drop", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        zone.classList.remove("drop");
        const files = ev.dataTransfer && ev.dataTransfer.files;
        if (!files || !files.length) return;
        status.textContent = "正在加载…";
        try {
          for (const f of files) {
            if (!acceptRe.test(f.name)) { status.textContent = "不支持的文件: " + f.name; continue; }
            await handler(f);
          }
          save(); renderEditor();
          status.textContent = "加载完成";
        } catch (e) { status.textContent = "加载失败: " + e.message; }
      });
    };
    const pickFiles = (accept, multiple, handler) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = accept;
      if (multiple) inp.multiple = true;
      inp.addEventListener("change", async () => {
        if (!inp.files.length) return;
        status.textContent = "正在加载…";
        try {
          for (const f of inp.files) await handler(f);
          save(); renderEditor();
          status.textContent = "加载完成";
        } catch (e) { status.textContent = "加载失败: " + e.message; }
      });
      inp.click();
    };

    /* ======== ⓪ 段信息行（v2.7：分段回归——每段独立时长/启用）======== */
    const row0 = mk("div", "h3s-row");
    row0.appendChild(mk("b", null, `段 ${sel + 1}`));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.title = "启用本段（取消勾选则运行时跳过）";
    cb.addEventListener("change", () => { s.enabled = cb.checked; save(); renderTimeline(); });
    row0.appendChild(cb);
    row0.appendChild(mk("span", null, "启用"));
    appendResolutionControls(row0, s);
    row0.appendChild(mk("span", "h3s-hint", "时长（秒）："));
    const durW = node.widgets.find((w) => w.name === "时长秒");  // 节点默认值（新建段用）
    const din = mk("input", "h3s-durinput");
    din.type = "number";
    din.step = "0.5";
    din.min = "2";
    din.max = "15";
    din.value = segDur(s).toFixed(1);
    din.title = "本段时长（每段独立；也可在时间轴上拖段块右缘调整）。手动调整范围 " + (manualBounds()[0] / 24).toFixed(1) + "~" + (manualBounds()[1] / 24).toFixed(1) + "s（见下方「时长范围」设置）";
    din.addEventListener("change", () => {
      s.duration = clampManual(Number(din.value) || segDur(s));
      din.value = s.duration.toFixed(1);
      save(); renderTimeline();
    });
    /* 显式 − / ＋ 步进按钮（v2.10.17）：内嵌浏览器里数字框的原生上下箭头
       会被面板层挡住点不中，用户实测"箭头调不了" */
    const stepDur = (d) => {
      s.duration = clampManual((Number(din.value) || segDur(s)) + d);
      din.value = s.duration.toFixed(1);
      save(); renderTimeline();
    };
    const btnMinus = mk("button", "h3s-btn", "\u2212");
    const btnPlus = mk("button", "h3s-btn", "\uff0b");
    btnMinus.title = btnPlus.title = "\u6bcf\u6b21 0.5 \u79d2";
    btnMinus.addEventListener("click", () => stepDur(-0.5));
    btnPlus.addEventListener("click", () => stepDur(0.5));
    row0.appendChild(din);
    row0.appendChild(btnMinus);
    row0.appendChild(btnPlus);
    /* 种子（v2.9.2）：-1=每次随机；🎲 固定一个随机种子复刻同款 */
    row0.appendChild(mk("span", "h3s-hint", "种子"));
    const seedModeSel = mk("select", "h3s-seedmode");
    [["current", "当段随机"], ["all_diff", "全段各自随机"], ["all_same", "全段统一随机"]].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      seedModeSel.appendChild(o);
    });
    seedModeSel.value = node.properties.h3_seed_mode || "current";
    seedModeSel.title = "🎲 随机范围：当段=只随机当前段；全段各自=每段一个不同新种子；全段统一=所有段用同一个新种子";
    seedModeSel.addEventListener("change", () => {
      node.properties.h3_seed_mode = seedModeSel.value;
      save();
    });
    const seedIn = mk("input", "h3s-seed");
    seedIn.type = "number";
    seedIn.value = String(s.seed != null ? s.seed : -1);
    seedIn.placeholder = "-1=随机";
    seedIn.title = "-1=每次随机；填固定值=复刻同款结果";
    seedIn.addEventListener("change", () => {
      s.seed = Number(seedIn.value);
      save();
    });
    const btnDice = mk("button", "h3s-btn", "🎲");
    btnDice.title = "按左侧选择的范围随机种子";
    btnDice.addEventListener("click", () => {
      const mode = node.properties.h3_seed_mode || "current";
      if (mode === "all_diff") {
        segs.forEach((seg) => { seg.seed = Math.floor(Math.random() * 1e15); });
        seedIn.value = String(s.seed);
        status.textContent = "全部 " + segs.length + " 段已各自随机新种子";
      } else if (mode === "all_same") {
        const newSeed = Math.floor(Math.random() * 1e15);
        segs.forEach((seg) => { seg.seed = newSeed; });
        seedIn.value = String(s.seed);
        status.textContent = "全部 " + segs.length + " 段已统一为种子: " + newSeed;
      } else {
        s.seed = Math.floor(Math.random() * 1e15);
        seedIn.value = String(s.seed);
        status.textContent = "新种子: " + s.seed;
      }
      save();
    });
    row0.appendChild(seedModeSel);
    row0.appendChild(seedIn);
    row0.appendChild(btnDice);
    const continuityBlocked = segmentContinuityBlocked(segs, sel);
    const continuityName = `h3-cont-${node.id}-video-${sel}`;
    const cbTail = document.createElement("input");
    cbTail.type = "checkbox";
    cbTail.name = continuityName;
    cbTail.checked = !continuityBlocked && s.use_tail === true;
    cbTail.disabled = continuityBlocked;
    cbTail.title = continuityBlocked ? "本段与上段分辨率不同，禁止续接尾帧" : "续接上段尾帧；选择后自动关闭 MotionContext，也可再次取消";
    cbTail.addEventListener("change", () => {
      s.use_tail = cbTail.checked;
      if (cbTail.checked) s.motion_context = false;
      save(); renderEditor();
    });
    row0.appendChild(cbTail);
    const tailModeLab = mk("span", null, "续接上段尾帧");
    if (continuityBlocked) tailModeLab.style.opacity = "0.45";
    row0.appendChild(tailModeLab);
    const cbMotion = document.createElement("input");
    cbMotion.type = "checkbox";
    cbMotion.name = continuityName;
    cbMotion.checked = !continuityBlocked && s.motion_context === true;
    cbMotion.disabled = false;
    cbMotion.title = continuityBlocked ? "勾选后自动同步上段的宽高比、分辨率和帧率，再开启 MotionContext" : "选择后自动关闭尾帧续接；同时同步上段的宽高比、分辨率和帧率";
    cbMotion.addEventListener("change", () => {
      s.motion_context = cbMotion.checked;
      if (cbMotion.checked) {
        const synced = syncSegmentToPrevious(segs, sel);
        s.use_tail = false;
        if (!Number.isFinite(Number(s.motion_context_index)) || Number(s.motion_context_index) < 0) {
          s.motion_context_index = sel;
        }
        if (synced) status.textContent = `MotionContext 已开启：本段已同步为 ${synced[0]}×${synced[1]} / ${synced[2]}fps`;
      }
      save(); renderEditor();
    });
    row0.appendChild(cbMotion);
    const motionLab = mk("span", null, "MotionContext");
    row0.appendChild(motionLab);
    if (continuityBlocked) row0.appendChild(mk("span", "h3s-audio-warn", "尾帧续接已禁用；勾选 MotionContext 会自动同步上段尺寸和帧率"));
    appendLocalMotionIndex(row0, s, sel);
    row0.appendChild(mk("span", "h3s-hint", "每段=上方照片+下方参考视频，建议时长 ≤ 参考视频时长"));
    editor.appendChild(row0);

    /* ======== ① 视频和图片 ======== */
    editor.appendChild(mk("div", "h3s-hint", "视频和图片（拖入或点选；图片=外观参考，视频自动归入下方参考视频区）："));
    const z1 = mk("div", "h3s-vdz");
    z1.style.minHeight = "110px";
    z1.style.flex = "none";
    const z1body = mk("div", "h3s-refs");
    z1body.style.cssText = "border:none;background:transparent;flex-wrap:wrap;justify-content:center;height:auto;min-height:64px;";
    s.refs.forEach((name, k) => {
      const num = k + 1;
      const box = mk("div", "h3s-pic");
      box.style.cssText = "position:relative;width:72px;height:72px;flex:none;";
      box.title = `<Picture ${num}>（点击插入提示词）`;
      const img = document.createElement("img");
      img.src = api.apiURL("/view?filename=" + encodeURIComponent(name) + "&type=input");
      img.onerror = () => { img.style.display = "none"; };
      const badge = mk("span", "num", `P${num}`);
      badge.addEventListener("click", (ev) => { ev.stopPropagation(); insertV(`<Picture ${num}>`); });
      box.addEventListener("click", () => insertV(`<Picture ${num}>`));
      const x = mk("button", "x", "✕");
      x.title = "移除";
      x.addEventListener("click", (ev) => { ev.stopPropagation(); s.refs.splice(k, 1); save(); renderEditor(); });
      box.append(img, badge, x);
      z1body.appendChild(box);
    });
    const z1add = mk("button", "h3s-btn", s.refs.length ? "+ 继续添加" : "+ 选择视频 / 图片");
    z1add.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pickFiles("image/*,video/*", true, async (f) => {
        if (/\.(mp4|webm|mov|mkv|avi)$/i.test(f.name)) { await upVideo(f); }
        else { await upImage(f); }
      });
    });
    z1body.appendChild(z1add);
    z1.appendChild(z1body);
    if (!s.refs.length) {
      z1.appendChild(mk("div", "h3s-hint", "或把文件拖到这里"));
    }
    wireDrop(z1, /\.(png|jpe?g|webp|bmp|mp4|webm|mov|mkv|avi)$/i, async (f) => {
      if (/\.(mp4|webm|mov|mkv|avi)$/i.test(f.name)) { await upVideo(f); }
      else { await upImage(f); }
    });
    editor.appendChild(z1);

    /* ======== ③ 参考视频 ======== */
    editor.appendChild(mk("div", "h3s-hint", "参考视频（动作/运镜参考，如白模渲染；最多 1 个，2~15 秒）："));
    const curV = s.video_refs[0] || null;
    if (!curV) {
      const z3 = mk("div", "h3s-vdz");
      z3.style.minHeight = "120px";
      z3.style.flex = "none";
      const b = mk("button", "h3s-btn", "+ 选择视频");
      b.addEventListener("click", (ev) => { ev.stopPropagation(); pickFiles("video/*", false, upVideo); });
      z3.appendChild(b);
      z3.appendChild(mk("div", "h3s-hint", "或把视频拖到这里（mp4/webm/mov）"));
      wireDrop(z3, /\.(mp4|webm|mov|mkv|avi)$/i, upVideo);
      editor.appendChild(z3);
    } else {
      const disp = (s.video_labels[curV] || curV).replace(/\.[^.]+$/, "");
      const head = mk("div", "h3s-row");
      const vBadge = mk("span", "num", "V1");
      vBadge.style.cssText = "background:rgba(24,95,165,0.92);color:#fff;font-size:11px;padding:1px 6px;border-radius:4px;cursor:pointer;";
      vBadge.title = "<Video 1> 点击插入提示词";
      vBadge.addEventListener("click", () => insertV("<Video 1>"));
      head.appendChild(vBadge);
      head.appendChild(mk("span", "h3s-hint", disp));
      const btnRe = mk("button", "h3s-btn", "重新加载");
      btnRe.addEventListener("click", () => pickFiles("video/*", false, upVideo));
      const btnRm = mk("button", "h3s-btn", "✕ 移除");
      btnRm.addEventListener("click", () => { s.video_refs = []; save(); renderEditor(); });
      head.appendChild(btnRe);
      head.appendChild(btnRm);
      /* 加载帧率（v2.6，对齐教程 XB-BOX 视频加载器的强制帧率）：
         24=逐帧跟随；调低=抽帧概括（只取运镜/省显存时常用 8~12） */
      head.appendChild(mk("span", "h3s-hint", "加载帧率"));
      const fpsIn = mk("input", "h3s-durinput");
      fpsIn.type = "number";
      fpsIn.min = "1";
      fpsIn.max = "24";
      fpsIn.step = "1";
      fpsIn.value = String(s.video_fps || 24);
      fpsIn.title = "参考视频按此帧率采样：24=逐帧跟随动作；调低（如 8~12）=抽帧概括、省显存";
      fpsIn.addEventListener("change", () => {
        s.video_fps = Math.max(1, Math.min(24, Math.round(Number(fpsIn.value) || 24)));
        fpsIn.value = String(s.video_fps);
        save();
        status.textContent = "加载帧率已设为 " + s.video_fps + "（改后需重跑才生效）";
      });
      head.appendChild(fpsIn);
      /* 起始秒（=教程 XB-BOX 的"跳过前X帧"，v2.6.1）：从视频第 X 秒开始取 */
      head.appendChild(mk("span", "h3s-hint", "起始秒"));
      const skipIn = mk("input", "h3s-durinput");
      skipIn.type = "number";
      skipIn.min = "0";
      skipIn.max = "60";
      skipIn.step = "0.5";
      skipIn.value = String(s.video_skip || 0);
      skipIn.title = "跳过参考视频的前 X 秒，从中间开始取（只要视频后半段的动作时用）";
      skipIn.addEventListener("change", () => {
        s.video_skip = Math.max(0, Number(skipIn.value) || 0);
        skipIn.value = String(s.video_skip);
        save();
        status.textContent = "起始秒已设为 " + s.video_skip + "s（改后需重跑才生效）";
      });
      head.appendChild(skipIn);
      editor.appendChild(head);
    }

    /* ======== ③b 参考视频紧凑块（WDC 风格：小块内嵌画面，点画面也能播/停）======== */
    let mainPlayer = null;
    if (curV) {
      const vblk = mk("div", null);
      vblk.style.cssText = "position:relative;width:264px;height:148px;flex:none;border-radius:8px;"
        + "overflow:hidden;background:#000;border:1px solid #3a5a7a;";
      const v = document.createElement("video");
      v.src = api.apiURL("/view?filename=" + encodeURIComponent(curV) + "&type=input");
      v.preload = "auto";
      v.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;cursor:pointer;";
      v.title = "点击播放/暂停";
      v.addEventListener("click", () => { if (v.paused) v.play(); else v.pause(); });
      const vlab = mk("span", null, (s.video_labels[curV] || curV));
      vlab.style.cssText = "position:absolute;left:4px;top:3px;font-size:10px;color:#fff;"
        + "text-shadow:0 1px 2px #000;pointer-events:none;max-width:250px;overflow:hidden;"
        + "text-overflow:ellipsis;white-space:nowrap;";
      vblk.append(v, vlab);
      editor.appendChild(vblk);
      mainPlayer = v;
    }

    /* ======== ④ 播放键（控制参考视频小块）======== */
    const ctl = mk("div", "h3s-row");
    ctl.style.cssText = "justify-content:center;gap:10px;";
    const bPlay = mk("button", "h3s-btn primary", "▶ 播放");
    const bPause = mk("button", "h3s-btn", "⏸ 暂停");
    const bStop = mk("button", "h3s-btn", "⏹ 回开头");
    for (const b of [bPlay, bPause, bStop]) b.style.minWidth = "86px";
    bPlay.addEventListener("click", () => { if (mainPlayer) mainPlayer.play(); });
    bPause.addEventListener("click", () => { if (mainPlayer) mainPlayer.pause(); });
    bStop.addEventListener("click", () => { if (mainPlayer) { mainPlayer.pause(); mainPlayer.currentTime = 0; } });
    ctl.append(bPlay, bPause, bStop);
    if (!curV) {
      bPlay.disabled = bPause.disabled = bStop.disabled = true;
      ctl.appendChild(mk("span", "h3s-hint", "（加载参考视频后可播放预览）"));
    }
    editor.appendChild(ctl);
    appendGuideTrack(s, "视频");

    /* ======== ⑤ 底部提示词（含四段式模板，v2.6）======== */
    const tplRow = mk("div", "h3s-row");
    tplRow.appendChild(mk("span", "h3s-hint", "提示词："));
    /* 模板下拉（v2.7）：教程四段式（人物替换）/ 通用简版（动作运镜） */
    const tplSel = document.createElement("select");
    tplSel.innerHTML = '<option value="">插入模板…</option>'
      + '<option value="replace">人物替换·四段式（教程版）</option>'
      + '<option value="motion">通用动作/运镜（简版）</option>'
      + '<option value="story">图片叙事·单主体版（教程）</option>'
      + '<option value="voice">音色对白·双人版（教程）</option>';
    tplSel.title = "选择模板插入提示词框：教程版=四段式人物替换（4 人映射），简版=通用动作/运镜";
    tplSel.addEventListener("change", () => {
      let tpl = null;
      if (tplSel.value === "replace") {
        tpl = "\u3010\u7d20\u6750\u5173\u7cfb\u5206\u914d\u3011\n"
        + "\u5168\u5c40\u7684\u955c\u5934\u8fd0\u52a8\u8f68\u8ff9\u3001\u4eba\u7269\u7684\u51fa\u573a\u65f6\u673a\u3001\u80a2\u4f53\u52a8\u4f5c\u4ee5\u53ca\u753b\u9762\u6784\u56fe\uff0c\u8bf7\u5b8c\u5168 1:1 \u590d\u5236\u53c2\u8003\u89c6\u9891 <Video 1>\u3002\u89c6\u9891\u7684\u80cc\u666f\u97f3\u4e50\u4e0e\u8282\u594f\u5361\u70b9\u8bf7\u53c2\u8003 <Video 1> \u7684\u97f3\u8f68\u3002\n"
        + "\u4eba\u7269\u89d2\u8272\u5f3a\u5236\u66ff\u6362\uff1a\u539f\u89c6\u9891\u4e2d\u7684<\u4eba\u7269A> \u66ff\u6362\u4e3a <Picture 1>\uff08<\u5916\u8c8c\u7a7f\u7740>\uff09\uff1b\u539f\u89c6\u9891\u4e2d\u7684<\u4eba\u7269B> \u66ff\u6362\u4e3a <Picture 2>\uff08<\u5916\u8c8c\u7a7f\u7740>\uff09\uff1b\u539f\u89c6\u9891\u4e2d\u7684<\u4eba\u7269C> \u66ff\u6362\u4e3a <Picture 3>\uff08<\u5916\u8c8c\u7a7f\u7740>\uff09\uff1b\u539f\u89c6\u9891\u4e2d\u7684<\u4eba\u7269D> \u66ff\u6362\u4e3a <Picture 4>\uff08<\u5916\u8c8c\u7a7f\u7740>\uff09\u3002100% \u66ff\u6362\u6bcf\u4e00\u4e2a\uff0c\u4e0d\u5141\u8bb8\u4fdd\u7559\u539f\u4eba\u7269\u7684\u4efb\u4f55\u5916\u8c8c\u7279\u5f81\u3002\n"
        + "\u3010\u753b\u9762\u7f8e\u5b66\u4e0e\u8d28\u611f\u3011\n"
        + "\u80f6\u7247\u8d28\u611f\uff1a35mm \u80f6\u7247\u9897\u7c92\uff0cKodak Vision2 500T \u7f8e\u5b66\u3002\u91c7\u7528\u660e\u4eae\u7684\u53e4\u5178\u51b7\u767d\u8c03\u5149\u6e90\uff0c\u4fdd\u7559\u6781\u7b80\u4e3b\u4e49\u7a7a\u95f4\u4e0e\u6c7d\u8f66\u91d1\u5c5e\u6f06\u9762\u7684\u9ad8\u7ea7\u8d28\u611f\u3002\u5c06\u5404\u53c2\u8003\u56fe\u7684\u4e8c\u6b21\u5143\u7279\u5f81\u5b8c\u7f8e\u8f6c\u5316\u4e3a\u5177\u6709\u7535\u5f71\u7ea7\u771f\u5b9e\u5149\u5f71\u7684 3D \u903c\u771f\u4eba\u7269\uff0c\u670d\u88c5\u6750\u8d28\u5347\u7ea7\u4e3a\u5177\u6709\u771f\u5b9e\u8936\u76b1\u7684\u5e03\u6599\uff0c\u4e0e\u573a\u666f\u5b8c\u7f8e\u878d\u5408\u3002\n"
        + "\u3010\u8be6\u7ec6\u65f6\u95f4\u7ebf\u8c03\u5ea6\u3011\n"
        + "0 \u81f3 2 \u79d2\uff1a\n\u4e2d\u8fd1\u666f\u955c\u5934\uff0c\u753b\u9762\u4e2d\u592e\u5c55\u793a\u51fa <Picture 1> \u7684\u4e0a\u534a\u8eab\uff0c\u4ed6\u51b7\u6f20\u5730\u671b\u7740\u955c\u5934\uff0c\u8868\u60c5\u6781\u5176\u4e13\u6ce8\uff0c\u59ff\u6001\u5b8c\u5168\u590d\u523b <Video 1> \u5f00\u5934\u4eba\u7269\u7684\u52a8\u4f5c\u3002\n\n"
        + "2 \u81f3 5 \u79d2\uff1a\n<Picture 2> \u4ece\u955c\u5934\u53f3\u4fa7\u6781\u8fd1\u5904\u8d70\u5165\u753b\u9762\uff0c\u5176\u8eab\u4f53\u79fb\u52a8\u81ea\u7136\u5f62\u6210\u865a\u5316\u7684\u524d\u666f\u906e\u6321\u8f6c\u573a\u3002\u7126\u70b9\u987a\u52bf\u8f6c\u79fb\u81f3 <Picture 2> \u7684\u9762\u90e8\uff0c\u4ed6\u7f13\u7f13\u8f6c\u5934\uff0c\u773c\u795e\u9510\u5229\u5730\u76f4\u89c6\u955c\u5934\uff0c\u5634\u89d2\u52fe\u8d77\u4e00\u4e1d\u81ea\u4fe1\u5fae\u7b11\uff0c\u8d70\u4f4d\u4e0e\u539f\u89c6\u9891 <Video 1> \u4e2d\u7684\u4eba\u7269\u5b8c\u5168\u4e00\u81f4\u3002\n\n"
        + "5 \u81f3 8 \u79d2\uff1a\n\u955c\u5934\u5f00\u59cb\u5e73\u6ed1\u5411\u540e\u62c9\u8fdc\u5e76\u5411\u5de6\u4fa7\u5448\u5f27\u5f62\u79fb\u52a8\u3002\u968f\u7740\u89c6\u91ce\u9000\u540e\uff0c<Picture 2> \u59cb\u7ec8\u4fdd\u6301\u4e0e\u955c\u5934\u5bf9\u89c6\uff0c\u5e76\u987a\u52bf\u5c06\u53cc\u81c2\u4ea4\u53c9\u62b1\u4e8e\u80f8\u524d\u3002\u6b64\u65f6\u80cc\u666f\u4e2d\u7684\u8f66\u8f86\u8fdb\u5165\u753b\u9762\uff0c\u65c1\u8fb9\u7ad9\u7740\u540c\u6837\u53cc\u81c2\u4ea4\u53c9\u7684 <Picture 3>\u3002\n\n"
        + "8 \u81f3 10 \u79d2\uff1a\n\u955c\u5934\u7ee7\u7eed\u6d41\u7545\u540e\u9000\u5e76\u5411\u5de6\u5e73\u79fb\uff0c\u6700\u7ec8\u5b9a\u683c\u4e3a\u4e00\u4e2a\u7a33\u5b9a\u7684\u5e7f\u89d2\u5168\u666f\u955c\u5934\u3002\u5de6\u4fa7\u7684 <Picture 4> \u9760\u5728\u8f66\u65c1\u6446\u51fa\u9020\u578b\uff0c\u53f3\u4fa7\u7684 <Picture 1> \u7ad9\u5728\u6700\u521d\u7684\u4f4d\u7f6e\u8f6c\u8eab\u770b\u7740\u955c\u5934\uff1b\u4e2d\u95f4\u662f\u6c14\u573a\u5168\u5f00\u7684 <Picture 2>\uff1b<Picture 3> \u7a33\u56fa\u5730\u7ad9\u5728\u4e2d\u5fc3\u4eba\u7269\u7684\u4fa7\u540e\u65b9\u3002\u6240\u6709\u4eba\u56f4\u7ed5\u573a\u666f\u5f62\u6210\u4e00\u4e2a\u6781\u5177\u529b\u91cf\u611f\u7684\u7fa4\u50cf\u5b9a\u683c\uff0c\u52a8\u4f5c\u4e0e\u4f4d\u7f6e\u4e25\u683c\u5bf9\u9f50 <Video 1> \u7684\u7ec8\u5c40\u753b\u9762\u3002\n\n"
        + "\u3010\u9650\u5236\u3011\n"
        + "\u5168\u7a0b\u4fdd\u6301\u6781\u5176\u6d41\u7545\u7684\u4e00\u955c\u5230\u5e95\u62cd\u6444\uff0c\u4eba\u7269\u8d70\u4f4d\u4e0e\u6444\u50cf\u673a\u540e\u9000\u8f68\u8ff9\u5fc5\u987b\u5b8c\u7f8e\u914d\u5408 <Video 1> \u97f3\u8f68\u7684\u8282\u594f\uff0c\u7edd\u5bf9\u7981\u6b62\u4e2d\u9014\u5207\u955c\u5934\u3001\u753b\u9762\u95ea\u70c1\u6216\u4efb\u4f55\u5f62\u5f0f\u7684\u540e\u671f\u8f6c\u573a\uff0c\u753b\u9762\u7981\u6b62\u51fa\u73b0\u4efb\u4f55\u6587\u5b57\u3001\u5b57\u5e55\u4e0e UI \u5143\u7d20\u3002";
      } else if (tplSel.value === "motion") {
        const d = segDur(s).toFixed(1);
        const d1 = (Math.max(1, segDur(s) / 2)).toFixed(1);
        tpl = "\u3010\u7d20\u6750\u5173\u7cfb\u5206\u914d\u3011\u5168\u5c40\u52a8\u4f5c\u3001\u59ff\u6001\u3001\u8fd0\u955c\u4e0e\u8282\u594f\u5b8c\u5168\u590d\u523b\u53c2\u8003\u89c6\u9891 <Video 1>\uff1b<Video 1> \u4e2d\u7684\u89d2\u8272/\u4e3b\u4f53 100% \u66ff\u6362\u4e3a <Picture 1>\uff08\u5916\u8c8c\u7a7f\u7740\u4e0e\u753b\u9762\u4e25\u683c\u6309\u53c2\u8003\u56fe\uff09\u3002\n"
          + "\u3010\u753b\u9762\u7f8e\u5b66\u4e0e\u8d28\u611f\u3011<\u98ce\u683c/\u5149\u7ebf/\u573a\u666f\u6c1b\u56f4/\u6750\u8d28>\u3002\n"
          + "\u3010\u8be6\u7ec6\u65f6\u95f4\u7ebf\u8c03\u5ea6\u30110 \u81f3 " + d1 + " \u79d2\uff1a<\u52a8\u4f5c/\u59ff\u6001 1\uff0c\u7167\u53c2\u8003\u89c6\u9891\u5199>\uff1b" + d1 + " \u81f3 " + d + " \u79d2\uff1a<\u52a8\u4f5c/\u59ff\u6001 2>\uff0c\u7ed3\u5c3e\u4e0e <Video 1> \u7684\u7ec8\u5c40\u753b\u9762\u4e00\u81f4\u3002\n"
          + "\u3010\u9650\u5236\u3011\u5168\u7a0b\u4e00\u955c\u5230\u5e95\uff0c\u4eba\u7269\u59ff\u6001\u4e0e <Video 1> \u9010\u5e27\u5bf9\u9f50\uff0c\u7981\u6b62\u4efb\u4f55\u8f6c\u573a\u3001\u753b\u9762\u95ea\u70c1\u3001\u5b57\u5e55\u4e0e\u5c4f\u5e55\u6587\u5b57\u3002";
      }
      else if (tplSel.value === "story") {
        tpl = "画面背景环境与光影基调完全采用 <Picture 2> 中的<场景/环境>。画面的视觉中心是 <Picture 1> 中的<主体>，他正站在<位置>，手中<动作>着 <Picture 3> 所示的<道具>。镜头<运镜方式，如：环绕角色进行 360 度运镜>，展示<主体><情绪或动作>。全程一镜到底，照片级写实，禁止文字与字幕。";
      } else if (tplSel.value === "voice") {
        tpl = "生成一段 <时长> 秒、原生带声的短片。\n"
          + "人物与画面：在<场景>中，摄影机采用固定中近景双人同框镜头。画面中央明确展示出人物A <Picture 1> 与人物B <Picture 2> 正在面对面交谈。\n"
          + "动作与声音设计：影片起势，人物A <Picture 1> 看着对方，<微表情/动作>。人物A的嗓音严格参考 <Audio 1> 的音色，说：「<台词A>」；紧接着，人物B <Picture 2> <反应动作>。人物B的对白严格参考 <Audio 2> 的音色，反问：「<台词B>」；最后保留 0.5 秒人物A <收尾表情> 的余波。\n"
          + "剪辑与视觉：镜头全程保持单机位连续跟随，不发生硬切。背景适度虚化，将视觉焦点与情绪张力集中在两人的面部表情与眼神交锋上。除两人的对白外，环境保持绝对静音。";
      }
      tplSel.value = "";
      if (!tpl) return;
      vta.value = tpl;
      s.prompt = tpl;
      save();
      vta.focus();
      status.textContent = "\u6a21\u677f\u5df2\u63d2\u5165\uff0c\u628a <...> \u5360\u4f4d\u6362\u6210\u4f60\u7684\u5185\u5bb9\uff08\u79d2\u6570\u6309\u53c2\u8003\u89c6\u9891\u957f\u5ea6\u8c03\u6574\uff09";
    });
    tplRow.appendChild(tplSel);
    /* 清空提示词（v2.10.6） */
    const btnClear = mk("button", "h3s-btn", "清空");
    btnClear.title = "清空当前提示词";
    btnClear.addEventListener("click", () => {
      vta.value = "";
      s.prompt = "";
      save();
      vta.focus();
      status.textContent = "提示词已清空";
    });
    tplRow.appendChild(btnClear);
    editor.appendChild(tplRow);
    vta.style.cssText += "flex:none;width:100%;height:84px;";
    editor.appendChild(vta);

    if (!SHOW_SAVED_SEGMENT_PREVIEW || node.properties.h3_segment_preview_hidden === true) { autoFitCompactPanel(); return; }
    /* ======== ⑥ 成片预览（v2.8，与创作界面同款：可拖大 + 放大查看）======== */
    const pvWrap = mk("div", "h3s-pv");
    pvWrap.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:240px;gap:4px;";
    editor.appendChild(pvWrap);
    (async () => {
      const selectedSegment = sel;
      const shouldAutoPlay = autoPlaySegment === selectedSegment;
      if (shouldAutoPlay) autoPlaySegment = null;
      let src = null;
      if (shouldAutoPlay) {
        // 不先 await 状态接口，确保 play() 仍在点击段卡片的用户手势中执行。
        src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + Date.now());
      } else {
        try {
          const st = await (await api.fetchApi("/h3director/status?" + _modeQ())).json();
          const info = st.segments && st.segments[String(selectedSegment + 1)];
          if (info && info.video) {
            src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + (info.mtime || Date.now()));
          }
        } catch (e) { /* 路由不可用时静默降级 */ }
      }
      if (!src) {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.appendChild(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频，运行后可在此预览。"));
        return;
      }
      const headRow = mk("div", "h3s-row");
      headRow.appendChild(mk("div", "h3s-hint", "段" + (sel + 1) + " 成片预览："));
      const zoom = mk("button", "h3s-btn", "放大查看");
      zoom.title = "新窗口打开，原生分辨率播放";
      zoom.addEventListener("click", () => window.open(src, "_blank"));
      headRow.appendChild(zoom);
      const hidePreview = mk("button", "h3s-btn", "隐藏播放器");
      hidePreview.title = "隐藏播放器并收起预览区域";
      hidePreview.addEventListener("click", hideSegmentPreview);
      headRow.appendChild(hidePreview);
      headRow.appendChild(mk("span", "h3s-hint", "拖预览框右下角可自由缩放"));
      pvWrap.appendChild(headRow);
      const pvBox = mk("div", "h3s-pvbox");
      pvBox.style.flex = "1";
      pvBox.style.minHeight = "200px";
      const v = document.createElement("video");
      v.src = src;
      v.controls = true;
      v.preload = "metadata";
      v.addEventListener("error", () => {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.replaceChildren(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频。"));
      }, { once: true });
      pvBox.appendChild(v);
      pvWrap.appendChild(pvBox);
      attachBottomBar(pvBox, 240, 135);
      if (shouldAutoPlay) {
        v.autoplay = true;
        v.play().catch(() => { /* 浏览器限制时保留原生播放按钮 */ });
      }
    })();
  }

  /* ================= 文本界面（v2.11 独立整版；v2.12 支持共用参考图）=================
     纯提示词生成：可上传共用参考图（所有段一致）；无参考视频/配音/音色，全部交给 H3 按提示词原生生成。
     顶部脚本文本框：粘贴带时间标记的分镜文本 →「解析导入」自动拆段、
     按标记设每段时长、把对应正文写进每段提示词。数据独立（tsegments_json），
     产出文件名独立（漫剧t_/tailt_）。 */
  function appendBulkPromptEditor() {
    /* ======== 全段提示词：按分隔符批量分发到当前激活界面的已有片段 ======== */
    if (node.properties.h3_full_segment_prompt_open === true) {
      const bulkWrap = mk("div", "h3s-slrow");
      bulkWrap.style.cssText = "display:block;margin:2px 0 6px;padding:7px;border:1px solid #315a7e;border-radius:7px;background:#151d26;";
      bulkWrap.appendChild(mk("div", "h3s-hint",
        "全段提示词：用下方分隔符划分每一段；“分配提示词”会从第 1 段开始，填入当前激活界面的现有片段。"));
      const separatorRow = mk("div", "h3s-row");
      separatorRow.style.marginTop = "5px";
      separatorRow.appendChild(mk("span", "h3s-hint", "分段分隔符"));
      const separatorInput = mk("input", "h3s-durinput");
      separatorInput.type = "text";
      separatorInput.style.width = "160px";
      separatorInput.value = String(node.properties.h3_full_segment_separator ?? "===");
      separatorInput.placeholder = "===";
      separatorInput.title = "默认 ===；留空时整份文本视为一组";
      separatorInput.addEventListener("input", () => {
        node.properties.h3_full_segment_separator = separatorInput.value;
        syncPromptAssignmentControls();
        save();
      });
      separatorRow.appendChild(separatorInput);
      separatorRow.appendChild(mk("span", "h3s-hint", "例如：第 1 段 === 第 2 段 === 第 3 段"));
      bulkWrap.appendChild(separatorRow);

      const bulkTa = mk("textarea", "h3s-ta");
      bulkTa.placeholder = "在此粘贴全段提示词。每一组会按顺序填入当前激活界面的第 1、2、3… 段。";
      bulkTa.value = String(node.properties.h3_full_segment_prompt || "");
      bulkTa.style.cssText += "flex:none;height:180px;min-height:100px;margin-top:5px;";
      const savedBulkSize = node.properties.h3_full_segment_prompt_size;
      if (Array.isArray(savedBulkSize)) {
        const [width, height] = savedBulkSize.map(Number);
        if (Number.isFinite(width) && width >= 300) bulkTa.style.width = width + "px";
        if (Number.isFinite(height) && height >= 100) bulkTa.style.height = height + "px";
      }
      bulkTa.addEventListener("input", () => {
        node.properties.h3_full_segment_prompt = bulkTa.value;
        syncPromptAssignmentControls();
        save();
      });
      bulkWrap.appendChild(bulkTa);
      attachBottomBar(bulkTa, 300, 100, (width, height, finished) => {
        node.properties.h3_full_segment_prompt_size = [Math.round(width), Math.round(height)];
        if (finished) save();
      });
      editor.appendChild(bulkWrap);
    }
  }

  function renderTextEditor(s) {

    /* ======== ⓪ 分镜脚本导入区（页面级：文本存 node.properties 随工作流保存）======== */
    editor.appendChild(mk("div", "h3s-hint",
      "分镜脚本（支持 MiniMax H3 官方 Base integrated_multimodal_description 与官方 Ref2VA 六字段模板；整篇无标记长文自动按 8~15 秒智能分段）："));
    const scriptTa = mk("textarea", "h3s-ta");
    scriptTa.style.cssText += "flex:none;height:120px;";
    scriptTa.placeholder = "把 MiniMax H3 官方模板粘到这里，点「解析导入」。\n官方 Base：integrated_multimodal_description + overall_soundscape + non_diegetic_music\n官方 Ref2VA：subject_definitions + summary + retention_analysis + detailed_description + 两个声音字段\n约 1 分钟的官方时间线会自动拆成不超过 15 秒的生成段。";
    scriptTa.value = node.properties.h3_text_script || "";
    scriptTa.addEventListener("input", () => {
      node.properties.h3_text_script = scriptTa.value;  // 随工作流保存，不走 segments
    });
    editor.appendChild(scriptTa);
    attachBottomBar(scriptTa, 240, 60);

    const scRow = mk("div", "h3s-row");
    const btnParse = mk("button", "h3s-btn primary", "⚡ 解析导入");
    btnParse.title = "识别旧分段脚本或 MiniMax H3 官方 Base / Ref2VA 模板，自动设置时长并导入（替换当前全部段）";
    /* 覆盖确认用两段式按钮（第一次点变红"再点确认"），不用 confirm()——
       ComfyUI 内嵌浏览器静默拦截 confirm/alert，点了"没反应"（审查清单硬性规则） */
    let parseArmed = false;
    const disarmParse = () => {
      parseArmed = false;
      btnParse.textContent = "⚡ 解析导入";
      btnParse.style.background = "";
      btnParse.style.borderColor = "";
    };
    btnParse.addEventListener("click", () => {
      const txt = scriptTa.value;
      if (!txt.trim()) { status.textContent = "脚本框是空的，先粘贴分镜文本"; return; }
      const parsed = parseScript(txt);
      if (!parsed.length) { status.textContent = "没有识别到任何内容"; return; }
      const hasContent = textSegs.some((x) => (x.prompt || "").trim());
      if (hasContent && !parseArmed) {
        parseArmed = true;
        btnParse.textContent = "将替换当前 " + textSegs.length + " 段，再点确认";
        btnParse.style.background = "#8a2f2f";
        btnParse.style.borderColor = "#c05555";
        const parsedType = parsed.official ? "（" + (parsed.officialLabel || "官方模板") + "）" : "";
        const parsedWarn = (parsed.warnings || []).length ? "；⚠ " + parsed.warnings.slice(0, 2).join("；") : "";
        status.textContent = "解析出 " + parsed.length + " 段" + parsedType + "；确认覆盖请再点一次红色按钮" + parsedWarn;
        return;
      }
      disarmParse();
      const _durW = node.widgets.find((w) => w.name === "时长秒");
      const _defDur = _durW ? (Number(_durW.value) || 10) : 10;
      /* 原地替换数组内容（segs 是指向 textSegs 的引用，重新赋值会断链） */
      textSegs.length = 0;
      parsed.forEach((p, i) => {
        textSegs.push({
          prompt: p.prompt,
          seed: Math.floor(Math.random() * 1e15),
          refs: [],
          ...defaultResolutionFields(),
          duration: p.duration > 0 ? p.duration : clampDur(_defDur),
          inherit_shared: true,
          use_tail: false,
          motion_context: false,
          motion_context_source: "local_latent",
          motion_context_index: i,
          enabled: true,
          force: false,
        });
      });
      /* v2.13.2：解析时自动抽出共享常量填进全局框（仅当全局框为空，不覆盖手填内容）
         v2.13.5：官方 Shot 格式带 globalStyle（Shot1 风格句）+ globalExtra（音效/配乐字段），优先入全局框；
         全局框已有内容时只追加音效/配乐（按 Soundscape: 判重），不覆盖手填 */
      let autoGlobalNote = "";
      if (gpCb.checked) {
        const gExisting = (globalPromptWidget && globalPromptWidget.value || "").trim();
        const offStyle = parsed.globalStyle || "";
        const offExtra = parsed.globalExtra || "";
        const lastAuto = String(node.properties.h3_text_auto_global_value || "").trim();
        const canUpgradeAuto = !!gExisting && !!offStyle
          && ((lastAuto && gExisting === lastAuto)
            || (gExisting.length >= 24 && gExisting.length < offStyle.length
              && offStyle.toLowerCase().includes(gExisting.toLowerCase())));
        const setGlobal = (v) => { if (globalPromptWidget) globalPromptWidget.value = v; gpTaT.value = v; };
        if (parsed.officialFormat === "ref2va" && !offStyle && !offExtra) {
          if (gExisting && lastAuto && gExisting === lastAuto) {
            setGlobal("");
            node.properties.h3_text_auto_global_value = "";
            autoGlobalNote = "；Ref2VA 六字段已逐段保留，已清除上一份自动全局提示词";
          } else {
            autoGlobalNote = gExisting
              ? "（Ref2VA 每段已自包含；全局框为手填内容，未覆盖）"
              : "；Ref2VA 六字段已逐段完整保留，无需重复全局提示词";
          }
        } else if (!gExisting || canUpgradeAuto) {
          /* v2.13.8：官方单段（≤15s）已自包含（风格+音效都在段提示词里），offStyle/offExtra 为空，
             此时不能再走 extractGlobalPrompt 兜底（它会把整段提示词误塞进全局框）——官方格式跳过兜底 */
          const joined = [offStyle, offExtra].filter(Boolean).join("\n\n");
          const g = joined || (parsed.official ? "" : extractGlobalPrompt(parsed));
          if (g) {
            setGlobal(g);
            node.properties.h3_text_auto_global_value = g;
            autoGlobalNote = canUpgradeAuto
              ? "；已升级自动全局提示词（风格/角色/一致性/限制）"
              : "；已自动提取共享提示词到全局框";
          }
        } else if (offExtra && !/soundscape\s*[:：]/i.test(gExisting)) {
          const appended = gExisting + "\n\n" + offExtra;
          setGlobal(appended);
          if (lastAuto && gExisting === lastAuto) node.properties.h3_text_auto_global_value = appended;
          autoGlobalNote = "；已把音效/配乐字段追加到全局框";
        } else {
          autoGlobalNote = "（全局框已有内容，未覆盖）";
        }
      }
      sel = 0;
      clearBoxSel();
      save(); renderTimeline(); renderEditor();
      const total = textSegs.reduce((a, x) => a + segDur(x), 0);
      const parsedType = parsed.official ? "（" + (parsed.officialLabel || "官方模板") + "）" : "";
      const parsedWarn = (parsed.warnings || []).length ? "；⚠ " + parsed.warnings.slice(0, 2).join("；") : "";
      status.textContent = "已解析 " + textSegs.length + " 段" + parsedType + "，总 " + total.toFixed(1) + "s（逐段检查提示词后再运行）" + autoGlobalNote + parsedWarn;
    });
    /* v2.13.11：「导入到当前段」——解析脚本只替换当前选中的那段（解析出多段则在该位置顺次插入），
       其它段保持不变；与「⚡ 解析导入」（整批替换）互补。单击生效（只动当前段，非整批，不需两段式确认）。 */
    const btnParseCur = mk("button", "h3s-btn", "📥 导入到当前段");
    btnParseCur.title = "解析脚本，只把内容导入到当前选中的段（会覆盖该段提示词；多段则插在该位置），其它段保持不变";
    btnParseCur.addEventListener("click", () => {
      const txt = scriptTa.value;
      if (!txt.trim()) { status.textContent = "脚本框是空的，先粘贴分镜文本"; return; }
      const parsed = parseScript(txt);
      if (!parsed.length) { status.textContent = "没有识别到任何内容"; return; }
      const _durW = node.widgets.find((w) => w.name === "时长秒");
      const _defDur = _durW ? (Number(_durW.value) || 10) : 10;
      const newSegs = parsed.map((p, i) => ({
        prompt: p.prompt,
        seed: Math.floor(Math.random() * 1e15),
        refs: [],
        ...defaultResolutionFields(),
        duration: p.duration > 0 ? p.duration : clampDur(_defDur),
        inherit_shared: true,
        use_tail: false,
        motion_context: false,
        motion_context_source: "local_latent",
        motion_context_index: sel + i,
        enabled: true,
        force: false,
      }));
      /* 自动提取共享提示词到全局框（仅当全局框为空），与整批导入同一套 */
      let autoGlobalNote = "";
      if (gpCb.checked) {
        const gExisting = (globalPromptWidget && globalPromptWidget.value || "").trim();
        const offStyle = parsed.globalStyle || "";
        const offExtra = parsed.globalExtra || "";
        const lastAuto = String(node.properties.h3_text_auto_global_value || "").trim();
        const canUpgradeAuto = !!gExisting && !!offStyle
          && ((lastAuto && gExisting === lastAuto)
            || (gExisting.length >= 24 && gExisting.length < offStyle.length
              && offStyle.toLowerCase().includes(gExisting.toLowerCase())));
        const setGlobal = (v) => { if (globalPromptWidget) globalPromptWidget.value = v; gpTaT.value = v; };
        if (parsed.officialFormat === "ref2va" && !offStyle && !offExtra) {
          if (gExisting && lastAuto && gExisting === lastAuto) {
            setGlobal("");
            node.properties.h3_text_auto_global_value = "";
            autoGlobalNote = "；Ref2VA 六字段已逐段保留，已清除上一份自动全局提示词";
          } else {
            autoGlobalNote = gExisting
              ? "（Ref2VA 每段已自包含；全局框为手填内容，未覆盖）"
              : "；Ref2VA 六字段已逐段完整保留，无需重复全局提示词";
          }
        } else if (!gExisting || canUpgradeAuto) {
          const joined = [offStyle, offExtra].filter(Boolean).join("\n\n");
          const g = joined || (parsed.official ? "" : extractGlobalPrompt(parsed));
          if (g) {
            setGlobal(g);
            node.properties.h3_text_auto_global_value = g;
            autoGlobalNote = canUpgradeAuto
              ? "；已升级自动全局提示词（风格/角色/一致性/限制）"
              : "；已自动提取共享提示词到全局框";
          }
        } else if (offExtra && !/soundscape\s*[:：]/i.test(gExisting)) {
          const appended = gExisting + "\n\n" + offExtra;
          setGlobal(appended);
          if (lastAuto && gExisting === lastAuto) node.properties.h3_text_auto_global_value = appended;
          autoGlobalNote = "；已把音效/配乐字段追加到全局框";
        }
      }
      /* 在当前位置替换：移除当前 1 段，原位插入 newSegs，其它段不动 */
      const at = Math.max(0, Math.min(sel, textSegs.length - 1));
      newSegs[0].use_tail = at > 0;   // 插到首位则无尾帧可续
      textSegs.splice(at, 1, ...newSegs);
      sel = at;
      clearBoxSel();
      save(); renderTimeline(); renderEditor();
      const parsedType = parsed.official ? "；识别为" + (parsed.officialLabel || "官方模板") : "";
      const parsedWarn = (parsed.warnings || []).length ? "；⚠ " + parsed.warnings.slice(0, 2).join("；") : "";
      status.textContent = "已把 " + newSegs.length + " 段导入到第 " + (at + 1) + " 段（其余 " + (textSegs.length - newSegs.length) + " 段保持不变）" + parsedType + autoGlobalNote + parsedWarn;
    });
    const btnLoad = mk("button", "h3s-btn", "📂 载入文本");
    btnLoad.title = "从本地 .txt 文件加载分镜脚本，载入后自动执行解析导入";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".txt,text/plain";
    fileInput.style.display = "none";
    btnLoad.addEventListener("click", () => { fileInput.click(); });
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const txt = await file.text();
        scriptTa.value = txt;
        node.properties.h3_text_script = txt;
        status.textContent = "已载入 " + file.name + "，准备解析…";
        btnParse.click();
      } catch (err) {
        status.textContent = "载入失败：" + err.message;
      }
      fileInput.value = "";
    });
    /* 模板库下拉（v2.13.6）：MiniMax 官方 10 个 SKILL 模板蒸馏成 9 套骨架（规范 1 + 风格 8）。
       沿用既有"点选即插入、选完复位"的 select 惯例（同视频界面 tplSel）；
       只写脚本文本框（真正的段替换由「解析导入」的两段式确认把守），全局框为空时才填风格签名 */
    const libSel = document.createElement("select");
    libSel.title = "官方/风格模板库：点选把该模板的分镜骨架填进脚本框（【】换成你的内容后点「解析导入」）；全局提示词框为空时同时填入该风格签名";
    {
      const groups = [];
      for (const t of H3_TEXT_TEMPLATES) if (!groups.includes(t.group)) groups.push(t.group);
      libSel.innerHTML = '<option value="">📚 模板库…</option>'
        + groups.map((g) => '<optgroup label="' + g + '">'
          + H3_TEXT_TEMPLATES.filter((t) => t.group === g)
              .map((t) => '<option value="' + t.id + '">' + t.name + "</option>").join("")
          + "</optgroup>").join("");
    }
    libSel.addEventListener("change", () => {
      const t = H3_TEXT_TEMPLATES.find((x) => x.id === libSel.value);
      libSel.value = "";
      if (!t) return;
      scriptTa.value = t.script;
      node.properties.h3_text_script = t.script;
      let note = "模板「" + t.name + "」已填入脚本框，【】占位换成你的内容后点「⚡ 解析导入」";
      if (t.global) {
        const gExisting = (globalPromptWidget && globalPromptWidget.value || "").trim();
        if (!gExisting) {
          if (globalPromptWidget) globalPromptWidget.value = t.global;
          gpTaT.value = t.global;
          note += "；风格签名已填入全局框";
        } else {
          note += "（全局框已有内容，风格签名未填入）";
        }
      }
      status.textContent = note;
    });
    const btnClearScript = mk("button", "h3s-btn", "清空脚本");
    btnClearScript.addEventListener("click", () => {
      scriptTa.value = "";
      node.properties.h3_text_script = "";
    });
    scRow.append(btnParse, btnParseCur, btnLoad, libSel, btnClearScript,
      mk("span", "h3s-hint", "时长自动吸附模型对齐档位（≈±0.3s），超过 15 秒的段会截到 15 秒"));
    editor.appendChild(scRow);

    /* 全局提示词（v2.12）：注入到每一段开头，保持风格/角色/场景一致性 */
    const gpRowT = mk("div", "h3s-row");
    gpRowT.style.flexDirection = "column";
    gpRowT.style.alignItems = "stretch";
    const gpHeadT = mk("div", "h3s-row");
    gpHeadT.style.cssText += "justify-content:space-between;align-items:center;";
    gpHeadT.appendChild(mk("div", "h3s-hint", "全局提示词（注入到每一段开头）："));
    /* 一键全部清空——分镜脚本 + 全局提示词 + 全部分段，回到空白状态录新剧本。
       两段式红按钮，不用 confirm。 */
    const btnGpClearT = mk("button", "h3s-btn", "全部清空");
    btnGpClearT.title = "清空分镜脚本 + 全局提示词 + 全部分段，重置为 1 个空白段（成片文件保留）";
    let gpClearArmedT = false;
    const disarmGpClearT = () => {
      gpClearArmedT = false;
      btnGpClearT.textContent = "全部清空";
      btnGpClearT.style.background = "";
      btnGpClearT.style.borderColor = "";
    };
    btnGpClearT.addEventListener("click", () => {
      const hasAnything = !!scriptTa.value.trim() || !!gpTaT.value.trim()
        || textSegs.length > 1 || textSegs.some((x) => (x.prompt || "").trim());
      if (!hasAnything) { disarmGpClearT(); status.textContent = "脚本 / 全局提示词 / 分段都已是空的"; return; }
      if (!gpClearArmedT) {
        gpClearArmedT = true;
        btnGpClearT.textContent = "再点确认全部清空";
        btnGpClearT.style.background = "#8a2f2f";
        btnGpClearT.style.borderColor = "#c05555";
        status.textContent = "将清空：分镜脚本 + 全局提示词 + 全部 " + textSegs.length + " 段，再点一次红色按钮确认";
        return;
      }
      disarmGpClearT();
      scriptTa.value = "";
      node.properties.h3_text_script = "";
      if (globalPromptWidget) globalPromptWidget.value = "";
      node.properties.h3_text_auto_global_value = "";
      /* 原地重置分段为 1 个空白段（textSegs 是引用，重新赋值会断链） */
      textSegs.length = 0;
      textSegs.push(defaultTextSegs()[0]);
      sel = 0;
      save(); renderTimeline(); renderEditor();
      status.textContent = "已全部清空：脚本 + 全局提示词 + 分段（成片文件保留在 output 目录）";
    });
    gpHeadT.appendChild(btnGpClearT);
    gpRowT.appendChild(gpHeadT);
    const gpChk = mk("label", "h3s-chk");
    gpChk.style.cssText = "display:flex;align-items:center;gap:5px;font-size:11px;color:#9aa4b2;margin:2px 0 4px;";
    const gpCb = document.createElement("input");
    gpCb.type = "checkbox";
    gpCb.checked = node.properties.h3_text_auto_global !== "0";   // 默认勾选
    gpCb.addEventListener("change", () => { node.properties.h3_text_auto_global = gpCb.checked ? "1" : "0"; });
    gpChk.appendChild(gpCb);
    gpChk.appendChild(mk("span", null, "解析时自动提取共享提示词到全局框（风格/角色/场景/No subtitles）"));
    gpRowT.appendChild(gpChk);
    const gpTaT = mk("textarea", "h3s-ta");
    gpTaT.style.cssText += "flex:none;height:50px;";
    gpTaT.placeholder = "所有段共用的风格/角色/场景描述，例如：Pixar 3D cartoon, warm lighting, no subtitles...";
    gpTaT.value = (globalPromptWidget && globalPromptWidget.value) || "";
    gpTaT.addEventListener("input", () => {
      if (globalPromptWidget) globalPromptWidget.value = gpTaT.value;
      node.properties.h3_text_auto_global_value = "";
    });
    gpRowT.appendChild(gpTaT);
    editor.appendChild(gpRowT);

    /* ======== ① 段信息行：启用 / 时长 / 帧率 / 种子 / 分辨率 / 续接尾帧 ======== */
    const row0 = mk("div", "h3s-row");
    row0.appendChild(mk("b", null, `段 ${sel + 1}`));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.title = "启用本段（取消勾选则运行时跳过）";
    cb.addEventListener("change", () => { s.enabled = cb.checked; save(); renderTimeline(); });
    row0.appendChild(cb);
    row0.appendChild(mk("span", null, "启用"));
    appendResolutionControls(row0, s);
    row0.appendChild(mk("span", "h3s-hint", "时长（秒）："));
    const din = mk("input", "h3s-durinput");
    din.type = "number";
    din.step = "0.5";
    din.min = "1.6";
    din.max = "15";
    din.value = segDur(s).toFixed(1);
    din.title = "本段时长（每段独立；也可在时间轴上拖段块右缘调整）。手动调整范围 " + (manualBounds()[0] / 24).toFixed(1) + "~" + (manualBounds()[1] / 24).toFixed(1) + "s（见下方「时长范围」设置）";
    din.addEventListener("change", () => {
      s.duration = clampManual(Number(din.value) || segDur(s));
      din.value = s.duration.toFixed(1);
      save(); renderTimeline();
    });
    durInput = din;
    const stepDur = (d) => {
      s.duration = clampManual((Number(din.value) || segDur(s)) + d);
      din.value = s.duration.toFixed(1);
      save(); renderTimeline();
    };
    const btnMinus = mk("button", "h3s-btn", "−");
    const btnPlus = mk("button", "h3s-btn", "＋");
    btnMinus.title = btnPlus.title = "每次 0.5 秒";
    btnMinus.addEventListener("click", () => stepDur(-0.5));
    btnPlus.addEventListener("click", () => stepDur(0.5));
    row0.appendChild(din);
    row0.appendChild(btnMinus);
    row0.appendChild(btnPlus);
    /* 帧率恒为 H3 原生 24；分辨率改由本段上方 Resolution Selector 独立计算。 */
    /* 种子：-1=每次随机；🎲 固定一个随机种子复刻同款 */
    row0.appendChild(mk("span", "h3s-hint", "种子"));
    const seedModeSel = mk("select", "h3s-seedmode");
    [["current", "当段随机"], ["all_diff", "全段各自随机"], ["all_same", "全段统一随机"]].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      seedModeSel.appendChild(o);
    });
    seedModeSel.value = node.properties.h3_seed_mode || "current";
    seedModeSel.title = "🎲 随机范围：当段=只随机当前段；全段各自=每段一个不同新种子；全段统一=所有段用同一个新种子";
    seedModeSel.addEventListener("change", () => {
      node.properties.h3_seed_mode = seedModeSel.value;
      save();
    });
    const seedIn = mk("input", "h3s-seed");
    seedIn.type = "number";
    seedIn.value = String(s.seed != null ? s.seed : -1);
    seedIn.placeholder = "-1=随机";
    seedIn.title = "-1=每次随机；填固定值=复刻同款结果";
    seedIn.addEventListener("change", () => { s.seed = Number(seedIn.value); save(); });
    const btnDice = mk("button", "h3s-btn", "🎲");
    btnDice.title = "按左侧选择的范围随机种子";
    btnDice.addEventListener("click", () => {
      const mode = node.properties.h3_seed_mode || "current";
      if (mode === "all_diff") {
        segs.forEach((seg) => { seg.seed = Math.floor(Math.random() * 1e15); });
        seedIn.value = String(s.seed);
        status.textContent = "全部 " + segs.length + " 段已各自随机新种子";
      } else if (mode === "all_same") {
        const newSeed = Math.floor(Math.random() * 1e15);
        segs.forEach((seg) => { seg.seed = newSeed; });
        seedIn.value = String(s.seed);
        status.textContent = "全部 " + segs.length + " 段已统一为种子: " + newSeed;
      } else {
        s.seed = Math.floor(Math.random() * 1e15);
        seedIn.value = String(s.seed);
        status.textContent = "新种子: " + s.seed;
      }
      save();
    });
    row0.appendChild(seedModeSel);
    row0.appendChild(seedIn);
    row0.appendChild(btnDice);
    /* 文本界面续接方式：尾帧与 MotionContext 二选一。 */
    const continuityBlocked = segmentContinuityBlocked(segs, sel);
    const cbTail = document.createElement("input");
    const continuityName = `h3-cont-${node.id}-text-${sel}`;
    cbTail.type = "checkbox";
    cbTail.name = continuityName;
    cbTail.checked = !continuityBlocked && s.use_tail === true;
    cbTail.disabled = continuityBlocked;
    cbTail.title = continuityBlocked ? "本段与上段分辨率不同，禁止续接尾帧" : "续接上段尾帧；选择后自动关闭 MotionContext，也可再次取消";
    cbTail.addEventListener("change", () => {
      s.use_tail = cbTail.checked;
      if (cbTail.checked) s.motion_context = false;
      save(); renderEditor();
    });
    row0.appendChild(cbTail);
    const tailLab = mk("span", null, "续接上段尾帧");
    if (continuityBlocked) tailLab.style.opacity = "0.45";
    row0.appendChild(tailLab);
    const cbMotion = document.createElement("input");
    cbMotion.type = "checkbox";
    cbMotion.name = continuityName;
    cbMotion.checked = !continuityBlocked && s.motion_context === true;
    cbMotion.disabled = false;
    cbMotion.title = continuityBlocked ? "勾选后自动同步上段的宽高比、分辨率和帧率，再开启 MotionContext" : "选择后自动关闭尾帧续接；同时同步上段的宽高比、分辨率和帧率";
    cbMotion.addEventListener("change", () => {
      s.motion_context = cbMotion.checked;
      if (cbMotion.checked) {
        const synced = syncSegmentToPrevious(segs, sel);
        s.use_tail = false;
        if (!Number.isFinite(Number(s.motion_context_index)) || Number(s.motion_context_index) < 0) {
          s.motion_context_index = sel;
        }
        if (synced) status.textContent = `MotionContext 已开启：本段已同步为 ${synced[0]}×${synced[1]} / ${synced[2]}fps`;
      }
      save(); renderEditor();
    });
    row0.appendChild(cbMotion);
    const motionLab = mk("span", null, "MotionContext");
    row0.appendChild(motionLab);
    if (continuityBlocked) row0.appendChild(mk("span", "h3s-audio-warn", "尾帧续接已禁用；勾选 MotionContext 会自动同步上段尺寸和帧率"));
    appendLocalMotionIndex(row0, s, sel);
    editor.appendChild(row0);

    /* ======== ② 本段提示词 ======== */
    const prRow = mk("div", "h3s-row");
    prRow.appendChild(mk("span", "h3s-hint", "提示词（纯文本生成；可点右侧 ✨ AI，把一句创意扩写成完整时间轴提示词）："));
    const btnClearP = mk("button", "h3s-btn", "清空");
    btnClearP.title = "清空本段提示词";
    const btnTextAI = mk("button", "h3s-btn", "✨ AI");
    btnTextAI.title = "使用已保存的远程 API 生成或改写当前文本段提示词";
    prRow.append(btnClearP, btnTextAI);
    editor.appendChild(prRow);
    const pta = mk("textarea", "h3s-ta");
    pta.value = s.prompt || "";
    pta.placeholder = "本段提示词：画面/人物/动作/运镜/台词/音效全用文字描述。时间轴分镜用 [0s-3s] 标签，结尾可写 Final frame: …";
    pta.addEventListener("input", () => { s.prompt = pta.value; save(); });
    btnClearP.addEventListener("click", () => {
      pta.value = ""; s.prompt = ""; save(); pta.focus();
      status.textContent = "段" + (sel + 1) + " 提示词已清空";
    });
    editor.appendChild(pta);
    attachBottomBar(pta, 240, 60);
    appendGuideTrack(s, "文本");

    /* 文本界面 AI：和创作界面共用同一份后端 API 配置，但只发送当前段草稿、
       全局提示词和可选的上段尾帧；生成结果直接写回当前文本段。 */
    let textAiPanel = null;
    btnTextAI.addEventListener("click", async () => {
      if (textAiPanel) { textAiPanel.remove(); textAiPanel = null; return; }
      textAiPanel = mk("div", "h3s-slrow");
      textAiPanel.style.flexWrap = "wrap";
      const openedPanel = textAiPanel;
      const modeSel = document.createElement("select");
      modeSel.innerHTML = '<option value="smart">智能生成</option>'
        + '<option value="compose">编写模式</option>';
      modeSel.value = localStorage.getItem("h3_text_ai_mode") || "smart";
      modeSel.title = "智能生成：允许 AI 完善创意；编写模式：严格按当前草稿转换，不增删情节";
      modeSel.addEventListener("change", () => localStorage.setItem("h3_text_ai_mode", modeSel.value));
      const apiInfo = mk("span", "h3s-hint", "正在读取 API 配置…");
      const btnTextTest = mk("button", "h3s-btn", "测试连接");
      const btnTextGenerate = mk("button", "h3s-btn primary", "生成到本段");
      const setTextAiError = (message) => {
        apiInfo.textContent = message;
        apiInfo.style.color = "#ff8080";
      };
      const loadTextApiInfo = async () => {
        const resp = await api.fetchApi("/h3director/api_config");
        const cfg = await resp.json();
        if (!resp.ok) throw new Error(cfg.error || ("HTTP " + resp.status));
        let host = cfg.base_url || "";
        try { host = new URL(host).host; } catch (e) { /* 保留原地址 */ }
        apiInfo.style.color = "";
        apiInfo.textContent = cfg.configured
          ? "已配置：" + cfg.model + (host ? " · " + host : "")
          : "尚未配置 API，请先在创作界面的 ✨ AI 中保存设置";
        return cfg;
      };
      btnTextTest.addEventListener("click", async () => {
        btnTextTest.disabled = true;
        apiInfo.textContent = "正在测试 API 连接…";
        try {
          const resp = await api.fetchApi("/h3director/api_test", { method: "POST" });
          const result = await resp.json();
          if (!resp.ok || !result.ok) throw new Error(result.error || ("HTTP " + resp.status));
          apiInfo.style.color = "";
          apiInfo.textContent = "连接成功（" + result.model + "）";
        } catch (error) {
          setTextAiError("连接失败：" + error.message);
        }
        btnTextTest.disabled = false;
      });
      btnTextGenerate.addEventListener("click", async () => {
        const draft = pta.value.trim();
        if (!draft) {
          setTextAiError("先在“本段提示词”框写一句创意或大白话分镜，再点生成");
          pta.focus();
          return;
        }
        btnTextGenerate.disabled = true;
        apiInfo.style.color = "";
        apiInfo.textContent = "AI 正在生成当前文本段提示词…";
        try {
          const hasTail = s.use_tail !== false && sel > 0;
          const globalText = gpTaT.value.trim();
          const ctx = {
            dur: segDur(s).toFixed(1),
            pics: hasTail ? 1 : 0,
            picDesc: hasTail ? "Picture 1=上段尾帧" : "无",
            tail: hasTail,
            voices: "文本界面没有使用音色或配音槽。",
            hasAudio: false,
          };
          const requestText = (modeSel.value === "compose"
            ? "请严格按照下面的大白话分镜转换成合格提示词，不增删情节：\n"
            : "请根据下面的创意/草稿写一段提示词：\n")
            + draft
            + (globalText ? "\n\n全片共享要求（必须遵守）：\n" + globalText : "");
          const resp = await api.fetchApi("/h3director/ai_prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: [
                { role: "system", content: buildAiSys(ctx) },
                { role: "user", content: requestText },
              ],
              images: [],
              tail_seg: hasTail ? sel : null,
              mode: "text",
              project_id: ensureProjectId(),
              max_tokens: 1600,
              temperature: 0.7,
            }),
          });
          const result = await resp.json();
          if (!resp.ok || !result.content) throw new Error(result.error || ("HTTP " + resp.status));
          pta.value = result.content;
          s.prompt = result.content;
          save();
          apiInfo.style.color = "";
          apiInfo.textContent = "已生成并填入当前文本段";
        } catch (error) {
          setTextAiError("生成失败：" + error.message);
        }
        btnTextGenerate.disabled = false;
      });
      textAiPanel.append(
        mk("span", "h3s-hint", "文本段 AI："),
        mk("span", "h3s-hint", "生成方式"), modeSel,
        btnTextTest, btnTextGenerate, apiInfo,
        mk("span", "h3s-hint", "API 设置与创作界面共用；只处理当前选中的文本段"),
      );
      const resizeBar = pta.nextElementSibling;
      editor.insertBefore(textAiPanel, resizeBar ? resizeBar.nextSibling : pta.nextSibling);
      try { await loadTextApiInfo(); } catch (error) { setTextAiError("API 配置查询失败：" + error.message); }
      if (textAiPanel !== openedPanel) return;
    });

    if (!SHOW_SAVED_SEGMENT_PREVIEW || node.properties.h3_segment_preview_hidden === true) { autoFitCompactPanel(); return; }
    /* ======== ③ 本段成片预览（与其他界面同款）======== */
    const pvWrap = mk("div", "h3s-pv");
    pvWrap.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:240px;gap:4px;";
    editor.appendChild(pvWrap);
    (async () => {
      const selectedSegment = sel;
      const shouldAutoPlay = autoPlaySegment === selectedSegment;
      if (shouldAutoPlay) autoPlaySegment = null;
      let src = null;
      if (shouldAutoPlay) {
        src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + Date.now());
      } else {
        try {
          const st = await (await api.fetchApi("/h3director/status?" + _modeQ())).json();
          const info = st.segments && st.segments[String(selectedSegment + 1)];
          if (info && info.video) {
            src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + (info.mtime || Date.now()));
          }
        } catch (e) { /* 路由不可用时静默降级 */ }
      }
      if (!src) {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.appendChild(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频，运行后可在此预览。"));
        return;
      }
      const headRow = mk("div", "h3s-row");
      headRow.appendChild(mk("div", "h3s-hint", "段" + (sel + 1) + " 成片预览："));
      const zoom = mk("button", "h3s-btn", "放大查看");
      zoom.title = "新窗口打开，原生分辨率播放";
      zoom.addEventListener("click", () => window.open(src, "_blank"));
      headRow.appendChild(zoom);
      const hidePreview = mk("button", "h3s-btn", "隐藏播放器");
      hidePreview.title = "隐藏播放器并收起预览区域";
      hidePreview.addEventListener("click", hideSegmentPreview);
      headRow.appendChild(hidePreview);
      headRow.appendChild(mk("span", "h3s-hint", "拖预览框右下角可自由缩放"));
      pvWrap.appendChild(headRow);
      const pvBox = mk("div", "h3s-pvbox");
      pvBox.style.flex = "1";
      pvBox.style.minHeight = "200px";
      const v = document.createElement("video");
      v.src = src;
      v.controls = true;
      v.preload = "metadata";
      v.addEventListener("error", () => {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.replaceChildren(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频。"));
      }, { once: true });
      pvBox.appendChild(v);
      pvWrap.appendChild(pvBox);
      attachBottomBar(pvBox, 240, 135);
      if (shouldAutoPlay) {
        v.autoplay = true;
        v.play().catch(() => { /* 浏览器限制时保留原生播放按钮 */ });
      }
    })();
  }

  function renderEditor() {
    disconnectEditorObservers();
    stopVoicePreview();
    editor.innerHTML = "";
    durInput = null;
    picHintEl = null;
    if (externalTextTargetWidget) externalTextTargetWidget.value = Math.max(1, sel + 1);
    const s = segs[sel];
    if (!s) return;
    const generationMode = s.generation_mode || "multi_ref";
    if (!s.generation_mode) s.generation_mode = generationMode;
    const motionContextSource = ["local_latent", "upload_latent", "aliyun_oss", "video"].includes(s.motion_context_source)
      ? s.motion_context_source : "local_latent";
    // 始终写回归一化后的值，避免旧工作流/前端重绘把新来源回退成“本地自动续接”。
    s.motion_context_source = motionContextSource;
    const externalTextInput = (node.inputs || []).find((input) => input.name === "外部文本");
    const externalTextConnected = !!(externalTextInput && externalTextInput.link != null);
    if (externalTextConnected) {
      editor.appendChild(mk("div", "h3s-hint",
        `已连接外部文本：运行时将覆盖段 ${sel + 1} 的提示词；断开连接后恢复右侧文本框内容。`));
    }
    /* 面板级界面切换（v2.1 视频 / v2.11 文本）：创作=完整编辑器；视频=参考视频整版；文本=纯提示词整版 */
    appendBulkPromptEditor();
    const _m = node.properties.h3_mode || "create";
    if (_m === "video") { renderVideoEditor(s); return; }
    if (_m === "text") { renderTextEditor(s); return; }

    let gpTa = null;
    const makeImportedCreateSeg = (parsedSeg, source, position, sharedOnly = false,
      assignedRoles = null, plannedUseTail = null) => {
      const out = source && !sharedOnly ? { ...source } : {
        seed: Math.floor(Math.random() * 1e15),
        refs: [],
        ...defaultResolutionFields(),
        duration: 10,
        inherit_shared: true,
        use_tail: position > 0,
        enabled: true,
        force: false,
        fps: source && source.fps || 24,
      };
      if (source) {
        out.refs = Array.isArray(source.refs) ? source.refs.slice() : [];
        out.voice_refs = Array.isArray(source.voice_refs) ? source.voice_refs.slice() : [];
        out.voice_labels = source.voice_labels ? { ...source.voice_labels } : {};
        for (const key of ["aspect_ratio", "megapixels", "multiple", "width", "height"]) {
          if (source[key] != null) out[key] = source[key];
        }
      }
      out.duration = parsedSeg.duration > 0 ? parsedSeg.duration : clampDur(10);
      out.inherit_shared = true;
      out.use_tail = plannedUseTail == null ? position > 0 : !!plannedUseTail;
      out.enabled = true;
      out.force = false;
      if (Array.isArray(assignedRoles)) out.refs = assignedRoles.map((role) => role.file);
      if (!Array.isArray(out.refs)) out.refs = [];
      out.prompt = bindOrdinaryPromptToRoles(parsedSeg.prompt, Array.isArray(assignedRoles) ? assignedRoles : [], out.use_tail);
      return out;
    };

    /* 角色自动分配：
       1) 官方 Ref2VA / 含 Picture 标签的官方脚本完全本地处理，并保持角色库图片顺序稳定；
       2) 普通剧本先按已确认的角色名本地匹配；
       3) 只有存在未匹配段时才请求 API；API 不可用时把完整角色库放进未匹配段，避免漏角色。 */
    const planImportedRoleRefs = async (parsed, library) => {
      const empty = parsed.map(() => []);
      if (!library.length) return { assignments: empty, note: "；未发现已上传的角色参考图" };

      const hasOfficialPictures = parsed.official
        && parsed.some((part) => /<Picture\s+\d+>/i.test(part.prompt || ""));
      if (parsed.officialFormat === "ref2va") {
        const layout = officialRef2VARoleLayout(parsed, library);
        const locallyMapped = layout.pictureByFile.size;
        const missingP1 = layout.maxPicture > library.length && !layout.hasDedicatedP1Asset && !layout.p1IsNamedRole;
        return {
          assignments: parsed.map(() => layout.ordered.slice()),
          rolesForPosition: (position) => (position > 0 && layout.hasDedicatedP1Asset && !layout.p1IsNamedRole)
            ? layout.ordered.slice(1) : layout.ordered.slice(),
          useTailForPosition: (position) => position > 0 && !layout.p1IsNamedRole,
          note: "；Ref2VA 已在本地识别，按角色名对齐 " + locallyMapped
            + " 张图到官方 Picture 编号（未调用 API）"
            + (layout.p1IsNamedRole ? "；Picture 1 是命名角色，为防编号错位已关闭自动尾帧续接" : "")
            + (missingP1 ? "；⚠ 脚本引用了更高 Picture 编号，首段可能缺少 Picture 1 首帧/场景图" : ""),
        };
      }
      if (hasOfficialPictures) {
        return {
          assignments: parsed.map(() => library.slice()),
          note: "；官方 Picture 引用已在本地识别，参考图按固定顺序导入（未调用 API）",
        };
      }

      const assignments = parsed.map((part) => locallyMatchedRoles(part.prompt, library));
      const unresolved = [];
      assignments.forEach((roles, index) => { if (!roles.length) unresolved.push(index); });
      if (!unresolved.length) {
        return { assignments, note: "；角色已按名称在本地匹配（未调用 API）" };
      }

      status.textContent = "本地已匹配 " + (parsed.length - unresolved.length) + "/" + parsed.length
        + " 段；正在用 API 判断剩余 " + unresolved.length + " 段角色…";
      try {
        const response = await api.fetchApi("/h3director/role_match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roles: library.map((role) => role.name),
            segments: unresolved.map((index) => ({ index: index + 1, prompt: parsed[index].prompt || "" })),
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || ("HTTP " + response.status));
        const byName = new Map(library.map((role) => [normalizedRoleText(role.name), role]));
        const byIndex = new Map((result.assignments || []).map((item) => [Number(item.index), item.roles || []]));
        for (const index of unresolved) {
          if (!byIndex.has(index + 1)) {
            assignments[index] = library.slice();
            continue;
          }
          assignments[index] = byIndex.get(index + 1)
            .map((name) => byName.get(normalizedRoleText(name)))
            .filter(Boolean);
        }
        return { assignments, note: "；普通剧本本地匹配不足，剩余段已由 API 分配角色" };
      } catch (error) {
        for (const index of unresolved) assignments[index] = library.slice();
        return {
          assignments,
          note: "；⚠ API 角色匹配失败（" + error.message + "），未匹配段已安全回退为完整角色库，请逐段检查",
        };
      }
    };
    const applyCreateParsedGlobal = (parsed) => {
      const gExisting = (globalPromptWidget && globalPromptWidget.value || "").trim();
      const offStyle = parsed.globalStyle || "";
      const offExtra = parsed.globalExtra || "";
      const lastAuto = String(node.properties.h3_text_auto_global_value || "").trim();
      const canUpgradeAuto = !!gExisting && !!offStyle
        && ((lastAuto && gExisting === lastAuto)
          || (gExisting.length >= 24 && gExisting.length < offStyle.length
            && offStyle.toLowerCase().includes(gExisting.toLowerCase())));
      const setGlobal = (value) => {
        if (globalPromptWidget) globalPromptWidget.value = value;
        if (gpTa) gpTa.value = value;
      };
      if (parsed.officialFormat === "ref2va" && !offStyle && !offExtra) {
        if (gExisting && lastAuto && gExisting === lastAuto) {
          setGlobal("");
          node.properties.h3_text_auto_global_value = "";
          return "；Ref2VA 六字段已逐段保留，已清除上一份自动全局提示词";
        }
        return gExisting
          ? "（Ref2VA 每段已自包含；全局框为手填内容，未覆盖）"
          : "；Ref2VA 六字段已逐段完整保留，无需重复全局提示词";
      }
      if (!gExisting || canUpgradeAuto) {
        const joined = [offStyle, offExtra].filter(Boolean).join("\n\n");
        const value = joined || (parsed.official ? "" : extractGlobalPrompt(parsed));
        if (value) {
          setGlobal(value);
          node.properties.h3_text_auto_global_value = value;
          return canUpgradeAuto
            ? "；已升级自动全局提示词（风格/角色/一致性/限制）"
            : "；已自动提取共享提示词到全局框";
        }
      } else if (offExtra && !/soundscape\s*[:：]/i.test(gExisting)) {
        const value = gExisting + "\n\n" + offExtra;
        setGlobal(value);
        if (lastAuto && gExisting === lastAuto) node.properties.h3_text_auto_global_value = value;
        return "；已把音效/配乐字段追加到全局框";
      }
      return gExisting ? "（全局框已有手填内容，未覆盖）" : "";
    };

    /* 创作界面脚本导入：复用文本界面的 Base / Ref2VA / 普通文本解析器。
       参考图按角色名重新分配；同序配音和音色保留。 */
    // 创作界面的剧本导入区可独立折叠；默认收起，状态随工作流保存。
    const createScriptWrap = document.createElement("details");
    createScriptWrap.className = "h3s-slrow";
    createScriptWrap.style.cssText = "display:block;margin-top:5px;min-width:260px;overflow:visible;";
    createScriptWrap.open = node.properties.h3_create_script_open === true;
        createScriptWrap.addEventListener("toggle", () => {
            node.properties.h3_create_script_open = createScriptWrap.open;
            save();
            autoFitCompactPanel();
        });
    const createScriptTitle = document.createElement("summary");
    createScriptTitle.className = "h3s-hint";
    createScriptTitle.style.cssText = "cursor:pointer;color:#9fd0ff;user-select:none;";
    createScriptTitle.textContent = "剧本导入（MiniMax H3 Base / Ref2VA / 普通剧本；长时间线自动拆成不超过 15 秒的生成段）";
    createScriptWrap.appendChild(createScriptTitle);
    const createScriptTa = mk("textarea", "h3s-ta");
    createScriptTa.style.cssText += "flex:none;height:110px;";
    createScriptTa.placeholder = "粘贴官方 Base / Ref2VA 模板或普通剧本。角色图先按文件名本地匹配，失败段才调用 API。";
    createScriptTa.value = node.properties.h3_create_script || "";
    createScriptTa.addEventListener("input", () => {
      node.properties.h3_create_script = createScriptTa.value;
    });
    createScriptWrap.appendChild(createScriptTa);
    attachBottomBar(createScriptTa, 240, 60);

    const createImportRow = mk("div", "h3s-row");
    const btnCreateParse = mk("button", "h3s-btn primary", "⚡ 解析导入");
    btnCreateParse.title = "解析脚本并替换创作页面全部分段；参考图按角色名自动分配，同序配音和音色保留";
    let createParseArmed = false;
    const disarmCreateParse = () => {
      createParseArmed = false;
      btnCreateParse.textContent = "⚡ 解析导入";
      btnCreateParse.style.background = "";
      btnCreateParse.style.borderColor = "";
    };
    btnCreateParse.addEventListener("click", async () => {
      const text = createScriptTa.value;
      if (!text.trim()) { status.textContent = "脚本框是空的，先粘贴或载入官方模板"; return; }
      const parsed = parseScript(text);
      if (!parsed.length) { status.textContent = "没有识别到任何内容"; return; }
      const hasContent = createSegs.some((seg) => (seg.prompt || "").trim());
      if (hasContent && !createParseArmed) {
        createParseArmed = true;
        btnCreateParse.textContent = "将替换当前 " + createSegs.length + " 段，再点确认";
        btnCreateParse.style.background = "#8a2f2f";
        btnCreateParse.style.borderColor = "#c05555";
        const parsedType = parsed.official ? "（" + (parsed.officialLabel || "官方模板") + "）" : "";
        status.textContent = "解析出 " + parsed.length + " 段" + parsedType
          + "；再点一次红色按钮确认，角色参考图将自动分配，同序配音/音色会保留";
        return;
      }
      disarmCreateParse();
      const previous = createSegs.slice();
      const roleLibrary = collectRoleLibrary(node, previous);
      const hadMedia = previous.slice(0, parsed.length).some((seg) =>
        (Array.isArray(seg.refs) && seg.refs.length) || seg.audio
        || (Array.isArray(seg.voice_refs) && seg.voice_refs.length));
      btnCreateParse.disabled = true;
      let rolePlan;
      try {
        rolePlan = await planImportedRoleRefs(parsed, roleLibrary);
      } finally {
        btnCreateParse.disabled = false;
      }
      createSegs.length = 0;
      parsed.forEach((parsedSeg, i) => {
        const assignedRoles = rolePlan.rolesForPosition
          ? rolePlan.rolesForPosition(i) : (rolePlan.assignments[i] || []);
        const plannedTail = rolePlan.useTailForPosition ? rolePlan.useTailForPosition(i) : null;
        createSegs.push(makeImportedCreateSeg(
          parsedSeg, previous[i] || null, i, false, assignedRoles, plannedTail));
      });
      segs = createSegs;
      sel = 0;
      clearBoxSel();
      const globalNote = applyCreateParsedGlobal(parsed);
      save();
      renderTimeline();
      renderEditor();
      const total = createSegs.reduce((sum, seg) => sum + segDur(seg), 0);
      const parsedType = parsed.official ? "（" + (parsed.officialLabel || "官方模板") + "）" : "";
      const mediaNote = hadMedia ? "；原参考图已作为角色库重新分配，同序配音/音色已保留" : "";
      const parsedWarn = (parsed.warnings || []).length ? "；⚠ " + parsed.warnings.slice(0, 2).join("；") : "";
      status.textContent = "创作页面已解析 " + createSegs.length + " 段" + parsedType
        + "，总 " + total.toFixed(1) + "s" + mediaNote + rolePlan.note + globalNote + parsedWarn;
    });

    const btnCreateParseCurrent = mk("button", "h3s-btn", "📥 导入到当前段");
    btnCreateParseCurrent.title = "只替换当前创作段；若解析出多段则原位插入，新增段复制当前段参考图和音色，但不复制配音文件";
    btnCreateParseCurrent.addEventListener("click", async () => {
      const text = createScriptTa.value;
      if (!text.trim()) { status.textContent = "脚本框是空的，先粘贴或载入官方模板"; return; }
      const parsed = parseScript(text);
      if (!parsed.length) { status.textContent = "没有识别到任何内容"; return; }
      const at = Math.max(0, Math.min(sel, createSegs.length - 1));
      const source = createSegs[at] || null;
      const roleLibrary = collectRoleLibrary(node, createSegs);
      btnCreateParseCurrent.disabled = true;
      let rolePlan;
      try {
        rolePlan = await planImportedRoleRefs(parsed, roleLibrary);
      } finally {
        btnCreateParseCurrent.disabled = false;
      }
      const imported = parsed.map((parsedSeg, i) => {
        const position = at + i;
        const assignedRoles = rolePlan.rolesForPosition
          ? rolePlan.rolesForPosition(position) : (rolePlan.assignments[i] || []);
        const plannedTail = rolePlan.useTailForPosition ? rolePlan.useTailForPosition(position) : null;
        return makeImportedCreateSeg(parsedSeg, source, position, i > 0, assignedRoles, plannedTail);
      });
      createSegs.splice(at, 1, ...imported);
      segs = createSegs;
      sel = at;
      clearBoxSel();
      const globalNote = applyCreateParsedGlobal(parsed);
      save();
      renderTimeline();
      renderEditor();
      const parsedType = parsed.official ? "；识别为" + (parsed.officialLabel || "官方模板") : "";
      const parsedWarn = (parsed.warnings || []).length ? "；⚠ " + parsed.warnings.slice(0, 2).join("；") : "";
      status.textContent = "已把 " + imported.length + " 段导入创作页面第 " + (at + 1)
        + " 段；当前段配音/音色已保留" + rolePlan.note + parsedType + globalNote + parsedWarn;
    });

    const btnCreateLoad = mk("button", "h3s-btn", "📂 载入文本");
    btnCreateLoad.title = "从本地 .txt 文件载入官方脚本，载入后自动执行解析导入";
    const createFileInput = document.createElement("input");
    createFileInput.type = "file";
    createFileInput.accept = ".txt,text/plain";
    createFileInput.style.display = "none";
    btnCreateLoad.addEventListener("click", () => { createFileInput.click(); });
    createFileInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        createScriptTa.value = text;
        node.properties.h3_create_script = text;
        status.textContent = "创作页面已载入 " + file.name + "，准备解析…";
        btnCreateParse.click();
      } catch (err) {
        status.textContent = "载入失败：" + err.message;
      }
      createFileInput.value = "";
    });
    createImportRow.append(btnCreateParse, btnCreateParseCurrent, btnCreateLoad,
      mk("span", "h3s-hint", "角色图按文件名匹配：官方 Ref2VA 本地识别；普通剧本仅在本地匹配失败时调用 API"));
    createScriptWrap.appendChild(createImportRow);
    editor.appendChild(createScriptWrap);

    /* 全局提示词（v2.12）：注入到每一段开头，保持风格/角色/场景一致性 */
    const gpRow = mk("div", "h3s-row");
    gpRow.style.flexDirection = "column";
    gpRow.style.alignItems = "stretch";
    const gpHead = mk("div", "h3s-row");
    gpHead.style.cssText += "justify-content:space-between;align-items:center;";
    gpHead.appendChild(mk("div", "h3s-hint", "全局提示词（注入到每一段开头）："));
    /* 创作界面一键全部清空：脚本、全局提示词、全部分段及段级素材一起重置。
       已生成成片仍保留在 output 目录；两段式红按钮，不用 confirm。 */
    const btnGpClear = mk("button", "h3s-btn", "全部清空");
    btnGpClear.title = "清空官方脚本 + 全局提示词 + 全部分段及段级素材，重置为 1 个空白段（成片文件保留）";
    let gpClearArmed = false;
    const disarmGpClear = () => {
      gpClearArmed = false;
      btnGpClear.textContent = "全部清空";
      btnGpClear.style.background = "";
      btnGpClear.style.borderColor = "";
    };
    btnGpClear.addEventListener("click", () => {
      const hasAnything = !!createScriptTa.value.trim() || !!gpTa.value.trim()
        || createSegs.length > 1 || createSegs.some((seg) => (seg.prompt || "").trim()
          || (Array.isArray(seg.refs) && seg.refs.length) || seg.audio
          || (Array.isArray(seg.voice_refs) && seg.voice_refs.length));
      if (!hasAnything) { disarmGpClear(); status.textContent = "脚本 / 全局提示词 / 分段素材都已是空的"; return; }
      if (!gpClearArmed) {
        gpClearArmed = true;
        btnGpClear.textContent = "再点确认全部清空";
        btnGpClear.style.background = "#8a2f2f";
        btnGpClear.style.borderColor = "#c05555";
        status.textContent = "将清空：官方脚本 + 全局提示词 + 全部 " + createSegs.length
          + " 段及段级参考图/音频，再点一次红色按钮确认";
        return;
      }
      disarmGpClear();
      createScriptTa.value = "";
      node.properties.h3_create_script = "";
      gpTa.value = "";
      if (globalPromptWidget) globalPromptWidget.value = "";
      node.properties.h3_text_auto_global_value = "";
      const fresh = JSON.parse(JSON.stringify(defaultSegs()[0]));
      fresh.prompt = "";
      fresh.seed = Math.floor(Math.random() * 1e15);
      fresh.refs = [];
      createSegs.length = 0;
      createSegs.push(fresh);
      segs = createSegs;
      sel = 0;
      clearBoxSel();
      save(); renderTimeline(); renderEditor();
      status.textContent = "已全部清空：官方脚本 + 全局提示词 + 分段及段级素材（成片文件保留在 output 目录）";
    });
    gpHead.appendChild(btnGpClear);
    gpRow.appendChild(gpHead);
    gpTa = mk("textarea", "h3s-ta");
    gpTa.style.cssText += "flex:none;height:60px;";
    gpTa.placeholder = "写一段所有段共用的风格/角色/场景描述，例如：Pixar 3D cartoon, warm lighting, no subtitles...";
    gpTa.value = (globalPromptWidget && globalPromptWidget.value) || "";
    gpTa.addEventListener("input", () => {
      if (globalPromptWidget) globalPromptWidget.value = gpTa.value;
      node.properties.h3_text_auto_global_value = "";
    });
    gpRow.appendChild(gpTa);
    editor.appendChild(gpRow);

    const row = mk("div", "h3s-row");
    row.appendChild(mk("b", null, `段 ${sel + 1}`));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.addEventListener("change", () => { s.enabled = cb.checked; save(); renderTimeline(); });
    row.appendChild(cb);
    row.appendChild(mk("span", null, "启用"));

    appendResolutionControls(row, s);
    row.appendChild(mk("span", null, "时长"));
    durInput = mk("input", "h3s-durinput");
    durInput.type = "number";
    durInput.step = "0.5";
    durInput.min = String(DUR_MIN);
    durInput.max = String(DUR_MAX);
    durInput.value = segDur(s).toFixed(1);
    durInput.title = "1.6-15 秒；自动吸附到模型对齐档位：1.6 / 2.3 / 3.0 / 3.8 / 4.5 …（每档约 +0.7s）";
    durInput.addEventListener("change", () => {
      s.duration = clampDur(Number(durInput.value) || 10);
      durInput.value = s.duration.toFixed(1);
      save();
      renderTimeline();
    });
    row.appendChild(durInput);
    row.appendChild(mk("span", "h3s-hint", "s"));

    row.appendChild(mk("span", null, "帧率"));
    const fpsIn = mk("input", "h3s-durinput");
    fpsIn.type = "number";
    fpsIn.step = "1";
    fpsIn.min = "8";
    fpsIn.max = "24";
    fpsIn.value = s.fps || 24;
    fpsIn.title = "输出帧率 8~24（模型原生 24fps；调低=抽帧，动画顿挫感，时长不变）";
    fpsIn.addEventListener("change", () => {
      s.fps = Math.min(24, Math.max(8, Math.round(Number(fpsIn.value) || 24)));
      fpsIn.value = s.fps;
      s.prompt = ta.value;
      save();
    });
    row.appendChild(fpsIn);

    row.appendChild(mk("span", null, "种子"));
    const seed = mk("input", "h3s-seed");
    seed.type = "number";
    seed.value = s.seed;
    seed.addEventListener("change", () => { s.seed = Number(seed.value); save(); });
    row.appendChild(seed);
    const btnNewSeed = mk("button", "h3s-btn", "随机");
    btnNewSeed.addEventListener("click", () => {
      s.seed = Math.floor(Math.random() * 1e15);
      seed.value = s.seed; save();
    });
    row.appendChild(btnNewSeed);

    // 「继承共享参考图」开关已从 UI 移除（v2 工作流无共享图接口，开关恒无效）。
    // 数据字段 s.inherit_shared 保留：若日后左侧接了 ref_image_*，共享图会自动带入，无需开关。

    const continuityBlocked = segmentContinuityBlocked(segs, sel);
    const cbTail = document.createElement("input");
    const continuityName = `h3-cont-${node.id}-create-${sel}`;
    cbTail.type = "checkbox";
    cbTail.name = continuityName;
    cbTail.checked = !continuityBlocked && s.use_tail === true;
    cbTail.disabled = continuityBlocked;
    cbTail.title = continuityBlocked ? "本段与上段分辨率不同，禁止续接尾帧" : "续接上段尾帧；选择后自动关闭 MotionContext，也可再次取消。首/尾帧模式中会作为本段的首帧。";
    cbTail.addEventListener("change", () => {
      s.use_tail = cbTail.checked;
      if (cbTail.checked) s.motion_context = false;
      s.prompt = ta.value;
      save();
      renderEditor();
    });
    row.appendChild(cbTail);
    const tailLab = mk("span", null, "续接上段尾帧");
    if (continuityBlocked) tailLab.style.opacity = "0.45";
    row.appendChild(tailLab);

    if (sel >= 1) {
      const btnCont = mk("button", "h3s-btn", "从视频续接");
      btnCont.disabled = continuityBlocked || s.use_tail !== true;
      btnCont.title = continuityBlocked ? "本段与上段分辨率不同，禁止导入续接帧" : s.use_tail === true
        ? "上传任意 mp4，抽最后一帧作为本段的续接起点"
        : "请先选择“续接上段尾帧”再导入视频尾帧";
      btnCont.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/mp4,video/*";
        inp.style.display = "none";
        // detached input 的 click() 在部分浏览器/内核不弹文件对话框，必须先挂到 DOM
        document.body.appendChild(inp);
        inp.addEventListener("change", async () => {
          try {
            if (!inp.files[0]) return;
            status.textContent = `正在为段${sel + 1} 提取续接帧…`;
            const fd = new FormData();
            fd.append("target_seg", String(sel + 1));
            fd.append("mode", curMode());
            fd.append("project_id", ensureProjectId());
            fd.append("video", inp.files[0], inp.files[0].name);
            const resp = await api.fetchApi("/h3director/extract_tail", { method: "POST", body: fd });
            const r = await resp.json();
            if (r.ok) {
              s.use_tail = true;
              s.motion_context = false;
              save();
            }
            status.textContent = r.ok ? `段${sel + 1} 续接帧已就绪` : `失败: ${r.error || ("HTTP " + resp.status)}`;
            renderTimeline();
            renderEditor();  // 刷新缩略图区，让新尾帧立刻可见
          } catch (e) {
            status.textContent = "续接帧提取出错: " + e.message;
          } finally {
            inp.remove();
          }
        });
        inp.click();
      });
      row.appendChild(btnCont);
    }

    const cbMotion = document.createElement("input");
    cbMotion.type = "checkbox";
    cbMotion.name = continuityName;
    cbMotion.checked = !continuityBlocked && s.motion_context === true;
    cbMotion.disabled = false;
    cbMotion.title = continuityBlocked ? "勾选后自动同步上段的宽高比、分辨率和帧率，再开启 MotionContext" : "选择后自动关闭尾帧续接；同时同步上段的宽高比、分辨率和帧率";
    cbMotion.addEventListener("change", () => {
      s.motion_context = cbMotion.checked;
      if (cbMotion.checked) {
        const synced = syncSegmentToPrevious(segs, sel);
        s.use_tail = false;
        if (!Number.isFinite(Number(s.motion_context_index)) || Number(s.motion_context_index) < 0) {
          s.motion_context_index = sel;
        }
        if (synced) status.textContent = `MotionContext 已开启：本段已同步为 ${synced[0]}×${synced[1]} / ${synced[2]}fps`;
      }
      s.prompt = ta.value;
      save();
      renderEditor();
    });
    row.appendChild(cbMotion);
    const motionLab = mk("span", null, "MotionContext");
    row.appendChild(motionLab);
    if (continuityBlocked) row.appendChild(mk("span", "h3s-audio-warn", "尾帧续接已禁用；勾选 MotionContext 会自动同步上段尺寸和帧率"));

    editor.appendChild(row);

    // Motion Context 的来源：默认保持原有“本地自动 latent”逻辑；云平台不能写 latent
    // 时可改为上传此前保存的 latent，或直接上传上一段带音轨的视频。
    if (s.motion_context === true) {
      const sourceRow = mk("div", "h3s-row");
      sourceRow.appendChild(mk("span", "h3s-hint", "Motion Context 来源："));
      const sourceSel = document.createElement("select");
      [
        ["local_latent", "latent 延续：本地自动续接"],
        ["upload_latent", "latent 延续：上传 latent"],
        ["aliyun_oss", "Latent延续：阿里云"],
        ["video", "视频延续：上传上一段视频"],
      ].forEach(([value, label]) => {
        const opt = document.createElement("option");
        opt.value = value; opt.textContent = label; sourceSel.appendChild(opt);
      });
      sourceSel.value = motionContextSource;
      sourceSel.title = "本地自动续接保持旧逻辑；上传 latent 使用 H3 Motion Context 保存的 .safetensors；阿里云按配置节点的 object_key/clip_00001.safetensors 固定槽位保存和读取；视频延续不读取或保存 latent。";
      sourceSel.addEventListener("change", (event) => {
        const selectedSource = String(event.currentTarget.value || "local_latent");
        s.motion_context = true;
        s.use_tail = false;
        s.motion_context_source = ["local_latent", "upload_latent", "aliyun_oss", "video"].includes(selectedSource)
          ? selectedSource : "local_latent";
        save();
        // select 的 change 冒泡完成后再重绘，防止浏览器将旧的 option 文本写回控件。
        requestAnimationFrame(renderEditor);
      });
      sourceRow.appendChild(sourceSel);

      if (motionContextSource === "local_latent" || motionContextSource === "aliyun_oss") {
        const indexLabel = mk("span", "h3s-hint", "Clip_index");
        const indexIn = mk("input", "h3s-durinput");
        indexIn.type = "number";
        indexIn.min = "0";
        indexIn.max = "9998";
        indexIn.step = "1";
        const currentIndex = Number(s.motion_context_index);
        indexIn.value = String(Number.isFinite(currentIndex) && currentIndex >= 0
          ? Math.floor(currentIndex) : sel);
        indexIn.title = motionContextSource === "aliyun_oss"
          ? "读取的阿里云 clip 编号。0=不加载旧 latent；本段会保存为配置的 object_key/clip_(Index+1).safetensors。"
          : "读取的本地 clip 编号。0=不加载旧 latent；本段会保存为 clip_(Index+1)。";
        indexIn.addEventListener("change", () => {
          const parsed = Math.floor(Number(indexIn.value));
          s.motion_context_index = Number.isFinite(parsed)
            ? Math.min(9998, Math.max(0, parsed)) : sel;
          indexIn.value = String(s.motion_context_index);
          save(); renderEditor();
        });
        sourceRow.append(indexLabel, indexIn, mk("span", "h3s-hint",
          motionContextSource === "aliyun_oss"
            ? "0=不加载；生成后保存 object_key/clip_" + String(Number(indexIn.value) + 1).padStart(5, "0") + ".safetensors"
            : "0=不加载；生成后保存 clip " + (Number(indexIn.value) + 1)));
      }

      if (motionContextSource === "upload_latent") {
        sourceRow.appendChild(mk("span", "h3s-hint", s.motion_context_latent
          ? "已选：" + (s.motion_context_latent_label || s.motion_context_latent)
          : "未上传 .safetensors"));
        const upLatent = mk("button", "h3s-btn", "+上传 latent");
        upLatent.title = "仅支持 H3 Motion Context Save Latent 生成的 .safetensors 文件";
        upLatent.addEventListener("click", () => {
          const inp = document.createElement("input");
          inp.type = "file"; inp.accept = ".safetensors"; inp.style.display = "none";
          document.body.appendChild(inp);
          inp.addEventListener("change", async () => {
            try {
              const file = inp.files && inp.files[0];
              if (!file) return;
              status.textContent = "正在上传 Motion Context latent…";
              const fd = new FormData(); fd.append("latent", file, file.name);
              const resp = await api.fetchApi("/h3director/upload_context_latent", { method: "POST", body: fd });
              const data = await resp.json();
              if (!(data.ok && data.name)) throw new Error(data.error || ("HTTP " + resp.status));
              s.motion_context_latent = data.name;
              s.motion_context_latent_label = data.label || file.name;
              save(); renderEditor();
              status.textContent = "Motion Context latent 已上传";
            } catch (e) { status.textContent = "latent 上传失败: " + e.message; }
            finally { inp.remove(); }
          });
          inp.click();
        });
        sourceRow.appendChild(upLatent);
        if (s.motion_context_latent) {
          const rmLatent = mk("button", "h3s-btn", "×");
          rmLatent.title = "移除已选 latent";
          rmLatent.addEventListener("click", () => {
            s.motion_context_latent = null; s.motion_context_latent_label = null;
            save(); renderEditor();
          });
          sourceRow.appendChild(rmLatent);
        }
      }
      sourceRow.appendChild(mk("span", "h3s-hint", motionContextSource === "video"
        ? "视频上传区在本段音频下方"
        : motionContextSource === "local_latent" ? "沿用原有本地 clip 自动续接"
        : motionContextSource === "aliyun_oss" ? "需连接左侧的阿里云 OSS 配置接口"
        : "运行时校验 AV latent 格式"));
      editor.appendChild(sourceRow);
    }

    /* 段级生成模式：端点模式直接映射到原生 MiniMaxH3ImageToVideo。
       参考图区前两张图的顺序固定为首帧、尾帧，避免依赖提示词猜测。 */
    const generationRow = mk("div", "h3s-row");
    generationRow.appendChild(mk("span", null, "生成方式"));
    const generationSelect = document.createElement("select");
    const generationOptions = [
      ["multi_ref", "多参生视频"],
      ["text_to_video", "文生视频"],
      ["first_frame", "首帧生视频"],
      ["first_last_frame", "首尾帧生视频"],
      ["last_frame", "尾帧生视频"],
    ];
    generationOptions.forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      generationSelect.appendChild(option);
    });
    generationSelect.value = generationOptions.some(([value]) => value === generationMode)
      ? generationMode : "multi_ref";
    generationSelect.title = "多参生视频保留所有角色/参考图；其余模式要求主 model 输入连接 FL2VA 模型。首尾帧按下方图片从左到右第 1、2 张读取。";
    generationSelect.addEventListener("change", () => {
      s.generation_mode = generationSelect.value;
      save();
      renderEditor();
    });
    generationRow.appendChild(generationSelect);
    generationRow.appendChild(mk("span", "h3s-hint",
      generationMode === "multi_ref"
        ? "保留当前多参考图、参考音频/视频及段间续接行为"
        : "此模式不加载段间续接，但本段仍会保存 Motion Context latent；请确认主 model 已连接 FL2VA 模型"));
    editor.appendChild(generationRow);

    /* 台词时长建议条（参考 WhatDreamsCost Speech Length Calculator）：
       提示词引号内的台词 → 按三档语速估算 → 一键应用并自动吸附 VAE 档位。
       解决"写台词靠猜时长"（台词写进引号才生效，与提示词模板一致）。 */
    const slRow = mk("div", "h3s-slrow");
    slRow.style.display = "none";
    editor.appendChild(slRow);

    picHintEl = mk("div", "h3s-pichint", picHintText(s, sel));
    editor.appendChild(picHintEl);

    /* 创作界面与文本界面保持同一套提示词入口：标题明确当前区域，
       “清空”只影响当前选中的段，不会动全段提示词或其它片段。 */
    const promptHead = mk("div", "h3s-row");
    promptHead.appendChild(mk("span", "h3s-hint", "提示词："));
    const btnClearPrompt = mk("button", "h3s-btn", "清空");
    btnClearPrompt.title = "清空当前段提示词";
    promptHead.appendChild(btnClearPrompt);
    editor.appendChild(promptHead);

    const ta = mk("textarea", "h3s-ta");
    ta.value = s.prompt;
    // 段级记忆提示词编辑区的手动尺寸；保存在 segments_json，随工作流恢复。
    const savedPromptBoxSize = s.prompt_box_size;
    if (savedPromptBoxSize && Number.isFinite(Number(savedPromptBoxSize.width))
      && Number.isFinite(Number(savedPromptBoxSize.height))) {
      ta.style.flex = "none";
      ta.style.width = Math.max(240, Math.round(Number(savedPromptBoxSize.width))) + "px";
      ta.style.height = Math.max(60, Math.round(Number(savedPromptBoxSize.height))) + "px";
    }
    ta.addEventListener("change", () => { s.prompt = ta.value; save(); });
    btnClearPrompt.addEventListener("click", () => {
      ta.value = "";
      s.prompt = "";
      save();
      rebuildNav?.();
      updateSL?.();
      ta.focus();
      status.textContent = "段" + (sel + 1) + " 提示词已清空";
    });
    editor.appendChild(ta);
    attachBottomBar(ta, 240, 60, (width, height, finished) => {
      if (!finished) return;
      s.prompt_box_size = { width: Math.round(width), height: Math.round(height) };
      save();
    });

    /* 时间段跳转导航：扫描提示词里的 [xs-ys] 标签渲染成小按钮，
       点击把光标/选中区直接定位到该段——长提示词里快速找到"那段在哪里" */
    const navRow = mk("div", "h3s-row");
    const rebuildNav = () => {
      navRow.innerHTML = "";
      const tags = [...ta.value.matchAll(/\[\d+(?:\.\d+)?s\s*-\s*\d+(?:\.\d+)?s\]/g)];
      if (!tags.length) return;
      navRow.appendChild(mk("span", "h3s-hint", "跳转:"));
      for (const m of tags) {
        const b = mk("button", "h3s-btn", m[0]);
        b.style.padding = "1px 6px";
        b.style.fontSize = "10px";
        b.title = "光标定位到提示词中的 " + m[0] + " 段";
        b.addEventListener("click", () => {
          ta.focus();
          ta.setSelectionRange(m.index, m.index + m[0].length);
        });
        navRow.appendChild(b);
      }
    };
    ta.addEventListener("input", rebuildNav);
    rebuildNav();

    /* 台词字数变化时实时刷新建议条（估算很轻，input 事件直接算） */
    const updateSL = () => {
      const u = speechUnits(ta.value);
      if (!u) { slRow.style.display = "none"; return; }
      slRow.style.display = "";
      slRow.innerHTML = "";
      slRow.appendChild(mk("span", "h3s-hint", "台词约 " + u + " 字 → 建议时长（已吸附档位）："));
      for (const [lab, rate] of SPEECH_RATES) {
        const sec = clampDur(u / rate + 0.4);  // +0.4s 留给语气停顿
        const b = mk("button", "h3s-btn", lab + " " + sec.toFixed(1) + "s");
        b.style.padding = "2px 8px";
        b.title = "按" + lab + "速（" + rate + " 字/秒）估算，点击设为本段时长";
        b.addEventListener("click", () => {
          s.duration = sec;
          if (durInput) durInput.value = sec.toFixed(1);
          s.prompt = ta.value; save(); renderTimeline();
          status.textContent = "段" + (sel + 1) + " 时长已按台词（" + lab + "速）设为 " + sec.toFixed(1) + "s";
        });
        slRow.appendChild(b);
      }
    };
    ta.addEventListener("input", updateSL);
    updateSL();

    /* 提示词编辑工具条：全选 / 复制 / 粘贴 / 删除（有选中操作选中，无选中操作全文） */
    const editRow = mk("div", "h3s-row");
    const commitTa = () => { s.prompt = ta.value; save(); rebuildNav(); };
    const selRange = () => {
      const a = ta.selectionStart ?? 0, b = ta.selectionEnd ?? 0;
      return a !== b ? [a, b] : null;
    };
    const btnSelAllT = mk("button", "h3s-btn", "全选");
    btnSelAllT.title = "选中提示词全部内容";
    btnSelAllT.addEventListener("click", () => { ta.focus(); ta.select(); });

    const btnCopyT = mk("button", "h3s-btn", "复制");
    btnCopyT.title = "复制选中内容（无选中则复制全部）";
    btnCopyT.addEventListener("click", async () => {
      const r = selRange();
      const txt = r ? ta.value.slice(r[0], r[1]) : ta.value;
      if (!txt) { status.textContent = "提示词为空，没有可复制的内容"; return; }
      try {
        await navigator.clipboard.writeText(txt);
        status.textContent = r ? "已复制选中内容" : "已复制全部提示词";
      } catch (e) {
        status.textContent = "复制失败: " + e.message;
      }
    });

    const btnPasteT = mk("button", "h3s-btn", "粘贴");
    btnPasteT.title = "在光标处粘贴（有选中则替换选中内容）";
    btnPasteT.addEventListener("click", async () => {
      try {
        const txt = await navigator.clipboard.readText();
        if (!txt) { status.textContent = "剪贴板为空"; return; }
        const r = selRange() || [ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length];
        ta.value = ta.value.slice(0, r[0]) + txt + ta.value.slice(r[1]);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = r[0] + txt.length;
        commitTa();
        status.textContent = "已粘贴";
      } catch (e) {
        status.textContent = "粘贴失败（浏览器可能拦截了剪贴板读取）: " + e.message;
      }
    });

    const btnDelT = mk("button", "h3s-btn", "删除");
    btnDelT.title = "删除选中内容（无选中则清空全部提示词，需再点一次红色按钮确认）";
    /* 不用 confirm()（内嵌浏览器静默拦截，点了没反应）——两段式红按钮确认 */
    let delArmed = false;
    const disarmDel = () => {
      delArmed = false;
      btnDelT.textContent = "删除";
      btnDelT.style.background = "";
      btnDelT.style.borderColor = "";
    };
    btnDelT.addEventListener("click", () => {
      const r = selRange();
      if (r) {
        disarmDel();
        ta.value = ta.value.slice(0, r[0]) + ta.value.slice(r[1]);
        ta.selectionStart = ta.selectionEnd = r[0];
        status.textContent = "已删除选中内容";
      } else {
        if (!ta.value) { status.textContent = "提示词已是空的"; return; }
        if (!delArmed) {
          delArmed = true;
          btnDelT.textContent = "再点确认清空";
          btnDelT.style.background = "#8a2f2f";
          btnDelT.style.borderColor = "#c05555";
          status.textContent = "没有选中内容，再点一次红色按钮清空本段全部提示词";
          return;
        }
        disarmDel();
        ta.value = "";
        status.textContent = "已清空本段提示词";
      }
      ta.focus();
      commitTa();
    });

    /* ✨ AI 提示词：只调用用户主动配置的 OpenAI-compatible API。
       API Key 仅保存到 ComfyUI 后端本机配置，不写入工作流、node.properties 或 localStorage。 */
    const btnAI = mk("button", "h3s-btn", "✨ AI");
    btnAI.title = "通过远程 API 撰写/优化本段提示词";
    let aiPanel = null;
    btnAI.addEventListener("click", async () => {
      if (aiPanel) { aiPanel.remove(); aiPanel = null; return; }
      aiPanel = mk("div", "h3s-slrow");
      const openedPanel = aiPanel;
      aiPanel.style.flexWrap = "wrap";
      const aiStat = mk("span", "h3s-hint", "API 配置查询中…");
      let savedApiBase = "";
      const apiHost = (value) => {
        try { return new URL(String(value || "").trim()).host.toLowerCase(); }
        catch (e) { return ""; }
      };
      const apiPresets = {
        codexcn: {
          label: "CodexCN / Responses", base: "https://api2.codexcn.com/v1",
          models: [
            ["gpt-5.6-sol", "GPT-5.6 Sol（质量/编程）"],
            ["gpt-5.6-terra", "GPT-5.6 Terra（均衡）"],
            ["gpt-5.6-luna", "GPT-5.6 Luna（快速/省额度）"],
          ],
        },
        openai: {
          label: "OpenAI 官方", base: "https://api.openai.com/v1",
          models: [
            ["gpt-5", "GPT-5（图文/质量）"],
            ["gpt-5-mini", "GPT-5 mini（图文/省流量）"],
            ["gpt-4.1", "GPT-4.1（图文）"],
            ["gpt-4.1-mini", "GPT-4.1 mini（图文/省流量）"],
          ],
        },
        deepseek: {
          label: "DeepSeek 官方", base: "https://api.deepseek.com/v1",
          models: [
            ["deepseek-chat", "DeepSeek Chat（文本）"],
            ["deepseek-reasoner", "DeepSeek Reasoner（文本/推理）"],
          ],
        },
        openrouter: {
          label: "OpenRouter", base: "https://openrouter.ai/api/v1",
          models: [
            ["openai/gpt-5", "OpenRouter · GPT-5（图文）"],
            ["openai/gpt-5-mini", "OpenRouter · GPT-5 mini（图文）"],
            ["anthropic/claude-sonnet-4", "OpenRouter · Claude Sonnet 4（图文）"],
            ["google/gemini-2.5-pro", "OpenRouter · Gemini 2.5 Pro（图文）"],
          ],
        },
        siliconflow: {
          label: "硅基流动", base: "https://api.siliconflow.cn/v1",
          models: [
            ["Qwen/Qwen2.5-VL-72B-Instruct", "Qwen2.5-VL-72B（图文）"],
            ["deepseek-ai/DeepSeek-V3", "DeepSeek V3（文本）"],
            ["deepseek-ai/DeepSeek-R1", "DeepSeek R1（文本/推理）"],
          ],
        },
        dashscope: {
          label: "阿里云百炼", base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          models: [
            ["qwen-vl-max", "Qwen VL Max（图文）"],
            ["qwen-plus", "Qwen Plus（文本）"],
            ["qwen-max", "Qwen Max（文本）"],
          ],
        },
        custom: { label: "自定义 / 中转站", base: "", models: [] },
      };
      const apiPreset = document.createElement("select");
      Object.entries(apiPresets).forEach(([value, preset]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = preset.label;
        apiPreset.appendChild(option);
      });
      apiPreset.title = "选择服务商后自动填写 API Base；在 codexcn 购买的 Key 必须选择 CodexCN，不能发往 OpenAI 官方地址";
      const apiBase = document.createElement("input");
      apiBase.type = "text";
      apiBase.placeholder = "https://api.openai.com/v1";
      apiBase.title = "OpenAI-compatible API Base URL；可填写 /chat/completions 或 /responses 完整地址；CodexCN 会自动使用 Responses 协议";
      apiBase.style.cssText = "min-width:260px;flex:1;";
      const apiModel = document.createElement("input");
      apiModel.type = "text";
      apiModel.placeholder = "模型名，例如 gpt-5";
      apiModel.title = "填写服务商支持的模型 ID";
      apiModel.style.cssText = "min-width:150px;width:180px;";
      const modelPreset = document.createElement("select");
      modelPreset.title = "常用模型快捷选择；列表没有时选自定义模型并手动填写模型 ID";
      const fillModelPresets = (providerKey, selectedModel, useDefault = false) => {
        const models = (apiPresets[providerKey] || apiPresets.custom).models;
        modelPreset.innerHTML = "";
        models.forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          modelPreset.appendChild(option);
        });
        const customOption = document.createElement("option");
        customOption.value = "__custom__";
        customOption.textContent = "自定义模型…";
        modelPreset.appendChild(customOption);
        if (useDefault && models.length) {
          apiModel.value = models[0][0];
          modelPreset.value = models[0][0];
          return;
        }
        modelPreset.value = models.some(([value]) => value === selectedModel) ? selectedModel : "__custom__";
      };
      const syncPresetFromFields = () => {
        const normalized = apiBase.value.trim().replace(/\/+$/, "");
        const providerKey = Object.entries(apiPresets).find(([, preset]) => preset.base
          && preset.base.replace(/\/+$/, "") === normalized)?.[0] || "custom";
        apiPreset.value = providerKey;
        fillModelPresets(providerKey, apiModel.value.trim(), false);
      };
      apiPreset.addEventListener("change", () => {
        const preset = apiPresets[apiPreset.value] || apiPresets.custom;
        if (preset.base) apiBase.value = preset.base;
        fillModelPresets(apiPreset.value, apiModel.value.trim(), apiPreset.value !== "custom");
        showProviderSwitchWarning();
      });
      modelPreset.addEventListener("change", () => {
        if (modelPreset.value !== "__custom__") apiModel.value = modelPreset.value;
        else { apiModel.focus(); apiModel.select(); }
      });
      apiBase.addEventListener("change", () => {
        syncPresetFromFields();
        showProviderSwitchWarning();
      });
      apiModel.addEventListener("input", () => {
        const models = (apiPresets[apiPreset.value] || apiPresets.custom).models;
        const value = apiModel.value.trim();
        modelPreset.value = models.some(([model]) => model === value) ? value : "__custom__";
      });
      const apiKey = document.createElement("input");
      apiKey.type = "password";
      apiKey.autocomplete = "new-password";
      apiKey.placeholder = "输入 API Key";
      apiKey.title = "Key 只保存到 ComfyUI 后端本机配置；同一服务商留空表示不修改，切换服务商时必须输入该服务商的新 Key";
      apiKey.style.cssText = "min-width:170px;width:210px;";
      function showProviderSwitchWarning() {
        const oldHost = apiHost(savedApiBase);
        const newHost = apiHost(apiBase.value);
        if (oldHost && newHost && oldHost !== newHost && !apiKey.value.trim()) {
          aiStat.style.color = "#f2c94c";
          aiStat.textContent = "已切换 API 服务商，请输入该服务商自己的新 Key；不同服务商的 Key 不能通用";
          return true;
        }
        return false;
      }
      apiKey.addEventListener("input", () => {
        if (apiKey.value.trim()) {
          aiStat.style.color = "";
          aiStat.textContent = "已输入新 Key，可保存或测试连接";
        } else {
          showProviderSwitchWarning();
        }
      });
      const btnSaveApi = mk("button", "h3s-btn", "保存设置");
      btnSaveApi.title = "把 Base URL、模型名和 Key 保存到 ComfyUI user 目录";
      const btnTestApi = mk("button", "h3s-btn", "测试连接");
      btnTestApi.title = "保存当前设置并发送一次最短的连接测试";
      const btnGo = mk("button", "h3s-btn primary", "生成");
      btnGo.title = "保存当前 API 设置并生成段提示词";
      /* 生成模式（v1.15+）：智能生成=AI 自由创作；编写模式=用户在文本框写大白话分镜
         （如"2秒男人在花园闲逛，突然说：太阳好大"），AI 严格按描述的事件/时间点/台词
         转换成合规格式，不增删情节 */
      const selMode = document.createElement("select");
      selMode.innerHTML = '<option value="smart">智能生成</option>'
        + '<option value="compose">编写模式</option>';
      selMode.value = localStorage.getItem("h3_ai_mode") || "smart";
      selMode.title = "智能生成：AI 按创意自由撰写\n编写模式：你先在文本框写大白话分镜（事件+时间点+台词），AI 严格照你的描述转成合格提示词，不增删情节";
      selMode.addEventListener("change", () => localStorage.setItem("h3_ai_mode", selMode.value));

      const showApiError = (message) => {
        aiStat.textContent = message;
        aiStat.style.color = "#ff8080";
      };
      const loadApiConfig = async () => {
        try {
          const resp = await api.fetchApi("/h3director/api_config");
          const cfg = await resp.json();
          if (!resp.ok) throw new Error(cfg.error || ("HTTP " + resp.status));
          savedApiBase = cfg.base_url || "";
          apiBase.value = cfg.base_url || "";
          apiModel.value = cfg.model || "";
          syncPresetFromFields();
          apiKey.value = "";
          apiKey.placeholder = cfg.has_key ? "已保存，留空不修改" : "输入 API Key";
          aiStat.style.color = "";
          aiStat.textContent = cfg.configured ? "API 已配置" : "请填写并保存 API 设置";
          return cfg;
        } catch (e) {
          showApiError("API 配置查询失败：" + e.message + "（请重启 ComfyUI）");
          return null;
        }
      };
      const saveApiConfig = async (showSuccess = true) => {
        const oldHost = apiHost(savedApiBase);
        const newHost = apiHost(apiBase.value);
        if (oldHost && newHost && oldHost !== newHost && !apiKey.value.trim()) {
          throw new Error("你切换了 API 服务商，必须输入该服务商自己的新 API Key；不同服务商的 Key 不能通用。");
        }
        const resp = await api.fetchApi("/h3director/api_config", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            base_url: apiBase.value.trim(),
            model: apiModel.value.trim(),
            api_key: apiKey.value.trim(),
          }),
        });
        const cfg = await resp.json();
        if (!resp.ok || !cfg.ok) throw new Error(cfg.error || ("HTTP " + resp.status));
        savedApiBase = cfg.base_url || apiBase.value.trim();
        apiKey.value = "";
        apiKey.placeholder = cfg.has_key ? "已保存，留空不修改" : "输入 API Key";
        aiStat.style.color = "";
        if (showSuccess) aiStat.textContent = "API 设置已保存";
        return cfg;
      };
      await loadApiConfig();
      if (aiPanel !== openedPanel) return;

      btnSaveApi.addEventListener("click", async () => {
        btnSaveApi.disabled = true;
        try {
          aiStat.textContent = "正在保存 API 设置…";
          await saveApiConfig(true);
        } catch (e) { showApiError("保存失败：" + e.message); }
        btnSaveApi.disabled = false;
      });
      btnTestApi.addEventListener("click", async () => {
        btnTestApi.disabled = true;
        try {
          aiStat.textContent = "正在测试 API 连接…";
          await saveApiConfig(false);
          const resp = await api.fetchApi("/h3director/api_test", { method: "POST" });
          const r = await resp.json();
          if (!resp.ok || !r.ok) throw new Error(r.error || ("HTTP " + resp.status));
          aiStat.style.color = "";
          aiStat.textContent = "API 连接成功（" + (r.model || apiModel.value.trim()) + "）";
        } catch (e) { showApiError("连接失败：" + e.message); }
        btnTestApi.disabled = false;
      });
      btnGo.addEventListener("click", async () => {
        const draft = ta.value.trim();
        if (!draft) { aiStat.textContent = "提示词框是空的，先写点创意或大白话分镜"; return; }
        btnGo.disabled = true;
        aiStat.textContent = "AI 正在写提示词…";
        try {
          await saveApiConfig(false);
          const picFiles = [];
          if (s.use_tail !== false && sel > 0) {
            picFiles.push("video/tail_seg" + sel + "_00001_.png");
          }
          (s.refs || []).forEach((name) => { if (name) picFiles.push(name); });
          const voiceDesc = [];
          (s.voice_refs || []).forEach((name, k) => {
            voiceDesc.push("<Audio " + (k + 1) + "> 是音色参考音频 " + name + "，用于给角色配新台词");
          });
          const ctx = {
            dur: segDur(s).toFixed(1),
            pics: picFiles.length,
            picDesc: picFiles.length ? picFiles.map((f, i) => "Picture " + (i + 1) + "=" + f).join(", ") : "无",
            tail: s.use_tail !== false && sel > 0,
            voices: voiceDesc.length ? voiceDesc.join("；") + "。" : "没有使用音色/配音槽。",
            hasAudio: !!(s.audio && s.audio_src && s.audio_src !== "model"),
          };
          const userPrompt = (selMode.value === "compose" ? "请严格按照下面的大白话分镜转换成合格提示词，不增删情节：\n" : "请根据下面的创意/草稿写一段提示词：\n") + draft;
          const messages = [
            { role: "system", content: buildAiSys(ctx) },
            { role: "user", content: userPrompt },
          ];
          const r = await (await api.fetchApi("/h3director/ai_prompt", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              images: picFiles.filter((f) => !f.startsWith("video/")),
              tail_seg: (s.use_tail !== false && sel > 0) ? sel : null,
              mode: curMode(),
              project_id: ensureProjectId(),
              audio: (s.audio && s.audio_src && s.audio_src !== "model") ? s.audio : null,
              max_tokens: 1200,
              temperature: 0.7,
            }),
          })).json();
          if (r.content) {
            ta.value = r.content;
            commitTa();
            updateSL();
            aiStat.textContent = "已生成，已填入提示词框";
          } else {
            aiStat.textContent = "生成失败: " + (r.error || "无输出"); aiStat.style.color = "#ff8080";
          }
        } catch (e) { aiStat.textContent = "出错: " + e.message; aiStat.style.color = "#ff8080"; }
        btnGo.disabled = false;
      });
      aiPanel.append(
        mk("span", "h3s-hint", "AI 提示词："),
        mk("span", "h3s-hint", "生成方式"), selMode,
        mk("span", "h3s-hint", "API 预设"), apiPreset,
        mk("span", "h3s-hint", "API Base"), apiBase,
        mk("span", "h3s-hint", "模型选择"), modelPreset,
        mk("span", "h3s-hint", "模型 ID"), apiModel,
        mk("span", "h3s-hint", "API Key"), apiKey,
        btnSaveApi, btnTestApi, btnGo, aiStat,
        mk("span", "h3s-hint", "切换 API 服务商时必须输入对应的新 Key，旧 Key 不会跨服务商复用"),
        mk("span", "h3s-hint", "生成时会把当前段提示词和参考素材发送给你填写的 API"),
      );
      editRow.parentNode.insertBefore(aiPanel, editRow.nextSibling);
    });

    editRow.append(btnSelAllT, btnCopyT, btnPasteT, btnDelT, btnAI);
    editor.appendChild(editRow);
    editor.appendChild(navRow);

    /* 统一参考图条：多参模式是尾帧 → 本段图；端点模式固定按本段图从左到右取首/尾帧。 */
    if (!Array.isArray(s.refs)) s.refs = [];
    const refRoleMap = ensureRoleNameMap(node);
    s.refs.forEach((file) => getRefRoleName(node, file));
    const insertTag = (num) => {
      const tag = `<Picture ${num}>`;
      const st = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      ta.value = ta.value.slice(0, st) + tag + ta.value.slice(st);
      s.prompt = ta.value;
      save();
      ta.focus();
      ta.selectionStart = ta.selectionEnd = st + tag.length;
    };

    const refRow = mk("div", "h3s-row");
    const endpointMode = generationMode !== "multi_ref";
    const refDescription = generationMode === "text_to_video"
      ? "端点图（文生视频不会使用这些图片；可保留供切换模式后使用）："
      : generationMode === "first_frame"
        ? "端点图（第 1 张为首帧；其余图片不参与本段生成）："
        : generationMode === "first_last_frame"
          ? "端点图（从左到右第 1 张=首帧，第 2 张=尾帧；其余图片不参与本段生成）："
          : generationMode === "last_frame"
            ? "端点图（第 2 张为尾帧；若只上传 1 张则该图为尾帧）："
            : "角色/参考图（角色名默认取文件名；只需检查或修改一次。导入剧本时会自动分配到对应段）：";
    refRow.appendChild(mk("span", "h3s-hint", refDescription));
    editor.appendChild(refRow);
    const refs = mk("div", "h3s-refs");
    refs.style.height = "104px";
    refs.style.minHeight = "88px";

    const pics = [];
    if (s.use_tail === true && sel > 0) {
      pics.push({ src: api.apiURL("/h3director/tail?seg=" + sel + "&" + _modeQ() + "&t=" + Date.now()), tag: "尾帧" });
    }
    s.refs.forEach((name, k) => {
      const isLastEndpoint = generationMode === "last_frame"
        && k === (s.refs.length >= 2 ? 1 : 0);
      const tag = generationMode === "first_frame"
        ? (k === 0 ? "首帧" : "未使用")
        : generationMode === "first_last_frame"
          ? (k === 0 ? "首帧" : k === 1 ? "尾帧" : "未使用")
          : isLastEndpoint ? "尾帧"
            : generationMode === "last_frame" ? "未使用" : "角色图";
      pics.push({
        src: api.apiURL("/view?filename=" + encodeURIComponent(name) + "&type=input"),
        tag,
        refIdx: k,
        file: name,
        roleName: getRefRoleName(node, name),
      });
    });

    /* 拖拽换序（v1.16+）：本段参考图可拖到另一张上换位——顺序即 Picture 编号。
       用闭包变量记拖拽源（比 dataTransfer 跨浏览器稳，headless 也可测） */
    let dragRefIdx = null;
    pics.forEach((p, i) => {
      const num = i + 1;
      const card = mk("div", "h3s-role-card");
      const box = mk("div", "h3s-pic");
      box.title = `Picture ${num}（点击插入提示词）`;
      const img = document.createElement("img");
      img.src = p.src;
      img.onerror = () => { img.style.display = "none"; };
      const badge = mk("span", "num", `P${num}`);
      const tagEl = mk("span", "tag", p.tag);
      box.append(img, badge, tagEl);
      box.addEventListener("click", () => insertTag(num));
      if (p.refIdx != null) {
        box.draggable = true;
        box.style.cursor = "grab";
        box.title = `Picture ${num}（点击插入提示词；按住拖到别的图上可换顺序）`;
        box.addEventListener("dragstart", (ev) => {
          dragRefIdx = p.refIdx;
          box.style.opacity = "0.45";
          ev.stopPropagation();
        });
        box.addEventListener("dragend", () => {
          dragRefIdx = null;
          box.style.opacity = "";
          refs.querySelectorAll(".h3s-pic").forEach((x) => { x.style.outline = ""; });
        });
        box.addEventListener("dragover", (ev) => {
          if (dragRefIdx == null || dragRefIdx === p.refIdx) return;
          ev.preventDefault();  // 允许放置
          ev.stopPropagation();
          box.style.outline = "2px solid #4a9eff";
        });
        box.addEventListener("dragleave", () => { box.style.outline = ""; });
        box.addEventListener("drop", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (dragRefIdx == null || dragRefIdx === p.refIdx) return;
          const moved = s.refs.splice(dragRefIdx, 1)[0];
          s.refs.splice(p.refIdx, 0, moved);
          save();
          renderEditor();
          status.textContent = "参考图顺序已调整（Picture 编号已重排，请检查提示词里的 @图N）";
        });
        const x = mk("button", "x", "✕");
        x.title = "移除该参考图";
        x.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const removed = s.refs.splice(p.refIdx, 1)[0];
          const stillUsed = createSegs.some((seg) => Array.isArray(seg.refs) && seg.refs.includes(removed));
          if (!stillUsed) delete refRoleMap[removed];
          save();
          renderEditor();
        });
        box.appendChild(x);
      }
      card.appendChild(box);
      if (p.refIdx != null) {
        const roleInput = mk("input", "h3s-role-name");
        roleInput.type = "text";
        roleInput.value = p.roleName;
        roleInput.placeholder = "角色名";
        roleInput.title = "角色名默认取图片文件名；这里修改一次，所有段共用这张图时都会使用新名称";
        roleInput.addEventListener("pointerdown", (ev) => ev.stopPropagation());
        roleInput.addEventListener("click", (ev) => ev.stopPropagation());
        roleInput.addEventListener("input", () => {
          const value = roleInput.value.trim();
          refRoleMap[p.file] = value || roleNameFromFilename(p.file);
        });
        roleInput.addEventListener("change", () => {
          roleInput.value = String(refRoleMap[p.file] || roleNameFromFilename(p.file));
          save();
          status.textContent = "角色名已保存：" + roleInput.value;
        });
        card.appendChild(roleInput);
      } else {
        card.appendChild(mk("div", "h3s-role-static", "上段尾帧"));
      }
      refs.appendChild(card);
    });

    const add = mk("button", "h3s-btn", "+图");
    add.title = "添加本段参考图（可多选；拖缩略图可换顺序）";
    add.addEventListener("click", () => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.multiple = true;  // v1.16：支持全选/多选一次添加
      inp.addEventListener("change", async () => {
        if (!inp.files.length) return;
        status.textContent = "正在上传 " + inp.files.length + " 张参考图…";
        let ok = 0;
        for (const f of inp.files) {
          try {
            const fd = new FormData();
            fd.append("image", f, f.name);
            fd.append("overwrite", "true");
            const r = await (await api.fetchApi("/upload/image", { method: "POST", body: fd })).json();
            if (!r || !r.name) throw new Error(r && r.error || "上传接口没有返回文件名");
            const savedName = (r.subfolder ? r.subfolder + "/" : "") + r.name;
            s.refs.push(savedName);
            getRefRoleName(node, savedName, f.name);
            ok++;
          } catch (e) { console.error("[H3导演台] 参考图上传失败:", f.name, e); }
        }
        save(); renderEditor();
        status.textContent = "已添加 " + ok + "/" + inp.files.length
          + " 张参考图；角色名已按文件名填写，请在图片下方检查或修改";
      });
      inp.click();
    });
    refs.appendChild(add);
    editor.appendChild(refs);

    /* 缩略图尺寸强制跟随 refs 容器：拖柄回调里直接同步（主），
       ResizeObserver 兜底（辅）——不再单独依赖 RO 的触发时机 */
    const syncPicSize = () => {
      const h = Math.max(40, refs.clientHeight - 34);
      refs.querySelectorAll(".h3s-role-card").forEach((card) => {
        card.style.width = h + "px";
      });
      refs.querySelectorAll(".h3s-pic").forEach((p) => {
        p.style.width = h + "px";
        p.style.height = h + "px";
      });
    };
    attachBottomBar(refs, 140, 88, syncPicSize);
    observeEditorSize(refs, syncPicSize);
    syncPicSize();

    /* ---- 参考音色槽（A1~A3，对应 <Audio N>）：上传音频只作"声音模板"，
       模型用该音色说提示词里的新台词（如唐僧音色给人物1 配新词）。
       H3 最多 3 路独立参考音频：本段音频的「参考驱动」会占第 1 路，音色槽编号顺延 */
    const insertAudioTag = (num) => {
      const tag = `<Audio ${num}>`;
      const st = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      ta.value = ta.value.slice(0, st) + tag + ta.value.slice(st);
      s.prompt = ta.value;
      save();
      ta.focus();
      ta.selectionStart = ta.selectionEnd = st + tag.length;
    };
    const vbase = (s.audio_src === "ref" && s.audio) ? 1 : 0;
    const vmax = 3 - vbase;
    if (!Array.isArray(s.voice_refs)) s.voice_refs = [];
    if (!s.voice_labels) s.voice_labels = {};  // 内部名 -> 原始文件名（显示用）
    const vRow = mk("div", "h3s-row");
    vRow.appendChild(mk("span", "h3s-hint", "参考音色/配音（左上角=Audio编号，点击插入提示词；点槽上[音/词]切换模式）："));
    editor.appendChild(vRow);
    const vrefs = mk("div", "h3s-refs");
    vrefs.style.minHeight = "40px";
    /* 每一段独立记住参考音色区域尺寸。宽高缺失时保持旧版默认布局。 */
    const savedVoiceW = Number(s.voice_area_width);
    const savedVoiceH = Number(s.voice_area_height);
    if (Number.isFinite(savedVoiceW) && savedVoiceW >= 140) {
      vrefs.style.width = Math.round(savedVoiceW) + "px";
      vrefs.style.flex = "none";
    }
    if (Number.isFinite(savedVoiceH) && savedVoiceH >= 64) {
      vrefs.style.height = Math.round(savedVoiceH) + "px";
    }
    s.voice_refs.forEach((name, k) => {
      const num = vbase + k + 1;
      /* 显示原始文件名去扩展名（唐僧.mp3 -> 唐僧，槽块上即 "A1 唐僧"） */
      const disp = (s.voice_labels[name] || name).replace(/\.[^.]+$/, "");
      const voiceCard = mk("div", null);
      voiceCard.style.cssText = "display:flex;flex-direction:column;align-items:stretch;gap:4px;flex:none;";
      const box = mk("div", "h3s-pic");
      box.style.cssText = "position:relative;height:40px;width:auto;aspect-ratio:auto;display:flex;"
        + "align-items:center;gap:6px;padding:0 8px;border-radius:6px;border:1px solid #666;"
        + "cursor:pointer;flex:none;background:#1a2a22;";
      box.title = `<Audio ${num}>（点击插入提示词）: ${disp}`;
      const badge = mk("span", "num", `A${num}`);
      badge.style.cssText = "background:rgba(15,110,86,0.9);color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;";
      /* v1.12：槽级[音/词]切换已按用户要求移除（恢复 v1.7.3 纯音色槽）。
         后端 voice_modes/dub 声明路径保留兼容，旧配置不受影响。 */
      const nm = mk("span", null, disp.length > 18 ? disp.slice(0, 16) + "…" : disp);
      nm.style.cssText = "font-size:10px;color:#9fd8c3;";
      box.append(badge, nm);
      box.addEventListener("click", () => insertAudioTag(num));
      const x = mk("button", "x", "✕");
      x.style.cssText = "background:rgba(0,0,0,0.5);color:#fff;border:none;cursor:pointer;font-size:10px;padding:1px 4px;border-radius:3px;";
      x.title = "移除该参考音色";
      x.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (voicePreviewName === name) stopVoicePreview();
        s.voice_refs.splice(k, 1);
        delete s.voice_labels[name];
        save(); renderEditor();
      });
      box.appendChild(x);
      const playBtn = mk("button", "h3s-btn", "▶ 播放");
      playBtn.style.cssText = "width:100%;min-height:24px;padding:2px 8px;font-size:10px;";
      playBtn.title = "播放/暂停试听：" + disp;
      playBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (voicePreviewPlayer && voicePreviewName === name) {
          if (voicePreviewPlayer.paused) {
            try {
              await voicePreviewPlayer.play();
              playBtn.textContent = "⏸ 暂停";
            } catch (e) {
              status.textContent = "音色播放失败: " + e.message;
            }
          } else {
            voicePreviewPlayer.pause();
            playBtn.textContent = "▶ 播放";
          }
          return;
        }
        stopVoicePreview();
        const player = new Audio(api.apiURL("/view?filename=" + encodeURIComponent(name) + "&type=input"));
        player.preload = "auto";
        voicePreviewPlayer = player;
        voicePreviewButton = playBtn;
        voicePreviewName = name;
        player.addEventListener("ended", () => {
          if (voicePreviewPlayer === player) stopVoicePreview();
        });
        player.addEventListener("error", () => {
          if (voicePreviewPlayer === player) stopVoicePreview();
          status.textContent = "音色播放失败，请检查音频文件";
        });
        try {
          await player.play();
          playBtn.textContent = "⏸ 暂停";
        } catch (e) {
          stopVoicePreview();
          status.textContent = "音色播放失败: " + e.message;
        }
      });
      voiceCard.append(box, playBtn);
      vrefs.appendChild(voiceCard);
    });
    if (s.voice_refs.length < vmax) {
      const vadd = mk("button", "h3s-btn", "+音");
      vadd.title = "上传音频作为参考音色 <Audio " + (vbase + s.voice_refs.length + 1) + ">（只学音色，不复读内容）";
      vadd.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac";
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.addEventListener("change", async () => {
          try {
            if (!inp.files[0]) return;
            status.textContent = "正在上传参考音色…";
            const fd = new FormData();
            fd.append("audio", inp.files[0], inp.files[0].name);
            const resp = await api.fetchApi("/h3director/upload_audio", { method: "POST", body: fd });
            const r = await resp.json();
            if (r.ok && r.name) {
              s.voice_refs.push(r.name);
              s.voice_labels[r.name] = r.label || r.name;
              s.prompt = ta.value; save();
              status.textContent = "参考音色已添加";
              renderEditor();
            } else {
              status.textContent = "音色上传失败: " + (r.error || ("HTTP " + resp.status));
            }
          } catch (e) {
            status.textContent = "音色上传出错: " + e.message;
          } finally {
            inp.remove();
          }
        });
        inp.click();
      });
      vrefs.appendChild(vadd);
    } else {
      vrefs.appendChild(mk("span", "h3s-hint", "已达 3 路上限"));
    }
    editor.appendChild(vrefs);
    if (vbase) {
      editor.appendChild(mk("div", "h3s-hint", "注：本段音频的「参考驱动」已占用 <Audio 1>，音色槽编号从 A2 起"));
    }

    /* v1.8.1：「环境音垫」下拉已按用户要求移除——用户要的是 H3 原生生成（纯提示词驱动），
       不要后期垫层。后端 amb_audio 参数保留兼容（旧配置不影响），UI 不再提供入口。 */

    // ---- 本段音频：模型音频 / 参考驱动(对口型) 二选一（v1.7.3 起下架替换/混合） ----
    // 状态主字段是 s.audio_src（独立存储，不依赖是否已上传文件），
    // 否则选了"自定义"但没传文件时，renderEditor 重建会把选择弹回"模型音频"（选不中的 bug）。
    if (!s.audio_src) {
      s.audio_src = s.audio ? (s.audio_mode === "mix" ? "mix" : "replace") : "model";
    }
    const audioRow = mk("div", "h3s-row");
    audioRow.appendChild(mk("span", "h3s-hint", "本段音频："));
    const asrc = document.createElement("select");
    /* 替换/混合是 ffmpeg 事后贴轨、口型必然错位，已下架。
       旧工作流里已存 replace/mix 的段：动态补一个"旧版"选项保证能显示、能切走，后端逻辑不变。 */
    asrc.innerHTML = '<option value="model">模型音频（H3 生成）</option>'
                   + '<option value="ref">参考音频驱动（对口型，配音推荐）</option>';
    if (s.audio_src === "replace" || s.audio_src === "mix") {
      const legacy = document.createElement("option");
      legacy.value = s.audio_src;
      legacy.textContent = s.audio_src === "mix" ? "混合（旧版，不对口型）" : "自定义替换（旧版，不对口型）";
      asrc.appendChild(legacy);
    }
    asrc.value = s.audio_src;
    asrc.title = "模型音频：直接用 H3 生成的声音（无需上传）\n参考音频驱动：上传配音喂给 H3 当生成条件，模型听着它说台词，口型原生同步（配音首选）";
    asrc.addEventListener("change", () => {
      s.audio_src = asrc.value;
      if (asrc.value === "model") {
        s.audio = null;
      } else {
        s.audio_mode = asrc.value;
        if (!s.audio) status.textContent = "请点「+音频」上传本段配音文件";
      }
      s.prompt = ta.value; save(); renderTimeline(); renderEditor();
    });
    audioRow.appendChild(asrc);
    if (s.audio_src === "ref") {
      /* 参考音频的两种官方关系（MiniMax R2V 提示词指南）：
         fully_copy=音轨 1:1 复用（口型同步）；reference=只学音色（台词按提示词重新生成） */
      const rmode = document.createElement("select");
      rmode.innerHTML = '<option value="copy">复刻音轨（1:1 对口型）</option>'
                      + '<option value="timbre">仅音色参考（模型重新演绎）</option>';
      rmode.value = s.audio_ref_mode || "copy";
      rmode.title = "复刻音轨：模型把你的配音 1:1 用作成片音轨，画面口型对齐它（配音台词首选）\n仅音色参考：模型只学音色和语气，台词按提示词重新生成（声音克隆）";
      rmode.addEventListener("change", () => {
        s.audio_ref_mode = rmode.value;
        s.prompt = ta.value; save(); renderTimeline(); renderEditor();
      });
      audioRow.appendChild(rmode);
      /* v1.12：按用户要求恢复 v1.7.3 简洁形态——只保留单人对口型（复刻/仅音色），
         「双人对口型」按钮已移除。 */
    }

    if (s.audio_src !== "model") {
      if (s.audio) {
        audioRow.appendChild(mk("span", "h3s-hint", "♪ " + (s.audio_label || s.audio)));
        const ax = mk("button", "h3s-btn", "×");
        ax.title = "移除音频文件（自动切回模型音频）";
        ax.addEventListener("click", () => {
          s.audio = null; s.audio_label = null; s.audio_src = "model";
          s.prompt = ta.value; save(); renderTimeline(); renderEditor();
        });
        audioRow.appendChild(ax);

        /* 音量只在替换/混合模式有意义（ref 模式音轨由模型生成，音量不适用） */
        if (s.audio_src !== "ref") {
          audioRow.appendChild(mk("span", "h3s-hint", "音量"));
          const vol = document.createElement("input");
          vol.type = "number"; vol.min = "0.1"; vol.max = "2"; vol.step = "0.1";
          vol.value = s.audio_vol || 1.0;
          vol.style.width = "52px";
          vol.title = "自定义音频音量 0.1~2.0";
          vol.addEventListener("change", () => {
            s.audio_vol = parseFloat(vol.value) || 1.0; s.prompt = ta.value; save();
          });
          audioRow.appendChild(vol);
        }
      } else {
        audioRow.appendChild(mk("span", "h3s-hint", "（未上传，请点 +音频）"));
      }
      const aadd = mk("button", "h3s-btn", "+音频");
      aadd.title = "上传 wav/mp3/m4a 等音频作为本段配音";
      aadd.addEventListener("click", () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac";
        inp.style.display = "none";
        document.body.appendChild(inp);  // detached input 的 click() 在部分内核不弹窗
        inp.addEventListener("change", async () => {
          try {
            if (!inp.files[0]) return;
            status.textContent = "正在上传音频…";
            await uploadAudioToSeg(inp.files[0], sel);
            s.prompt = ta.value; save();
            status.textContent = "音频已上传";
            renderTimeline(); renderEditor();
          } catch (e) {
            status.textContent = "音频上传出错: " + e.message;
          } finally {
            inp.remove();
          }
        });
        inp.click();
      });
      audioRow.appendChild(aadd);

      /* 音频库（参考 WhatDreamsCost 的文件夹扫描）：input 目录已有音频下拉直接选用 */
      const alib = document.createElement("select");
      alib.style.maxWidth = "150px";
      alib.innerHTML = '<option value="">音频库…</option>';
      alib.title = "从 input 目录已有音频中直接选用（含以往上传的，无需重复上传）";
      alib.addEventListener("change", () => {
        if (!alib.value) return;
        s.audio = alib.value;
        s.prompt = ta.value; save();
        status.textContent = "段" + (sel + 1) + " 已选用音频库文件";
        renderTimeline(); renderEditor();
      });
      audioRow.appendChild(alib);
      api.fetchApi("/h3director/list_audio").then((r) => r.json()).then((d) => {
        for (const f of (d.files || [])) {
          const o = document.createElement("option");
          o.value = f.name;
          o.textContent = f.name;
          alib.appendChild(o);
        }
      }).catch(() => { /* 旧后端无此路由时下拉仅占位，重启 ComfyUI 后可用 */ });
    }
    editor.appendChild(audioRow);
    // 视觉上放在“本段音频”行之后；实际继续调整参考音色区，旧的尺寸记忆保持有效。
    attachBottomBar(vrefs, 140, 64, (width, height, finished) => {
      s.voice_area_width = Math.round(width);
      s.voice_area_height = Math.round(height);
      if (finished) {
        s.prompt = ta.value;
        save();
      }
    }, audioRow);

    // 云端无磁盘 latent 时的 Motion Context 视频续接。放在本段音频正下方，
    // 让用户明确知道：上传视频的末尾画面与音轨会一并进入 context_frames/context_audio。
    if (s.motion_context === true
      && motionContextSource === "video") {
      const uploadContextVideo = async (file) => {
        if (file.size > 200 * 1024 * 1024) throw new Error("视频不能大于 200 MB");
        status.textContent = "正在上传上下文视频并校验时长…";
        const fd = new FormData(); fd.append("video", file, file.name);
        const resp = await api.fetchApi("/h3director/upload_context_video", { method: "POST", body: fd });
        const data = await resp.json();
        if (!(data.ok && data.name)) throw new Error(data.error || ("HTTP " + resp.status));
        s.motion_context_video = data.name;
        s.motion_context_video_label = data.label || file.name;
        s.motion_context_video_duration = data.duration || null;
        save(); renderEditor();
        status.textContent = "上下文视频已上传：将用末尾画面帧和音频续接，不读取 latent";
      };
      const pickContextVideo = () => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo";
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.addEventListener("change", async () => {
          try {
            const file = inp.files && inp.files[0];
            if (!file) return;
            await uploadContextVideo(file);
          } catch (e) { status.textContent = "上下文视频上传失败: " + e.message; }
          finally { inp.remove(); }
        });
        inp.click();
      };
      const curContextVideo = s.motion_context_video;
      if (!curContextVideo) {
        const empty = mk("div", "h3s-vdz");
        empty.style.minHeight = "88px";
        empty.style.flex = "none";
        const upVideo = mk("button", "h3s-btn", "+ 上传上下文视频");
        upVideo.addEventListener("click", (ev) => { ev.stopPropagation(); pickContextVideo(); });
        empty.appendChild(upVideo);
        empty.appendChild(mk("div", "h3s-hint", "上传上一段成片。最大 200 MB｜时长 < 15 秒｜需含音轨"));
        editor.appendChild(empty);
      } else {
        const disp = s.motion_context_video_label || curContextVideo;
        const head = mk("div", "h3s-row");
        const badge = mk("span", "num", "<前段视频>");
        badge.style.cssText = "background:rgba(24,95,165,0.92);color:#fff;font-size:11px;padding:1px 6px;border-radius:4px;";
        head.appendChild(badge);
        head.appendChild(mk("span", "h3s-hint", disp));
        const btnRe = mk("button", "h3s-btn", "重新加载");
        btnRe.title = "重新选择并替换上下文视频";
        btnRe.addEventListener("click", pickContextVideo);
        const btnRm = mk("button", "h3s-btn", "✕ 移除");
        btnRm.title = "移除上下文视频";
        btnRm.addEventListener("click", () => {
          s.motion_context_video = null;
          s.motion_context_video_label = null;
          s.motion_context_video_duration = null;
          save(); renderEditor();
        });
        head.append(btnRe, btnRm);
        if (s.motion_context_video_duration) head.appendChild(mk("span", "h3s-hint",
          Number(s.motion_context_video_duration).toFixed(2) + "s"));
        head.appendChild(mk("span", "h3s-hint", "仅 Motion Context 使用，不计入参考视频，也不会生成 <Video N>"));
        editor.appendChild(head);

        const videoBox = mk("div", null);
        videoBox.style.cssText = "position:relative;width:360px;height:203px;flex:none;border-radius:8px;"
          + "overflow:hidden;background:#000;border:1px solid #3a5a7a;";
        const savedContextVideoSize = s.motion_context_video_box_size;
        if (savedContextVideoSize && Number.isFinite(Number(savedContextVideoSize.width))
          && Number.isFinite(Number(savedContextVideoSize.height))) {
          videoBox.style.width = Math.max(240, Math.round(Number(savedContextVideoSize.width))) + "px";
          videoBox.style.height = Math.max(135, Math.round(Number(savedContextVideoSize.height))) + "px";
        }
        const player = document.createElement("video");
        player.src = api.apiURL("/view?filename=" + encodeURIComponent(curContextVideo) + "&type=input");
        player.preload = "metadata";
        player.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;cursor:pointer;";
        player.title = "点击画面播放/暂停";
        player.addEventListener("click", () => { if (player.paused) player.play(); else player.pause(); });
        const nameOverlay = mk("span", null, disp);
        nameOverlay.style.cssText = "position:absolute;left:5px;top:4px;max-width:345px;overflow:hidden;text-overflow:ellipsis;"
          + "white-space:nowrap;color:#fff;font-size:10px;text-shadow:0 1px 2px #000;pointer-events:none;";
        videoBox.append(player, nameOverlay);
        editor.appendChild(videoBox);

        const controls = mk("div", "h3s-row");
        controls.style.cssText = "justify-content:center;gap:10px;";
        const play = mk("button", "h3s-btn primary", "▶ 播放");
        const pause = mk("button", "h3s-btn", "⏸ 暂停");
        const reset = mk("button", "h3s-btn", "⏹ 回开头");
        [play, pause, reset].forEach((b) => { b.style.minWidth = "86px"; });
        play.addEventListener("click", () => player.play());
        pause.addEventListener("click", () => player.pause());
        reset.addEventListener("click", () => { player.pause(); player.currentTime = 0; });
        controls.append(play, pause, reset);
        editor.appendChild(controls);
        attachBottomBar(videoBox, 240, 135, (width, height, finished) => {
          if (!finished) return;
          s.motion_context_video_box_size = { width: Math.round(width), height: Math.round(height) };
          save();
        }, controls);
      }
    }

    // 多参生视频的独立参考视频。前段视频（若有）始终在上方单列，只作为
    // Motion Context 上下文；这里的 1~3 个才会送入 H3 ref_videos / <Video N>。
    if (generationMode === "multi_ref") {
      if (!Array.isArray(s.video_refs)) s.video_refs = [];
      if (!s.video_labels || typeof s.video_labels !== "object") s.video_labels = {};
      if (!s.video_audio_refs || typeof s.video_audio_refs !== "object") s.video_audio_refs = {};
      // 视频参考与帧锚点一样可独立折叠；收起时不占用预览区和拖拽条的高度。
      const refVideoWrap = document.createElement("details");
      refVideoWrap.className = "h3s-slrow";
      refVideoWrap.style.cssText = "display:block;margin-top:5px;min-width:260px;overflow:visible;";
      refVideoWrap.open = s.video_ref_area_open !== false;
      refVideoWrap.addEventListener("toggle", () => { s.video_ref_area_open = refVideoWrap.open; save(); });
      const refVideoTitle = document.createElement("summary");
      refVideoTitle.className = "h3s-hint";
      refVideoTitle.style.cssText = "cursor:pointer;color:#9fd0ff;user-select:none;";
      refVideoTitle.textContent = "视频参考（" + s.video_refs.length + "/3 个；参与参考生成，可在提示词中用 <Video N>）";
      refVideoWrap.appendChild(refVideoTitle);

      const uploadRefVideo = async (file, replaceIndex = -1) => {
        if (!/\.(mp4|webm|mov|mkv|avi)$/i.test(file.name)) throw new Error("仅支持 mp4/webm/mov/mkv/avi 视频");
        if (replaceIndex < 0 && s.video_refs.length >= 3) throw new Error("最多只能上传 3 个参考视频");
        status.textContent = "正在上传参考视频…";
        const fd = new FormData(); fd.append("video", file, file.name);
        const resp = await api.fetchApi("/h3director/upload_video", { method: "POST", body: fd });
        const data = await resp.json();
        if (!(data.ok && data.name)) throw new Error(data.error || ("HTTP " + resp.status));
        if (replaceIndex >= 0) {
          const old = s.video_refs[replaceIndex];
          if (old) {
            delete s.video_labels[old];
            delete s.video_audio_refs[old];
          }
          s.video_refs[replaceIndex] = data.name;
        } else {
          s.video_refs.push(data.name);
        }
        s.video_labels[data.name] = data.label || file.name;
        save(); renderEditor();
        status.textContent = "参考视频已上传";
      };
      const chooseRefVideo = (replaceIndex = -1) => {
        const inp = document.createElement("input");
        inp.type = "file";
        inp.accept = "video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo";
        inp.style.display = "none";
        document.body.appendChild(inp);
        inp.addEventListener("change", async () => {
          try {
            const file = inp.files && inp.files[0];
            if (!file) return;
            await uploadRefVideo(file, replaceIndex);
          } catch (e) { status.textContent = "参考视频上传失败: " + e.message; }
          finally { inp.remove(); }
        });
        inp.click();
      };

      const refVideoGrid = mk("div", "h3s-refs");
      const hasRefVideos = s.video_refs.length > 0;
      // 有视频时需要为预览和“视频声音参考”留出高度；没有视频时只显示上传按钮，
      // 必须收回为紧凑高度，不能留着一整块 210px 的空参考区。
      refVideoGrid.style.cssText = hasRefVideos
        ? "height:210px;min-height:180px;align-items:flex-start;overflow:auto;resize:none;"
        : "height:64px;min-height:64px;align-items:center;overflow:visible;resize:none;";
      const savedRefVideoSize = s.video_ref_area_size;
      if (savedRefVideoSize && Number.isFinite(Number(savedRefVideoSize.width))
        && Number.isFinite(Number(savedRefVideoSize.height))) {
        refVideoGrid.style.flex = "none";
        refVideoGrid.style.width = Math.max(260, Math.round(Number(savedRefVideoSize.width))) + "px";
        // 旧的高度只在确实有视频卡片时恢复；空区永远保持紧凑。
        if (hasRefVideos) refVideoGrid.style.height = Math.max(180, Math.round(Number(savedRefVideoSize.height))) + "px";
      }
      s.video_refs.forEach((name, index) => {
        const card = mk("div", null);
        // 卡片与参考区同高；中间播放器使用 flex 填满剩余空间，拖动下方把手时
        // 视频画面会立刻变高/变矮，而不是只有外框变化。
        card.style.cssText = "width:220px;height:calc(100% - 8px);display:flex;flex-direction:column;flex:none;"
          + "border:1px solid #3a5a7a;border-radius:7px;overflow:hidden;background:#101318;";
        const head = mk("div", "h3s-row");
        head.style.cssText = "padding:4px 5px;gap:5px;";
        const badge = mk("span", "num", "V" + (index + 1));
        badge.style.cssText = "background:rgba(24,95,165,0.92);color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;";
        head.appendChild(badge);
        const label = s.video_labels[name] || name;
        const nameEl = mk("span", "h3s-hint", label);
        nameEl.style.cssText += "max-width:116px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        head.appendChild(nameEl);
        const reload = mk("button", "h3s-btn", "重载");
        reload.title = "重新选择该参考视频";
        reload.style.cssText = "padding:2px 5px;font-size:10px;";
        reload.addEventListener("click", () => chooseRefVideo(index));
        const remove = mk("button", "h3s-btn", "×");
        remove.title = "移除该参考视频";
        remove.style.cssText = "padding:2px 5px;font-size:10px;";
        remove.addEventListener("click", () => {
          const removed = s.video_refs.splice(index, 1)[0];
          delete s.video_labels[removed];
          delete s.video_audio_refs[removed];
          if (s.video_refs.length === 0) {
            const old = s.video_ref_area_size || {};
            s.video_ref_area_size = Number.isFinite(Number(old.width))
              ? { width: Math.round(Number(old.width)), height: null }
              : null;
          }
          save(); renderEditor();
        });
        head.append(reload, remove);
        const preview = document.createElement("video");
        preview.src = api.apiURL("/view?filename=" + encodeURIComponent(name) + "&type=input");
        preview.controls = true;
        preview.preload = "metadata";
        preview.style.cssText = "display:block;width:100%;height:auto;min-height:0;flex:1;object-fit:contain;background:#000;";
        const soundRow = mk("label", "h3s-row");
        soundRow.style.cssText = "padding:5px 7px;gap:5px;font-size:10px;cursor:pointer;";
        const soundCheck = document.createElement("input");
        soundCheck.type = "checkbox";
        soundCheck.checked = !!s.video_audio_refs[name];
        soundCheck.style.cssText = "width:15px;height:15px;accent-color:#378ADD;";
        soundCheck.title = "勾选后，把此视频的音轨接入对应的 ref_video_audio";
        soundCheck.addEventListener("change", () => {
          s.video_audio_refs[name] = soundCheck.checked;
          save();
          status.textContent = soundCheck.checked
            ? "<Video " + (index + 1) + "> 已启用视频声音参考"
            : "<Video " + (index + 1) + "> 已关闭视频声音参考";
        });
        soundRow.append(soundCheck, mk("span", "h3s-hint", "视频声音参考"));
        card.append(head, preview, soundRow);
        refVideoGrid.appendChild(card);
      });
      if (s.video_refs.length < 3) {
        const add = mk("button", "h3s-btn", "+ 上传参考视频");
        // 与左侧参考视频卡片等宽、同一高度，避免小按钮显得突兀。
        add.style.cssText = (hasRefVideos ? "height:calc(100% - 8px);" : "height:48px;")
          + "width:220px;min-width:220px;flex:none;";
        add.title = "最多 3 个；这些视频会参与 H3 参考生成";
        add.addEventListener("click", () => chooseRefVideo());
        refVideoGrid.appendChild(add);
      } else {
        refVideoGrid.appendChild(mk("span", "h3s-hint", "已达 3 个参考视频上限"));
      }
      refVideoWrap.appendChild(refVideoGrid);
      // 视频参考区也有专属把手；放在该区域底部，避免和本段音频的把手混淆。
      attachBottomBar(refVideoGrid, 260, 180, (width, height, finished) => {
        if (!finished) return;
        s.video_ref_area_size = { width: Math.round(width), height: Math.round(height) };
        save();
      });
      editor.appendChild(refVideoWrap);
    }

    // 视频参考在上，帧锚点在下；两块区域各自保留宽高和拖拽把手。
    appendGuideTrack(s, "创作");

    /* ---- 音频可视化裁剪：波形 + 左右拖柄选区间 + 保留/删除模式 + 起始偏移 ---- */
    if (s.audio) {
      const trimBox = mk("div", "h3s-trim");
      const tmodeRow = mk("div", "h3s-row");
      tmodeRow.appendChild(mk("span", "h3s-hint", "裁剪模式："));
      const tmode = document.createElement("select");
      tmode.innerHTML = '<option value="keep">保留选中区</option><option value="cut">删除选中区（中间挖掉）</option>';
      tmode.value = s.audio_trim_mode || "keep";
      tmode.title = "保留：只用选中的这段；删除：把选中的挖掉，首尾接起来";
      tmode.addEventListener("change", () => {
        s.audio_trim_mode = tmode.value;
        s.prompt = ta.value; save(); renderEditor();
      });
      tmodeRow.appendChild(tmode);
      trimBox.appendChild(tmodeRow);
      const cv = document.createElement("canvas");
      cv.className = "h3s-wave";
      cv.width = 520; cv.height = 46;
      trimBox.appendChild(cv);
      const trimInfo = mk("div", "h3s-hint", "波形加载中…");
      trimBox.appendChild(trimInfo);
      const trimWarn = mk("div", "h3s-audio-warn", "");
      trimWarn.style.display = "none";
      trimBox.appendChild(trimWarn);
      editor.appendChild(trimBox);

      loadWavePeaks(s.audio).then((wv) => {
        if (!wv || !wv.duration) { trimInfo.textContent = "波形加载失败（不影响生成）"; return; }
        const dur = wv.duration, W = cv.width, H = cv.height;
        let t0 = Math.min(Math.max(0, s.audio_trim_start || 0), dur);
        let t1 = (s.audio_trim_end > 0 && s.audio_trim_end <= dur) ? s.audio_trim_end : dur;
        if (t1 - t0 < 0.1) { t0 = 0; t1 = dur; }
        const x0 = () => t0 / dur * W, x1 = () => t1 / dur * W;
        const draw = () => {
          const g = cv.getContext("2d");
          g.clearRect(0, 0, W, H);
          const n = wv.peaks.length, bw = W / n;
          const isCut = s.audio_trim_mode === "cut";
          for (let i = 0; i < n; i++) {
            const h = Math.max(1, wv.peaks[i] * (H - 6));
            const x = i * bw;
            const inSel = x >= x0() && x <= x1();
            /* keep：选区绿/两侧暗绿；cut：选区红（要删的）/两侧绿（保留的） */
            g.fillStyle = inSel ? (isCut ? "#e05555" : "#39d98a") : (isCut ? "#39d98a" : "#2a4a3e");
            g.fillRect(x, (H - h) / 2, Math.max(1, bw - 0.5), h);
          }
          if (!isCut) {
            g.fillStyle = "rgba(0,0,0,0.55)";
            g.fillRect(0, 0, x0(), H);
            g.fillRect(x1(), 0, W - x1(), H);
          }
          g.fillStyle = "#ffd166";
          g.fillRect(x0() - 2, 0, 4, H);
          g.fillRect(x1() - 2, 0, 4, H);
        };
        const commit = () => {
          const isCut = s.audio_trim_mode === "cut";
          trimInfo.textContent = (isCut ? "删除 " : "裁剪 ") + t0.toFixed(1) + "s ~ " + t1.toFixed(1) +
            "s（全长 " + dur.toFixed(1) + "s" + (isCut ? "，保留首尾" : "，选中 " + (t1 - t0).toFixed(1) + "s") + "）";
          /* 音长警示：有效音频（含起始偏移）盖不住段长 → 尾部无声；超出 → 被截断 */
          const need = segDur(s) - (s.audio_offset || 0);
          const usable = isCut ? dur - (t1 - t0) : t1 - t0;
          if (usable < need - 0.3) {
            trimWarn.textContent = "⚠ 有效音频 " + usable.toFixed(1) + "s 盖不住段长 " + need.toFixed(1) + "s，尾部约 " + (need - usable).toFixed(1) + "s 将无声";
            trimWarn.style.display = "";
          } else if (usable > need + 0.3) {
            trimWarn.textContent = "⚠ 有效音频 " + usable.toFixed(1) + "s 超出段长 " + need.toFixed(1) + "s，超出部分将被截断";
            trimWarn.style.display = "";
          } else {
            trimWarn.style.display = "none";
          }
        };
        let dragSide = null;
        const evT = (ev) => {
          const r = cv.getBoundingClientRect();
          return Math.min(Math.max(((ev.clientX - r.left) * (W / r.width)) / W * dur, 0), dur);
        };
        cv.addEventListener("pointerdown", (ev) => {
          const r = cv.getBoundingClientRect();
          const x = (ev.clientX - r.left) * (W / r.width);
          dragSide = Math.abs(x - x0()) <= Math.abs(x - x1()) ? "l" : "r";
          cv.setPointerCapture(ev.pointerId);
          ev.preventDefault();
        });
        cv.addEventListener("pointermove", (ev) => {
          if (!dragSide) return;
          const t = evT(ev);
          if (dragSide === "l") t0 = Math.min(t, t1 - 0.1); else t1 = Math.max(t, t0 + 0.1);
          draw(); commit();
        });
        cv.addEventListener("pointerup", () => {
          if (!dragSide) return;
          dragSide = null;
          /* 贴边的裁剪值归 0（=不裁剪），让后端逻辑最简 */
          s.audio_trim_start = t0 <= 0.05 ? 0 : Math.round(t0 * 100) / 100;
          s.audio_trim_end = t1 >= dur - 0.05 ? 0 : Math.round(t1 * 100) / 100;
          s.prompt = ta.value; save();
        });
        draw(); commit();
      }).catch(() => { trimInfo.textContent = "波形加载失败（不影响生成）"; });

      const offRow = mk("div", "h3s-row");
      offRow.appendChild(mk("span", "h3s-hint", "起始偏移（配音从段内第 X 秒开始）："));
      const off = document.createElement("input");
      off.type = "number"; off.min = "0"; off.max = "60"; off.step = "0.1";
      off.value = s.audio_offset || 0;
      off.style.width = "56px";
      off.title = "0 = 段开头就播；超出段时长的部分自动截断";
      off.addEventListener("change", () => {
        s.audio_offset = Math.max(0, parseFloat(off.value) || 0);
        s.prompt = ta.value; save();
      });
      offRow.appendChild(off);
      editor.appendChild(offRow);
    }

    if (!SHOW_SAVED_SEGMENT_PREVIEW || node.properties.h3_segment_preview_hidden === true) { autoFitCompactPanel(); return; }
    // ---- 本段成片预览：点击段落即可查看已生成视频（带声音），方便定位想重跑的段 ----
    const pvWrap = mk("div", "h3s-pv");
    /* pvWrap 作为编辑区的弹性填充层：display:flex 后 pvBox 的 flex:1 才生效 */
    pvWrap.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:260px;gap:4px;";
    editor.appendChild(pvWrap);
    (async () => {
      const selectedSegment = sel;
      const shouldAutoPlay = autoPlaySegment === selectedSegment;
      if (shouldAutoPlay) autoPlaySegment = null;
      let src = null;
      if (shouldAutoPlay) {
        src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + Date.now());
      } else {
        try {
          const st = await (await api.fetchApi("/h3director/status?" + _modeQ())).json();
          const info = st.segments && st.segments[String(selectedSegment + 1)];
          if (info && info.video) {
            // 走插件自 serve 路由（内置 /view 对中文文件名 404 实测）；mtime 缓存指纹防旧片
            src = api.apiURL("/h3director/video?seg=" + (selectedSegment + 1) + "&" + _modeQ() + "&t=" + (info.mtime || Date.now()));
          }
        } catch (e) { /* 路由不可用时静默降级为提示 */ }
      }
      if (!src) {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.appendChild(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频，运行后可在此预览。"));
        return;
      }
      const headRow = mk("div", "h3s-row");
      headRow.appendChild(mk("div", "h3s-hint", "段" + (sel + 1) + " 成片预览："));
      const zoom = mk("button", "h3s-btn", "放大查看");
      zoom.title = "新窗口打开，原生分辨率播放";
      zoom.addEventListener("click", () => window.open(src, "_blank"));
      headRow.appendChild(zoom);
      const hidePreview = mk("button", "h3s-btn", "隐藏播放器");
      hidePreview.title = "隐藏播放器并收起预览区域";
      hidePreview.addEventListener("click", hideSegmentPreview);
      headRow.appendChild(hidePreview);
      headRow.appendChild(mk("span", "h3s-hint", "拖预览框右下角可自由缩放"));
      pvWrap.appendChild(headRow);
      /* 可缩放预览框：resize:both 拖右下角；object-fit:contain 保证画面完整不变形 */
      const pvBox = mk("div", "h3s-pvbox");
      /* 预览框自动填充编辑区剩余空间：节点（面板）拉大 → 预览跟着铺满，
         不再出现"上面一小条内容、下面大片黑"（用户录像实测问题） */
      pvBox.style.flex = "1";
      pvBox.style.minHeight = "220px";
      const v = document.createElement("video");
      v.src = src;
      v.controls = true;
      v.preload = "metadata";
      v.addEventListener("error", () => {
        pvWrap.style.flex = "none";
        pvWrap.style.minHeight = "0";
        pvWrap.replaceChildren(mk("div", "h3s-hint", "段" + (selectedSegment + 1) + " 尚未生成视频。"));
      }, { once: true });
      pvBox.appendChild(v);
      pvWrap.appendChild(pvBox);
      attachBottomBar(pvBox, 240, 135);
      if (shouldAutoPlay) {
        v.autoplay = true;
        v.play().catch(() => { /* 浏览器限制时保留原生播放按钮 */ });
      }
    })();
  }

  const onProgress = (e) => {
    const d = e.detail;
    if (d && d.max) progIn.style.width = Math.round((d.value / d.max) * 100) + "%";
  };
  const onExecuted = () => { progIn.style.width = "100%"; renderTimeline(); };
  api.addEventListener("progress", onProgress);
  api.addEventListener("executed", onExecuted);

  let cleaned = false;
  node.__h3Cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    api.removeEventListener("progress", onProgress);
    api.removeEventListener("executed", onExecuted);
    stopVoicePreview();
    disconnectEditorObservers();
    if (node.__h3ClaimedProjectId && activeProjectIds.get(node.__h3ClaimedProjectId) === node) {
      activeProjectIds.delete(node.__h3ClaimedProjectId);
    }
    node.__h3ClaimedProjectId = null;
    node.__h3Reload = null;
  };

  renderTimeline();
  renderEditor();
  node.setSize([Math.max(node.size[0], 760), Math.max(node.size[1], 320)]);
  node.__h3Reload = reloadFromWidget;
  return box;
}

// 主节点标题栏：显式设置为暗红色，避免被 ComfyUI 的输出节点默认绿色覆盖。
const H3_STUDIO_TITLE_COLOR = "#7A1F2B";
function applyStudioNodePalette(node) {
  node.color = H3_STUDIO_TITLE_COLOR;
  if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "H3ContextDirector.Studio",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "H3DirectorStudio") return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      applyStudioNodePalette(this);
      const container = document.createElement("div");
      container.style.cssText = "width:100%;height:430px;";
      const dw = this.addDOMWidget("director_ui", "h3studio", container, { serialize: false, hideOnZoom: false });
      /* 容器高度跟随节点尺寸（原来写死 430px：节点拉大后下半截全是黑边，
         "只能左右拉伸不能上下放大"的根因）。210 = 标题+接口行+标量widget+边距的实测占用。 */
      const TOP_RESERVED = 210;
      // 紧凑模式由 buildStudio 按实际内容主动设定节点高度；这里不能再强制
      // 300px 的 DOM 最小高度，否则末尾会留下随锚点数量跳动的灰色空白。
      const calcH = () => Math.max(0, this.size[1] - TOP_RESERVED);
      if (dw) dw.computedSize = () => [this.size[0], calcH()];
      /* 新版前端（Vue）用 computeLayoutSize 参与节点最小尺寸/布局计算。
         不声明时 DOMWidgetImpl 默认 minWidth=0/minHeight=50：节点一旦被折叠展开、
         自动排版等路径重算最小尺寸，宽度会塌到约 370px——面板"点击后变窄不可控"。
         声明后节点最小宽度被钳在设计值附近，任何路径都不会塌。 */
      if (dw) dw.computeLayoutSize = () => ({ minHeight: 0, minWidth: 700, maxHeight: undefined });
      /* 宽度看门狗：某些前端版本里 widget.width 会被写入一次旧值，之后 wrapper
         宽度就一直用它而不是节点宽度（面板比节点窄一截且无法恢复）。
         定时清掉 widget.width 并把 wrapper 宽度钳回节点宽度，幂等无副作用。 */
      const syncW = () => {
        try {
          if (dw && dw.width !== undefined) dw.width = undefined;
          const mg = ((dw && dw.margin) != null ? dw.margin : 10) * 2;
          const want = Math.max(0, Math.round(this.size[0] - mg)) + "px";
          const wrap = container.parentElement;
          if (wrap && wrap.style.width !== want) wrap.style.width = want;
        } catch (e) { /* 布局瞬态异常忽略，下一拍再试 */ }
      };
      this.__h3SyncTimer = setInterval(syncW, 500);
      const origRemoved = this.onRemoved;
      this.onRemoved = function () {
        clearInterval(this.__h3SyncTimer);
        if (typeof this.__h3Cleanup === "function") this.__h3Cleanup();
        this.__h3Cleanup = null;
        if (origRemoved) origRemoved.apply(this, arguments);
      };
      const syncH = () => { container.style.height = calcH() + "px"; };
      const origResize = this.onResize;
      this.onResize = function () {
        if (origResize) origResize.apply(this, arguments);
        syncH();
      };
      syncH();
      const panel = buildStudio(this);
      container.appendChild(panel);
      return r;
    };
    const origCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const r = origCfg ? origCfg.apply(this, arguments) : undefined;
      applyStudioNodePalette(this);
      if (this.__h3Reload) this.__h3Reload();
      return r;
    };
  },
});
