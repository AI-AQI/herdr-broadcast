// The broadcast web page: a board of broadcasts and the agents running them. Each agent's screen
// is shown read-only; answering or talking to one happens where it runs, in herdr-web-ui or Herdr.
// State arrives from /api/events (server-sent); changes go through the JSON API. Views are
// addressed by the hash so Back works: #/new, #/b/<broadcast>, and #/e/<execution>, which is
// its broadcast scrolled to that agent.
// A view is built once when it opens and then only patched, so typing and focus are never lost.
// Text from agents and prompts reaches the page only through textContent.
"use strict";

const STATES = {
  completed: ["ok", "已完成"], working: ["run", "执行中"], sent: ["run", "已发送"], sending: ["run", "发送中"], starting: ["run", "启动中"],
  blocked: ["ask", "等待输入"], queued: ["dim", "排队中"], failed: ["bad", "失败"], lost: ["bad", "已丢失"], cancelled: ["dim", "已取消"],
};
const ACTIVE = ["queued", "starting", "sending", "sent", "working", "blocked"];
const FINISHED = ["failed", "lost", "cancelled", "completed"];
const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GROW_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHRINK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DRAFT_KEY = "broadcast.draft";
/** a broadcast to send again, handed from its page to the new-broadcast form */
const PREFILL_KEY = "broadcast.prefill";
/** the detail page's counts, in the order they matter: who needs you first */
const SUMMARY = [
  ["blocked", ["blocked"], "ask", "等待输入"],
  ["running", ["starting", "sending", "sent", "working"], "run", "执行中"],
  ["queued", ["queued"], "dim", "排队中"],
  ["failed", ["failed", "lost"], "bad", "失败"],
  ["completed", ["completed"], "ok", "已完成"],
  ["cancelled", ["cancelled"], "dim", "已取消"],
];

let data = { state: { machines: [], broadcasts: [] }, agents: [], webUi: { installed: false, running: false } };
let loaded = false;
let config = { webUiUrl: null, kinds: ["claude"] };
let view = null; // { update(), dispose?() }

// ---- helpers ----------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "html") el.innerHTML = value; // fixed markup only (icons)
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} 小时前` : `${Math.round(hr / 24)} 天前`;
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

const tone = (state) => (STATES[state] || ["dim", state])[0];
const label = (state) => (STATES[state] || ["dim", state])[1];
const baseName = (path) => path.replace(/\/+$/, "").split("/").pop() || path;

function broadcastTone(b) {
  const c = b.counts;
  if (c.blocked) return "ask";
  if (ACTIVE.some((s) => c[s])) return "run";
  if ((c.failed || 0) + (c.lost || 0)) return "bad";
  if ((c.completed || 0) === b.total && b.total > 0) return "ok";
  return "dim";
}

function toast(text, error) {
  const el = h("div", { class: `toast${error ? " error" : ""}`, role: "status" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), error ? 6000 : 2600);
}

async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options && options.headers) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body.error && body.error.message) || `请求失败（${response.status}）`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

/**
 * A button that acts on its second press: the first turns it into "再点一次…" for three
 * seconds. For actions that cannot be taken back, in place of the browser's confirm(). With
 * `ask`, it asks only when that says there is something to lose, and acts at once otherwise.
 */
function confirmButton(text, confirmText, act, attrs, ask) {
  let timer = null;
  const button = h("button", { type: "button", ...attrs }, text);
  const disarm = () => { clearTimeout(timer); timer = null; button.classList.remove("armed"); button.textContent = text; };
  button.addEventListener("click", async () => {
    if (!timer && (!ask || ask())) {
      button.classList.add("armed");
      button.textContent = confirmText;
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    try { await act(); } catch (error) { toast(error.message, true); }
  });
  button.addEventListener("blur", disarm);
  return button;
}

function webUiBase() {
  if (config.webUiUrl) return config.webUiUrl.replace(/\/?$/, "/");
  return `${location.protocol}//${location.hostname}:7317/`;
}

/** herdr-web-ui on a pane, always in the same browser tab. */
function openInWebUi(query, mode) {
  const q = new URLSearchParams(query.replace(/^\?/, ""));
  q.set("view", mode);
  window.open(`${webUiBase()}?${q}`, "herdr-web-ui");
}

function findBroadcast(id) {
  return data.state.broadcasts.find((b) => b.id === id) || null;
}

function findExec(id) {
  for (const b of data.state.broadcasts) for (const e of b.executions) if (e.id === id) return { b, e };
  return null;
}

/**
 * Each machine as the page knows it: "up", "down" (its Herdr does not answer), "off" (turned
 * off in Herdr) or "loading". A machine that is down keeps the agents it had last.
 */
function machineState(id) {
  const m = data.state.machines.find((x) => x.id === id);
  if (m && !m.enabled) return { state: "off", error: null };
  const group = data.agents.find((g) => g.machine.id === id);
  if (!group) return { state: m ? "loading" : "down", error: null };
  if (group.error) return { state: "down", error: group.error };
  return { state: group.loading ? "loading" : "up", error: null };
}

const machineDown = (id) => machineState(id).state === "down";

/** what to do about a machine that does not answer */
function downReason(id) {
  return id === "local" ? "Herdr 没在运行，启动 herdr 后会自动恢复" : "连不上这台机器：检查 SSH，或在 Herdr 里重连它";
}

/** under a machine that does not answer: what to do, and Herdr's own words */
function downNote(id, error) {
  return h("div", { class: "down-note", role: "alert" }, h("span", null, downReason(id)), error ? h("span", { class: "why" }, error) : null);
}

/** The machines under the title: names only while they answer, red with why when one does not. */
function renderMachines() {
  const box = $("machines");
  const items = data.state.machines.map((m) => {
    const { state, error } = machineState(m.id);
    const title = state === "down" ? `${downReason(m.id)}\n${error || ""}`.trim() : state === "off" ? "在 Herdr 里已停用" : state === "loading" ? "读取中…" : "已连接";
    return h("span", { class: `m ${state}`, title },
      state === "down" ? h("span", { class: "dot bad" }) : null,
      h("span", null, state === "down" ? `${m.label} 连不上` : m.label));
  });
  box.replaceChildren(...items);
  box.hidden = items.length === 0;
}

/** Whether the reader has text selected inside an element (and so is copying from it). */
function selecting(el) {
  const s = getSelection();
  return !!s && !s.isCollapsed && (el.contains(s.anchorNode) || el.contains(s.focusNode));
}

/** A textarea that grows with its text, up to the CSS max-height. */
function autogrow(area) {
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight}px`; };
  area.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return area;
}

function sendButton(attrs) {
  return h("button", { class: "send", type: "submit", title: "发送", "aria-label": "发送", html: SEND_ICON, ...attrs });
}

// ---- an agent's screen, drawn with the colors it used -------------------------------------

/** The 16 base colors: a warm dark terminal palette, in Herdr's order (black … white, then bright). */
const PALETTE = [
  "#3b3a37", "#e0786f", "#9ccc8a", "#e8c37e", "#7fb0e0", "#c79be0", "#7ccbc6", "#d8d5cb",
  "#76736b", "#f19389", "#b6e0a3", "#f3d597", "#9dc6f0", "#dab4f0", "#9adfda", "#f5f3ec",
];

function color256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const level = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${level(Math.floor(c / 36))},${level(Math.floor(c / 6) % 6)},${level(c % 6)})`;
}

/** Applies one SGR sequence's parameters to a style. */
function applySgr(style, params) {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  for (let i = 0; i < codes.length; i += 1) {
    const c = codes[i];
    if (c === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false });
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.inverse = true;
    else if (c === 9) style.strike = true;
    else if (c === 22) { style.bold = false; style.dim = false; }
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.inverse = false;
    else if (c === 29) style.strike = false;
    else if (c >= 30 && c <= 37) style.fg = PALETTE[c - 30];
    else if (c >= 90 && c <= 97) style.fg = PALETTE[c - 90 + 8];
    else if (c >= 40 && c <= 47) style.bg = PALETTE[c - 40];
    else if (c >= 100 && c <= 107) style.bg = PALETTE[c - 100 + 8];
    else if (c === 39) style.fg = null;
    else if (c === 49) style.bg = null;
    else if (c === 38 || c === 48) {
      let value = null;
      if (codes[i + 1] === 5) { value = color256(codes[i + 2] || 0); i += 2; }
      else if (codes[i + 1] === 2) { value = `rgb(${codes[i + 2] || 0},${codes[i + 3] || 0},${codes[i + 4] || 0})`; i += 4; }
      if (c === 38) style.fg = value; else style.bg = value;
    }
  }
}

const SGR = /\x1b\[([0-9;:]*)m/g;
const BOX = /[─-╿]/g;

/**
 * A line drawn mostly of box-drawing characters (Claude's input box rules, a frame's top edge):
 * decoration as wide as the agent's terminal, which is cut at the panel's edge, not wrapped.
 */
function isRule(plain) {
  const ink = plain.replace(/\s/g, "");
  return ink.length >= 8 && (ink.match(BOX) || []).length >= ink.length * 0.8;
}

/**
 * Folds runs of blank lines into one and drops those at the top: a TUI pads its screen with
 * empty rows that only push the content apart. Styles on a dropped line carry to the next.
 */
function squeezeBlank(text) {
  const out = [];
  let carry = "";
  let blank = true;
  for (const line of text.split("\n")) {
    const empty = line.replace(SGR, "").trim() === "";
    if (empty && blank) {
      carry += (line.match(SGR) || []).join("");
      continue;
    }
    out.push(carry + line);
    carry = "";
    blank = empty;
  }
  return out.join("\n") + carry;
}

/**
 * Draws text with SGR styles into an element, a block per line: spans for styled runs, text
 * nodes for the rest. Long lines wrap at the panel's width; rules are cut instead.
 */
function renderAnsi(target, text) {
  const fragment = document.createDocumentFragment();
  const style = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
  for (const line of text.split("\n")) {
    // the blanks a terminal pads every line with would only wrap into empty rows
    const trimmed = line.replace(/[ \t]+((?:\x1b\[[0-9;:]*m)*)$/, "$1");
    const row = document.createElement("div");
    row.className = isRule(trimmed.replace(SGR, "")) ? "l rule" : "l";
    const run = (chunk) => {
      if (!chunk) return;
      const plain = !style.fg && !style.bg && !style.bold && !style.dim && !style.italic && !style.underline && !style.inverse && !style.strike;
      if (plain) { row.append(chunk); return; }
      const span = document.createElement("span");
      const fg = style.inverse ? style.bg || "var(--term-bg)" : style.fg;
      const bg = style.inverse ? style.fg || "var(--term-text)" : style.bg;
      if (fg) span.style.color = fg;
      if (bg) span.style.backgroundColor = bg;
      if (style.bold) span.style.fontWeight = "600";
      if (style.dim) span.style.opacity = "0.62";
      if (style.italic) span.style.fontStyle = "italic";
      if (style.underline || style.strike) span.style.textDecoration = `${style.underline ? "underline" : ""} ${style.strike ? "line-through" : ""}`.trim();
      span.textContent = chunk;
      row.append(span);
    };
    let last = 0;
    for (const m of trimmed.matchAll(SGR)) {
      run(trimmed.slice(last, m.index));
      applySgr(style, m[1]);
      last = m.index + m[0].length;
    }
    run(trimmed.slice(last));
    fragment.append(row);
  }
  target.replaceChildren(fragment);
}

/** The screens' type size, the reader's choice, kept in this browser. */
const screenFont = {
  min: 8,
  max: 24,
  normal: 14,
  get size() {
    const saved = Number(localStorage.getItem("broadcast.screenFont"));
    return saved >= this.min && saved <= this.max ? saved : this.normal;
  },
  set size(v) {
    localStorage.setItem("broadcast.screenFont", String(Math.max(this.min, Math.min(this.max, v))));
  },
};

// ---- routing ----------------------------------------------------------------------------

function parseRoute() {
  const match = /^#\/(new|b|e)(?:\/(\d+))?$/.exec(location.hash);
  if (!match) return { name: "home" };
  if (match[1] === "new") return { name: "new" };
  return { name: match[1] === "b" ? "broadcast" : "exec", id: Number(match[2]) };
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const r = parseRoute();
  const narrow = matchMedia("(max-width: 820px)").matches;
  // on a phone the list is the home screen; on a desktop the home screen is a new broadcast
  const name = r.name === "home" ? (narrow ? "list" : "new") : r.name;
  document.body.classList.toggle("in-main", name !== "list");
  if (view && view.dispose) view.dispose();
  const main = $("main");
  main.replaceChildren();
  view = name === "new" ? newView(main) : name === "broadcast" ? broadcastView(main, r.id, null) : name === "exec" ? broadcastView(main, null, r.id) : null;
  $("new").classList.toggle("current", name === "new");
  renderSidebar();
}

function topbar(...children) {
  return h("div", { class: "topbar" }, h("button", { class: "back", onclick: () => go(""), "aria-label": "返回列表" }, "‹ 广播"), ...children);
}

// ---- sidebar, title and notifications ---------------------------------------------------

/** The sidebar's groups, in order: what is running, then what finished, by day. */
function sidebarGroups() {
  const query = $("search").value.trim().toLowerCase();
  const shown = query ? data.state.broadcasts.filter((b) => `${b.title}\n${b.prompt}`.toLowerCase().includes(query)) : data.state.broadcasts;
  const today = new Date().setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const groups = [["进行中", []], ["今天", []], ["昨天", []], ["7 天内", []], ["更早", []]];
  for (const b of shown) {
    const at = b.created_at;
    const index = ACTIVE.some((s) => b.counts[s]) ? 0 : at >= today ? 1 : at >= today - day ? 2 : at >= today - 7 * day ? 3 : 4;
    groups[index][1].push(b);
  }
  return { query, shown, groups: groups.filter(([, items]) => items.length) };
}

/** The broadcast the page shows, if any: an agent's link opens its broadcast. */
function currentBroadcastId() {
  const r = parseRoute();
  return r.name === "broadcast" ? r.id : r.name === "exec" ? (findExec(r.id) || { b: {} }).b.id ?? null : null;
}

function renderSidebar() {
  const list = $("list");
  const scroll = list.scrollTop;
  const currentId = currentBroadcastId();
  const { query, shown, groups } = sidebarGroups();
  list.replaceChildren();
  if (loaded && data.state.broadcasts.length === 0) list.append(h("div", { class: "group" }, "还没有广播任务"));
  else if (query && shown.length === 0) list.append(h("div", { class: "group" }, "没有匹配的广播"));
  for (const [title, items] of groups) {
    list.append(h("div", { class: "group" }, title));
    for (const b of items) {
      const waiting = b.counts.blocked || 0;
      list.append(h("div", { class: "task" },
        h("button", { class: `task-row${currentId === b.id ? " current" : ""}`, onclick: () => go(`#/b/${b.id}`), title: b.title },
          h("span", { class: `dot ${broadcastTone(b)}` }),
          h("span", { class: "t" }, b.title),
          waiting
            ? h("span", { class: "n ask" }, `${waiting} 个等待输入　${ago(b.created_at)}`)
            : h("span", { class: "n" }, `完成 ${b.counts.completed || 0}/${b.total}　${ago(b.created_at)}`))));
    }
  }
  list.scrollTop = scroll;
  // after J or K: the row moved to stays in sight
  if (revealCurrent) {
    revealCurrent = false;
    const row = list.querySelector(".task-row.current");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

/** set by J and K, for the next sidebar drawing */
let revealCurrent = false;
/** Agents waiting for an answer: in the tab's title, and as a notification when the page is not in front. */
const waitingSeen = new Set();
let waitingPrimed = false;

function noticeWaiting() {
  const waiting = [];
  for (const b of data.state.broadcasts) for (const e of b.executions) if (e.state === "blocked") waiting.push({ b, e });
  document.title = waiting.length ? `(${waiting.length}) Herdr 广播` : "Herdr 广播";
  for (const { b, e } of waiting) {
    if (waitingSeen.has(e.id)) continue;
    waitingSeen.add(e.id);
    // the first load is not news
    if (!waitingPrimed || !document.hidden || !("Notification" in window) || Notification.permission !== "granted" || !notifySwitch.on) continue;
    const n = new Notification(`${e.agent_kind || "agent"} 在等你处理`, { body: b.title, tag: `exec-${e.id}` });
    n.onclick = () => { window.focus(); go(`#/e/${e.id}`); n.close(); };
  }
  for (const id of [...waitingSeen]) if (!waiting.some((w) => w.e.id === id)) waitingSeen.delete(id);
  waitingPrimed = true;
}

/**
 * Notifications: the browser's permission, asked once, and on top of it this page's own switch,
 * since a page cannot take a permission back. A whole row while the permission is still to be
 * asked; after that, a bell by the title that turns them off and on.
 */
const notifySwitch = {
  get on() { return localStorage.getItem("broadcast.notify") !== "0"; },
  set on(v) { localStorage.setItem("broadcast.notify", v ? "1" : "0"); },
};

function renderNotify() {
  const button = $("notify");
  const bell = $("bell");
  if (!("Notification" in window)) return;
  const state = Notification.permission;
  const ask = async () => {
    const answer = await Notification.requestPermission();
    if (answer === "granted") { notifySwitch.on = true; toast("已开启通知：agent 等待输入时提醒你"); }
    renderNotify();
  };
  button.hidden = state !== "default";
  button.parentElement.hidden = button.hidden;
  button.textContent = "🔔 开启通知：agent 等待输入时提醒";
  button.onclick = ask;
  bell.hidden = state === "default";
  const on = state === "granted" && notifySwitch.on;
  bell.textContent = on ? "🔔" : "🔕";
  bell.classList.toggle("off", !on);
  bell.setAttribute("aria-pressed", String(on));
  bell.title = state === "denied" ? "浏览器禁止了这个页面的通知" : on ? "通知已开启，点一下关闭" : "通知已关闭，点一下打开";
  bell.setAttribute("aria-label", bell.title);
  bell.onclick = () => {
    if (state === "denied") return toast("浏览器禁止了这个页面的通知：在地址栏左边的网站设置里允许通知，再刷新页面", true);
    notifySwitch.on = !notifySwitch.on;
    toast(notifySwitch.on ? "已开启通知" : "已关闭通知");
    renderNotify();
  };
}

// ---- a new broadcast: who above, the prompt in the box at the bottom ---------------------

const compose = {
  picked: new Set(), // "machine\0pane"
  newPicks: new Map(), // "machine\0cwd\0kind" -> { machine, cwd, kind, count }
  otherCwd: {},
  moreOpen: new Set(), // machines whose every folder shows
  get kind() { return localStorage.getItem("broadcast.newKind"); },
  set kind(v) { localStorage.setItem("broadcast.newKind", v); },
  freshCount() { return [...this.newPicks.values()].reduce((n, p) => n + p.count, 0); },
  total() { return this.picked.size + this.freshCount(); },
};

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; }
}

/** folders a machine lists before "更多目录" */
const FOLDERS_SHOWN = 5;

/** the type new agents get, as last chosen */
function currentKind() {
  return config.kinds.includes(compose.kind) ? compose.kind : config.kinds[0];
}

/** A broadcast handed over by "再发一次", taken once. */
function takePrefill() {
  const raw = sessionStorage.getItem(PREFILL_KEY);
  sessionStorage.removeItem(PREFILL_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function newView(main) {
  compose.picked.clear();
  compose.newPicks.clear();
  compose.otherCwd = {};
  const prefill = takePrefill();
  if (prefill) {
    for (const t of prefill.targets || []) compose.picked.add(`${t.machine}\0${t.pane}`);
    for (const p of prefill.fresh || []) compose.newPicks.set(`${p.machine}\0${p.cwd}\0${p.kind}`, { machine: p.machine, cwd: p.cwd, kind: p.kind, count: Math.min(20, p.count) });
  }
  const draft = prefill ? { title: prefill.title, prompt: prefill.prompt } : loadDraft();
  const saveDraft = () => localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, prompt: prompt.value }));

  const hero = h("div", { hidden: true },
    h("h1", { class: "hero" }, h("img", { class: "hero-mark", src: "/icon.svg", alt: "" }), "要广播什么？"),
    h("p", { class: "hero-sub" }, "先在下面选好发给谁，再在底部写 prompt。"));
  const targets = h("div");
  const filter = h("input", { class: "search filter", type: "search", placeholder: "筛选 agent：类型、名字、目录、标题", "aria-label": "筛选 agent", oninput: () => applyFilter() });
  const folders = h("div");
  // the type new agents get: one press each, not a menu
  const kindPills = h("span", { class: "kinds", role: "radiogroup", "aria-label": "新 agent 的类型" });
  const renderKinds = () => kindPills.replaceChildren(...config.kinds.map((k) => h("button", {
    type: "button", class: `kind-pill${k === currentKind() ? " on" : ""}`, role: "radio", "aria-checked": String(k === currentKind()),
    onclick: () => { compose.kind = k; renderKinds(); renderFolders(); },
  }, k)));
  renderKinds();

  const chipsBox = h("div", { class: "tchips", hidden: true });
  // the title is the prompt's first line unless one is given: out of the way until asked for
  const title = h("input", { class: "title-input", value: draft.title || "", placeholder: "默认取 prompt 第一行", oninput: () => { saveDraft(); syncTitle(); } });
  const titleRow = h("label", { class: "title-row", hidden: true }, h("span", null, "标题"), title);
  const titleToggle = h("button", { class: "title-toggle", type: "button", "aria-expanded": "false", onclick: () => {
    titleRow.hidden = !titleRow.hidden;
    titleToggle.setAttribute("aria-expanded", String(!titleRow.hidden));
    if (!titleRow.hidden) title.focus();
    else prompt.focus();
  } });
  const syncTitle = () => {
    const given = title.value.trim();
    titleToggle.textContent = given ? `标题：${Array.from(given).slice(0, 16).join("")}${Array.from(given).length > 16 ? "…" : ""}` : "标题：自动";
    titleToggle.title = given ? "改标题" : "标题默认取 prompt 第一行；点这里自己写";
  };
  syncTitle();
  const prompt = autogrow(h("textarea", { rows: "2", placeholder: "写下要发给每个 agent 的 prompt", "aria-label": "Prompt",
    // Enter sends, Shift+Enter breaks the line; not while an input method is still composing a word
    onkeydown: (event) => { if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); submit(); } },
    oninput: () => { saveDraft(); updateComposer(); } }));
  prompt.value = draft.prompt || "";
  if (prefill) saveDraft();
  const hint = h("span", { class: "hint" });
  const send = sendButton({ type: "button", onclick: () => submit() });

  // who it goes to, one kind at a time: new agents (the usual) or agents already running.
  // A broadcast can take both; each tab counts what is chosen in it.
  const newPanel = h("div", { class: "tabpanel", id: "tab-new", role: "tabpanel", "aria-labelledby": "tabbtn-new" },
    h("p", { class: "sub" }, "每个都是全新的会话，空白上下文。下面列出有 agent 在运行的目录，点 + 加一个；别的目录在「其他目录」里输入。"),
    h("div", { class: "newbar" }, h("span", { class: "nb-label" }, "类型"), kindPills),
    folders);
  const existingPanel = h("div", { class: "tabpanel", id: "tab-existing", role: "tabpanel", "aria-labelledby": "tabbtn-existing" },
    h("p", { class: "sub" }, "接着它们当前的对话执行；忙的会排队，空闲后自动发送。输入框里没发出去的草稿会和 prompt 一起发出，先确认是空的。"),
    filter,
    targets);
  const tabButton = (name, text) => h("button", { class: "tab", type: "button", role: "tab", id: `tabbtn-${name}`, "aria-controls": `tab-${name}`, onclick: () => showTab(name),
    // ← → between the two, as a tab list does
    onkeydown: (event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); showTab(name === "new" ? "existing" : "new"); $(`tabbtn-${name === "new" ? "existing" : "new"}`).focus(); } } },
    h("span", null, text), h("span", { class: "tab-count" }));
  const tabs = { new: tabButton("new", "新开 agent"), existing: tabButton("existing", "已有 agent") };
  const panels = { new: newPanel, existing: existingPanel };
  function showTab(name) {
    for (const k of Object.keys(tabs)) {
      const on = k === name;
      tabs[k].setAttribute("aria-selected", String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    }
  }
  // sent again from a broadcast with agents already running: those are what to look at
  showTab(prefill && (prefill.targets || []).length && !(prefill.fresh || []).length ? "existing" : "new");

  main.append(
    topbar(h("span", { class: "title" }, "新建广播")),
    h("div", { class: "scroll" }, h("div", { class: "column" },
      hero,
      h("div", { class: "tabs", role: "tablist", "aria-label": "发给谁" }, tabs.new, tabs.existing),
      newPanel,
      existingPanel)),
    h("div", { class: "dock" }, h("div", { class: "composer" }, chipsBox, titleRow, prompt,
      h("div", { class: "composer-foot" }, titleToggle, hint, h("span", { class: "spacer" }), send))));
  prompt.focus();

  const key = (machine, pane) => `${machine}\0${pane}`;
  /** the agent rows, kept so a status change patches a row instead of rebuilding the list */
  let targetsShape = "";
  const statusCells = new Map();
  /** rows to filter: each with the text it is found by, under its workspace's head */
  let filterRows = [];
  const matches = (row) => {
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => row.text.includes(w));
  };

  /** shows the rows that match; a workspace or machine with none left folds away */
  function applyFilter() {
    const active = filter.value.trim() !== "";
    for (const row of filterRows) row.el.hidden = active && !matches(row);
    for (const head of targets.querySelectorAll(".ws-head")) head.hidden = filterRows.every((r) => r.head !== head || r.el.hidden);
    for (const panel of targets.querySelectorAll(".panel[data-machine]")) {
      const left = filterRows.some((r) => r.panel === panel && !r.el.hidden);
      panel.hidden = active && !left;
    }
  }

  function statusOf(a) {
    if (a.ready) return ["ok", "空闲"];
    if (a.status === "working") return ["run", "忙"];
    if (a.status === "blocked") return ["ask", "等待确认"];
    return ["dim", a.status];
  }

  /**
   * agents by the workspace each runs in, as [its label, its agents]: by the workspace itself,
   * since two may carry the same label
   */
  function byWorkspace(agents) {
    const groups = new Map();
    for (const a of agents) {
      const id = a.workspace_id || a.workspace;
      if (!groups.has(id)) groups.set(id, [a.workspace, []]);
      groups.get(id)[1].push(a);
    }
    return [...groups.values()];
  }

  function renderTargets() {
    const shape = JSON.stringify(data.agents.map((g) => [g.machine.id, g.loading, !!g.error, g.agents.map((a) => [a.pane_id, a.workspace])]));
    if (shape === targetsShape) {
      // same agents as before: only their states move
      for (const group of data.agents) for (const a of group.agents) {
        const cell = statusCells.get(key(group.machine.id, a.pane_id));
        if (!cell || group.error) continue;
        const [t, text] = statusOf(a);
        cell.className = `st c-${t}`;
        cell.textContent = text;
      }
      return;
    }
    targetsShape = shape;
    statusCells.clear();
    filterRows = [];
    targets.replaceChildren();
    if (!loaded) targets.append(h("div", { class: "panel" }, h("div", { class: "empty-note" }, "正在读取各台机器上的 agent…")));
    for (const group of data.agents) {
      const id = group.machine.id;
      const down = !!group.error;
      const panel = h("div", { class: `panel${down ? " down" : ""}`, "data-machine": id }, h("div", { class: "panel-head" },
        h("span", null, id === "local" ? group.machine.label : `${group.machine.label}（SSH）`),
        down ? h("span", { class: "down-tag" }, "连不上") : h("span", { class: "meta" }, group.loading ? "读取中…" : `${group.agents.length} 个 agent`),
        h("span", { class: "spacer" }),
        h("button", { class: "btn quiet", type: "button", onclick: () => { for (const a of group.agents) compose.picked.delete(key(id, a.pane_id)); syncChecks(); } }, "清空")));
      // a machine that does not answer lists nothing: what it had last may be gone
      if (down) {
        panel.append(downNote(id, group.error));
        targets.append(panel);
        continue;
      }
      if (!group.loading && group.agents.length === 0) panel.append(h("div", { class: "empty-note" }, "这台机器上没有正在运行的 agent"));
      for (const [workspace, agents] of byWorkspace(group.agents)) {
        const head = h("div", { class: "ws-head" },
          h("span", null, workspace), h("span", null, `${agents.length} 个`), h("span", { class: "spacer" }),
          h("button", { class: "btn quiet", type: "button", disabled: down, title: "筛选时只选筛出来的", onclick: () => {
            const current = data.agents.find((g) => g.machine.id === id)?.agents || [];
            const idle = agents.filter((a) => (current.find((x) => x.pane_id === a.pane_id) || a).ready)
              .filter((a) => !filter.value.trim() || matches({ text: rowText(workspace, a) }));
            if (idle.length === 0) return toast(`「${workspace}」里没有空闲的 agent`, true);
            for (const a of idle) compose.picked.add(key(id, a.pane_id));
            syncChecks();
          } }, "选中空闲的"));
        panel.append(head);
        for (const a of agents) {
          const k = key(id, a.pane_id);
          const [t, text] = down ? ["dim", "—"] : statusOf(a);
          const cell = h("span", { class: `st c-${t}` }, text);
          statusCells.set(k, cell);
          const row = h("label", { class: "opt" },
            h("input", { type: "checkbox", "data-pick": k, checked: compose.picked.has(k), disabled: down, onchange: (event) => { if (event.target.checked) compose.picked.add(k); else compose.picked.delete(k); updateComposer(); } }),
            h("span", { class: "kind" }, a.kind),
            h("span", { class: "where" },
              h("span", { class: "name" }, a.name || a.pane_id),
              a.cwd ? h("span", { class: "dir", title: a.cwd }, baseName(a.cwd)) : null,
              a.title ? h("span", { class: "ttl" }, a.title) : null),
            cell);
          panel.append(row);
          filterRows.push({ el: row, head, panel, text: rowText(workspace, a) });
        }
      }
      targets.append(panel);
    }
    applyFilter();
  }

  function rowText(workspace, a) {
    return [a.kind, a.name, a.pane_id, a.cwd, a.title, workspace].filter(Boolean).join(" ").toLowerCase();
  }

  function syncChecks() {
    for (const box of targets.querySelectorAll("[data-pick]")) box.checked = compose.picked.has(box.dataset.pick);
    updateComposer();
  }

  /**
   * One more new agent of the current type in a folder. A folder typed in on this machine is
   * checked first: it must be there. `known`: a folder listed, or one already checked.
   */
  async function addNew(machine, cwd, known = false) {
    let path = (cwd || "").trim();
    if (path.length > 1) path = path.replace(/\/+$/, "");
    if (!path) return toast("先填写目录", true);
    if (machine !== "local" && !(path.startsWith("/") || path === "~" || path.startsWith("~/"))) return toast("远程机器的目录要写绝对路径，或以 ~ 开头", true);
    if (machine === "local" && !known) {
      try {
        const { target } = await api(`/api/dirs?machine=local&q=${encodeURIComponent(path)}`);
        if (!target || !target.exists) return toast(`本机没有这个目录：${path}`, true);
      } catch (error) { return toast(error.message, true); }
    }
    const kind = currentKind();
    const k = `${machine}\0${path}\0${kind}`;
    const pick = compose.newPicks.get(k) || { machine, cwd: path, kind, count: 0 };
    pick.count = Math.min(20, pick.count + 1);
    compose.newPicks.set(k, pick);
    if (compose.otherCwd[machine] && compose.otherCwd[machine].replace(/\/+$/, "") === path) compose.otherCwd[machine] = "";
    renderFolders();
    updateComposer();
  }

  function changeNew(k, delta) {
    const pick = compose.newPicks.get(k);
    if (!pick) return;
    pick.count = Math.min(20, pick.count + delta);
    if (pick.count <= 0) compose.newPicks.delete(k);
    renderFolders();
    updateComposer();
  }

  /** a folder: how many of each type it gets, as − n +, and + for the current type */
  function folderRow(machine, f) {
    const kind = currentKind();
    const picks = [...compose.newPicks.entries()].filter(([, p]) => p.machine === machine && p.cwd === f.path);
    const steppers = picks.map(([k, p]) => h("span", { class: "stepper" },
      h("span", { class: "sk" }, p.kind),
      h("button", { type: "button", "aria-label": `少一个 ${p.kind}`, onclick: () => changeNew(k, -1) }, "−"),
      h("span", { class: "sn", "aria-live": "polite" }, String(p.count)),
      h("button", { type: "button", "aria-label": `多一个 ${p.kind}`, disabled: p.count >= 20, onclick: () => changeNew(k, 1) }, "+")));
    const add = picks.some(([, p]) => p.kind === kind) ? null
      : h("button", { class: "plus1", type: "button", title: `在 ${f.name} 新开一个 ${kind}`, onclick: () => addNew(machine, f.path, true) }, `+ ${kind}`);
    return h("div", { class: "folder" },
      h("span", { class: "name", title: f.path }, f.name),
      h("span", { class: "path", title: f.path }, f.display, f.agents ? `　${f.agents} 个 agent 在这里` : ""),
      h("span", { class: "picks" }, steppers, add));
  }

  /**
   * "其他目录": a path typed by hand. On this machine, the folders under what is typed show
   * below it as it is typed: ↑↓ to choose, Tab to complete, Enter to add.
   */
  function otherRow(id) {
    const local = id === "local";
    let items = [];
    let active = -1;
    let timer = null;
    let asked = 0;
    const list = h("div", { class: "suggest", role: "listbox", "aria-label": "目录", hidden: true });
    const input = h("input", { value: compose.otherCwd[id] || "", "data-other": id, placeholder: local ? "其他目录，输入时会提示，例如 ~/Code/repo" : "其他目录，例如 ~/repo", "aria-label": "其他目录",
      autocomplete: "off", spellcheck: "false", role: local ? "combobox" : null, "aria-expanded": "false" });
    const show = () => {
      list.hidden = items.length === 0;
      input.setAttribute("aria-expanded", String(!list.hidden));
      list.replaceChildren(...items.map((s, i) => h("button", { type: "button", class: `sg${i === active ? " on" : ""}`, role: "option", "aria-selected": String(i === active), tabindex: "-1",
        // before the field loses focus to it
        onmousedown: (event) => { event.preventDefault(); choose(i); } }, s.value)));
    };
    const suggest = () => {
      if (!local) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const mine = ++asked;
        try {
          const { suggestions } = await api(`/api/dirs?machine=local&q=${encodeURIComponent(input.value)}`);
          if (mine !== asked || document.activeElement !== input) return;
          items = suggestions.slice(0, 8);
          active = -1;
          show();
        } catch { /* no suggestions, typing goes on */ }
      }, 120);
    };
    const choose = (i) => {
      input.value = items[i].value;
      compose.otherCwd[id] = input.value;
      input.focus();
      suggest();
    };
    input.addEventListener("input", () => { compose.otherCwd[id] = input.value; suggest(); });
    input.addEventListener("focus", suggest);
    input.addEventListener("blur", () => { clearTimeout(timer); asked += 1; items = []; show(); });
    input.addEventListener("keydown", (event) => {
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
        event.preventDefault();
        // through the suggestions and back to the field itself (-1)
        const n = items.length;
        if (event.key === "ArrowDown") active = active + 1 >= n ? -1 : active + 1;
        else active = active - 1 < -1 ? n - 1 : active - 1;
        show();
      } else if (event.key === "Tab" && !event.shiftKey && items.length) {
        event.preventDefault();
        choose(active >= 0 ? active : 0);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (active >= 0) choose(active);
        else addNew(id, input.value).then(() => { const again = folders.querySelector(`[data-other="${CSS.escape(id)}"]`); if (again) again.focus(); });
      } else if (event.key === "Escape" && items.length) {
        event.preventDefault();
        items = [];
        show();
      }
    });
    const kind = currentKind();
    return h("div", { class: "folder other" },
      h("span", { class: "name c-dim" }, "其他目录"),
      h("div", { class: "other-field" }, input, list),
      h("span", { class: "picks" }, h("button", { class: "plus1", type: "button", title: `在这个目录新开一个 ${kind}`, onclick: () => addNew(id, input.value) }, `+ ${kind}`)));
  }

  /** folders per machine: the first few, those with new agents, and the rest behind "更多" */
  function renderFolders() {
    folders.replaceChildren();
    for (const group of data.agents) {
      const id = group.machine.id;
      const known = new Set(group.folders.map((f) => f.path));
      const picked = (path) => [...compose.newPicks.values()].some((p) => p.machine === id && p.cwd === path);
      const panel = h("div", { class: "panel" }, h("div", { class: "panel-head" }, h("span", null, id === "local" ? group.machine.label : `${group.machine.label}（SSH）`)));
      // nothing new starts on a machine that does not answer: no folders to offer until it does
      if (group.error) {
        panel.classList.add("down");
        panel.firstChild.append(h("span", { class: "down-tag" }, "连不上"));
        panel.append(downNote(id, null));
        folders.append(panel);
        continue;
      }
      const open = compose.moreOpen.has(id);
      const shown = open ? group.folders : group.folders.filter((f, i) => i < FOLDERS_SHOWN || picked(f.path));
      for (const f of shown) panel.append(folderRow(id, f));
      const folded = group.folders.length - shown.length;
      if (folded > 0 || (open && group.folders.length > FOLDERS_SHOWN)) {
        panel.append(h("button", { class: "more-dirs", type: "button", "aria-expanded": String(open), onclick: () => {
          if (open) compose.moreOpen.delete(id); else compose.moreOpen.add(id);
          renderFolders();
        } }, open ? "收起" : `更多目录（${folded}）`));
      }
      const typed = [...new Set([...compose.newPicks.values()].filter((p) => p.machine === id && !known.has(p.cwd)).map((p) => p.cwd))];
      for (const cwd of typed) panel.append(folderRow(id, { name: baseName(cwd), path: cwd, display: cwd, agents: 0 }));
      if (group.folders.length === 0 && typed.length === 0) panel.append(h("div", { class: "empty-note" }, "这台机器上还没有 agent 在运行：在下面输入要开 agent 的目录"));
      panel.append(otherRow(id));
      folders.append(panel);
    }
  }

  /**
   * Who the prompt goes to, as small chips after "发给", every one of them: an agent by kind and
   * name, a new one as "+ kind · folder". × takes one off.
   */
  function renderChips() {
    const chips = [];
    for (const k of compose.picked) {
      const [machine, pane] = k.split("\0");
      const group = data.agents.find((g) => g.machine.id === machine);
      const agent = group && group.agents.find((a) => a.pane_id === pane);
      const where = machine === "local" ? "" : ` · ${group ? group.machine.label : machine}`;
      const down = machineDown(machine);
      chips.push(h("span", { class: `tchip${down ? " bad" : ""}`, title: down ? downReason(machine) : agent && agent.cwd ? agent.cwd : null }, `${agent ? agent.kind : "agent"} ${agent ? agent.name || pane : pane}${where}`,
        h("button", { type: "button", "aria-label": "不发给它", onclick: () => { compose.picked.delete(k); syncChecks(); } }, "×")));
    }
    for (const [k, p] of compose.newPicks) {
      const down = machineDown(p.machine);
      const where = p.machine === "local" ? "" : ` · ${(data.agents.find((g) => g.machine.id === p.machine) || { machine: { label: p.machine } }).machine.label}`;
      chips.push(h("span", { class: `tchip fresh${down ? " bad" : ""}`, title: down ? downReason(p.machine) : `新开 ${p.count} 个 ${p.kind}，在 ${p.cwd}` },
        `+ ${p.kind}${p.count > 1 ? ` ×${p.count}` : ""} · ${baseName(p.cwd)}${where}`,
        h("button", { type: "button", "aria-label": "不新开这些", onclick: () => { compose.newPicks.delete(k); renderFolders(); updateComposer(); } }, "×")));
    }
    chipsBox.hidden = chips.length === 0;
    chipsBox.replaceChildren(h("span", { class: "to" }, "发给"), ...chips);
  }

  /** chosen agents and new ones on machines that do not answer: they could not be reached */
  function stranded() {
    return [...compose.picked].filter((k) => machineDown(k.split("\0")[0])).length
      + [...compose.newPicks.values()].filter((p) => machineDown(p.machine)).reduce((n, p) => n + p.count, 0);
  }

  function updateComposer() {
    renderChips();
    // what is chosen in each tab, seen from the other
    for (const [name, n] of [["new", compose.freshCount()], ["existing", compose.picked.size]]) {
      const count = tabs[name].querySelector(".tab-count");
      count.textContent = n ? String(n) : "";
      count.hidden = !n;
    }
    const away = stranded();
    const ready = compose.total() > 0 && prompt.value.trim() !== "" && away === 0;
    send.disabled = !ready;
    // the placeholder already asks for the prompt: the line below says only what it does not
    const why = compose.total() === 0 ? "先在上面选择发给谁"
      : away ? `${away} 个在连不上的机器上（红色标签）：点 × 去掉，或等机器恢复`
      : !prompt.value.trim() ? "" : `↵ 发送给 ${compose.total()} 个 agent　⇧↵ 换行`;
    hint.textContent = why;
    hint.classList.toggle("c-bad", away > 0);
    send.title = why || "先写下 prompt";
  }

  function refresh() {
    hero.hidden = !(loaded && data.state.broadcasts.length === 0);
    renderTargets();
    // not under a folder being typed: rebuilding would take the cursor away
    if (!folders.contains(document.activeElement)) renderFolders();
    updateComposer();
  }

  async function submit() {
    if (!prompt.value.trim()) return toast("prompt 不能为空", true);
    if (compose.total() === 0) return toast("至少选择一个 agent，或新启动一个", true);
    if (stranded()) return toast(`${stranded()} 个在连不上的机器上：去掉它们，或等机器恢复`, true);
    send.disabled = true;
    try {
      const { id, executions } = await post("/api/broadcasts", {
        title: title.value, prompt: prompt.value,
        targets: [...compose.picked].map((k) => { const [machine, pane] = k.split("\0"); return { machine, pane }; }),
        new: [...compose.newPicks.values()].map((p) => ({ machine: p.machine, kind: p.kind, cwd: p.cwd, count: p.count })),
      });
      localStorage.removeItem(DRAFT_KEY);
      toast(`已发出广播，共 ${executions} 个 agent`);
      go(`#/b/${id}`);
    } catch (error) {
      toast(error.message, true);
      updateComposer();
    }
  }

  refresh();
  return { update: refresh };
}

// ---- a broadcast: its prompt, and every agent's screen, read-only ----------------------------

/**
 * `id`: the broadcast; or `focusExec`, an execution whose broadcast to show, scrolled to that
 * agent (a link from a notification). The screens are only watched here: answering, stopping or
 * talking happens where the agent runs, in herdr-web-ui or Herdr.
 */
function broadcastView(main, id, focusExec) {
  const titleEl = h("span", { class: "title" });
  const bubble = h("div", { class: "bubble clamp" });
  // a long prompt is folded to its first lines, so the screens start on the first page
  const more = h("button", { class: "btn quiet more", type: "button", hidden: true, onclick: () => {
    const folded = bubble.classList.toggle("clamp");
    more.textContent = folded ? "展开全文" : "收起";
  } }, "展开全文");
  const metaText = h("span");
  const meta = h("div", { class: "bubble-meta" }, more, h("span", { class: "spacer" }), metaText);
  const hint = h("p", { class: "webui-hint", hidden: true });
  const summary = h("div", { class: "summary", role: "group", "aria-label": "按状态跳到 agent" });
  const wall = h("div", { class: "wall" });
  const body = h("div", { class: "column wide" }, bubble, meta, hint, summary, wall);
  const fontLabel = h("button", { class: "btn quiet", type: "button", title: `恢复默认 ${screenFont.normal}px` });
  /** one size for every screen on the wall, at once */
  const applyFont = (size) => {
    screenFont.size = size;
    wall.style.setProperty("--screen-font", `${screenFont.size}px`);
    fontLabel.textContent = `${screenFont.size}px`;
  };
  const fontControl = h("span", { class: "font-size", role: "group", "aria-label": "终端文字大小" },
    h("button", { class: "btn quiet", type: "button", title: "文字小一点", "aria-label": "文字小一点", onclick: () => applyFont(screenFont.size - 1) }, "A−"),
    fontLabel,
    h("button", { class: "btn quiet", type: "button", title: "文字大一点", "aria-label": "文字大一点", onclick: () => applyFont(screenFont.size + 1) }, "A+"));
  fontLabel.addEventListener("click", () => applyFont(screenFont.normal));
  applyFont(screenFont.size);
  const actions = h("span", { class: "top-actions" });
  main.append(topbar(titleEl, h("span", { class: "spacer" }), actions, fontControl), h("div", { class: "scroll" }, body));
  let actionsFor = null;
  let summaryFor = null;
  let focused = false;
  let disposed = false;
  let readTimer = null;
  /** panels by execution; built once, then patched */
  const panels = new Map();
  /** panels on screen: only those are read */
  const visible = new Set();
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const execId = Number(entry.target.dataset.exec);
      if (entry.isIntersecting) visible.add(execId);
      else visible.delete(execId);
    }
  });
  /** which panel of each state the summary jumped to last, so pressing again goes to the next */
  const jumped = new Map();
  // running times move every second
  const ticker = setInterval(() => { if (!document.hidden) update(); }, 1000);

  const broadcastId = () => {
    if (id !== null) return id;
    const found = findExec(focusExec);
    return found ? found.b.id : null;
  };

  function flash(el) {
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("focus");
    void el.offsetWidth;
    el.classList.add("focus");
    setTimeout(() => el.classList.remove("focus"), 2500);
  }

  /** counts by state, each a button to the agents in it */
  function renderSummary(b) {
    // agents on a machine that does not answer come first: nothing about them can be known now
    const away = b.executions.filter((e) => e.pane_id && machineDown(e.machine_id));
    const groups = [{ key: "down", t: "bad", text: "连不上", list: away },
      ...SUMMARY.map(([key, states, t, text]) => ({ key, t, text, list: b.executions.filter((e) => states.includes(e.state)) }))].filter((g) => g.list.length);
    const shape = groups.map((g) => `${g.key}:${g.list.map((e) => e.id).join(",")}`).join("|");
    if (shape === summaryFor) return;
    summaryFor = shape;
    summary.replaceChildren(...groups.map((g) => h("button", { class: "sum", type: "button", title: `跳到${g.text}的 agent`, onclick: () => {
      const next = ((jumped.get(g.key) ?? -1) + 1) % g.list.length;
      jumped.set(g.key, next);
      const panel = panels.get(g.list[next].id);
      if (panel) flash(panel.el);
    } }, h("span", { class: `dot ${g.t}` }), `${g.text} ${g.list.length}`)));
  }

  /** The same prompt to the same agents, as a new broadcast to look over before it goes. */
  function rebroadcast(b) {
    const targets = new Map();
    const fresh = new Map();
    let missing = 0;
    for (const e of b.executions) {
      const group = data.agents.find((g) => g.machine.id === e.machine_id);
      if (e.pane_id && group && group.agents.some((a) => a.pane_id === e.pane_id)) targets.set(`${e.machine_id}\0${e.pane_id}`, { machine: e.machine_id, pane: e.pane_id });
      else if (e.target_kind === "new" && e.cwd && group) {
        const k = `${e.machine_id}\0${e.cwd}\0${e.agent_kind}`;
        const pick = fresh.get(k) || { machine: e.machine_id, cwd: e.cwd, kind: e.agent_kind, count: 0 };
        pick.count += 1;
        fresh.set(k, pick);
      } else missing += 1;
    }
    sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ title: b.title, prompt: b.prompt, targets: [...targets.values()], fresh: [...fresh.values()] }));
    if (missing) toast(`${missing} 个 agent 已经不在了，没有选上`);
    go("#/new");
  }

  function waitingText(e) {
    if (e.state === "queued" && !e.pane_id) return "排队中，agent 还没启动…";
    if (e.state === "starting") return "agent 启动中…";
    if (e.state === "failed" && !e.pane_id) return "没有启动起来";
    if (e.state === "cancelled" && !e.pane_id) return "已取消";
    return "读取中…";
  }

  function opens(e) {
    const buttons = [];
    // only where the prompt most likely never got through: a turn that finished is not retried
    if (e.state === "failed" || e.state === "lost") {
      buttons.push(h("button", { class: "btn primary", type: "button", title: e.pane_id ? "把这条广播再发一次给这个 agent；它不在了就新开一个" : "重新启动并发送", onclick: async () => {
        try { await post(`/api/executions/${e.id}/retry`); toast("已重新排队，会再发一次"); } catch (error) { toast(error.message, true); }
      } }, "重试"));
    }
    if (!e.pane_id) return buttons;
    buttons.push(h("button", { class: "btn", type: "button", title: "让 Herdr 把焦点切到这个 agent", onclick: async () => {
      try { const { message } = await post(`/api/executions/${e.id}/focus`); toast(message); } catch (error) { toast(error.message, true); }
    } }, "在 Herdr 里打开"));
    if (data.webUi.running && e.web_link) {
      buttons.push(
        h("button", { class: "btn", type: "button", onclick: () => openInWebUi(e.web_link, "chat") }, "打开对话"),
        h("button", { class: "btn", type: "button", onclick: () => openInWebUi(e.web_link, "terminal") }, "打开终端"));
    }
    return buttons;
  }

  function panelFor(e) {
    const dot = h("span", { class: "dot" });
    const who = h("span", { class: "who" });
    const state = h("span", { class: "state" });
    const where = h("span", { class: "where" });
    const note = h("span", { class: "note", hidden: true });
    const opensBox = h("span", { class: "opens" });
    const pre = h("pre", { class: "wait", "aria-label": "终端画面（只读）", tabindex: "0" }, waitingText(e));
    const el = h("section", { class: "screen-panel", id: `exec-${e.id}`, "data-exec": String(e.id) });
    const grow = h("button", { class: "icon-btn", type: "button", "aria-pressed": "false", title: "放大（Esc 恢复）", "aria-label": "放大", html: GROW_ICON, onclick: () => toggleBig(panel) });
    // a double click on the head, not the screen: there it selects a word to copy
    const head = h("div", { class: "screen-head", ondblclick: (event) => { if (!event.target.closest("button")) toggleBig(panel); } },
      dot, who, state, grow, where, opensBox, note);
    el.append(head, pre);
    observer.observe(el);
    const panel = { el, dot, who, state, where, note, opensBox, pre, grow, opensKey: null, last: null, gone: null, nextRead: 0 };
    return panel;
  }

  /** one agent across the whole row, taller, to read it closely; again to put it back */
  function toggleBig(panel, big = !panel.el.classList.contains("big")) {
    panel.el.classList.toggle("big", big);
    panel.grow.innerHTML = big ? SHRINK_ICON : GROW_ICON;
    panel.grow.setAttribute("aria-pressed", String(big));
    panel.grow.setAttribute("aria-label", big ? "恢复" : "放大");
    panel.grow.title = big ? "恢复（Esc）" : "放大（Esc 恢复）";
    if (big) panel.el.scrollIntoView({ block: "nearest" });
  }

  /** Esc: the panels that were made big go back; says whether there was any */
  function escape() {
    const big = [...panels.values()].filter((p) => p.el.classList.contains("big"));
    for (const p of big) toggleBig(p, false);
    return big.length > 0;
  }

  /** shows a line of explanation in place of the screen */
  function waitOn(panel, text) {
    panel.last = null;
    panel.pre.className = "wait";
    panel.pre.textContent = text;
  }

  function patch(panel, e) {
    panel.el.classList.toggle("ask", e.state === "blocked");
    panel.dot.className = `dot ${tone(e.state)}`;
    panel.who.textContent = `${e.agent_kind || "agent"}${e.agent_name ? `　${e.agent_name}` : ""}${e.target_kind === "new" ? "　新启动" : ""}`;
    const elapsed = e.sent_at ? `　${duration((e.finished_at || Date.now()) - e.sent_at)}` : "";
    panel.state.className = `state c-${tone(e.state)}`;
    panel.state.textContent = `${label(e.state)}${elapsed}`;
    panel.where.textContent = [e.machine_label, e.pane_id, e.workspace_label].filter(Boolean).join("　");
    // its machine not answering says more than any state it had
    const down = !!e.pane_id && machineDown(e.machine_id);
    panel.el.classList.toggle("down", down);
    const note = down ? `${e.machine_label || "这台机器"}连不上：${downReason(e.machine_id)}` : e.error || e.note || "";
    panel.note.hidden = !note;
    panel.note.className = `note${down || e.error ? " bad" : ""}`;
    panel.note.textContent = note;
    const opensKey = `${e.state === "failed" || e.state === "lost"}|${e.pane_id}|${e.web_link}|${data.webUi.running}`;
    if (panel.opensKey !== opensKey) {
      panel.opensKey = opensKey;
      panel.opensBox.replaceChildren(...opens(e));
    }
    if (!e.pane_id && panel.pre.textContent !== waitingText(e)) waitOn(panel, waitingText(e));
  }

  /**
   * Reads the screens on view, one after another, then waits and goes again. A screen that has
   * not changed is not drawn again, and one with text selected in it waits, so it can be copied.
   * An agent that finished is read less often; one that has closed, not at all.
   */
  async function read() {
    const b = findBroadcast(broadcastId());
    for (const e of b ? b.executions : []) {
      if (disposed) return;
      const panel = panels.get(e.id);
      if (!panel || !e.pane_id || !visible.has(e.id) || document.hidden) continue;
      const finished = FINISHED.includes(e.state);
      if (finished && panel.gone === e.pane_id) continue;
      // its machine does not answer: the last screen stays, and reading starts again when it does
      if (machineDown(e.machine_id)) {
        if (panel.last === null) waitOn(panel, `${e.machine_label || "这台机器"}连不上，画面会在它恢复后回来`);
        continue;
      }
      if (Date.now() < panel.nextRead || selecting(panel.pre)) continue;
      panel.nextRead = finished ? Date.now() + 5000 : 0;
      try {
        const { text } = await api(`/api/executions/${e.id}/screen`);
        const pre = panel.pre;
        const screen = squeezeBlank(text.replace(/(\s|\x1b\[[0-9;:]*m)+$/, ""));
        panel.gone = null;
        if (screen === panel.last || selecting(pre)) continue;
        const atBottom = panel.last === null || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
        panel.last = screen;
        pre.className = "";
        if (screen === "") pre.textContent = "（空白）";
        else renderAnsi(pre, `${screen}\x1b[0m`);
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      } catch (error) {
        if (finished && /not found|no such|不存在/i.test(error.message)) {
          panel.gone = e.pane_id;
          // what it showed last stays, marked as the end
          if (panel.last) {
            panel.pre.append(h("div", { class: "l gone" }, "agent 已关闭，以上是它最后的画面"));
            panel.pre.scrollTop = panel.pre.scrollHeight;
          } else waitOn(panel, "agent 已关闭，没有画面可看了");
        } else waitOn(panel, `读取失败：${error.message}`);
      }
    }
    if (!disposed) readTimer = setTimeout(read, 1200);
  }

  function update() {
    const b = findBroadcast(broadcastId());
    if (!b) {
      titleEl.textContent = "";
      actions.replaceChildren();
      actionsFor = null;
      body.replaceChildren(h("p", { class: "empty-note" }, loaded ? "这条广播已被删除。" : "读取中…"));
      return;
    }
    if (!body.contains(wall)) body.replaceChildren(bubble, meta, hint, summary, wall);
    titleEl.textContent = b.title;
    if (bubble.textContent !== b.prompt) bubble.textContent = b.prompt;
    if (bubble.classList.contains("clamp")) more.hidden = bubble.scrollHeight <= bubble.clientHeight + 2;
    metaText.textContent = `${ago(b.created_at)}发出，${b.total} 个 agent`;
    hint.hidden = data.webUi.running;
    hint.textContent = data.webUi.installed ? "herdr-web-ui 没在运行：启动它，就能从这里直接在浏览器里打开对话和终端。" : "装上 herdr-web-ui，就能从这里直接在浏览器里打开每个 agent 的对话和终端。";
    renderSummary(b);
    // panels keep their place: a screen does not jump while it is watched
    for (const e of b.executions) {
      if (!panels.has(e.id)) {
        const panel = panelFor(e);
        panels.set(e.id, panel);
        wall.append(panel.el);
      }
      patch(panels.get(e.id), e);
    }
    if (!focused && focusExec !== null && panels.has(focusExec)) {
      focused = true;
      flash(panels.get(focusExec).el);
    }
    // rebuilt only when what they act on changes, so a half-pressed button stays armed
    const queued = b.executions.filter((e) => e.state === "queued");
    const shape = `${b.id}:${queued.map((e) => e.id).join(",")}`;
    if (shape !== actionsFor) {
      actionsFor = shape;
      actions.replaceChildren(...[
        queued.length
          ? confirmButton(`取消排队中的 ${queued.length} 个`, "再点一次取消", async () => {
            for (const e of queued) await post(`/api/executions/${e.id}/cancel`).catch(() => {});
            toast(`已取消 ${queued.length} 个排队中的执行`);
          }, { class: "btn quiet", title: "还没发出的 prompt 不再发送" })
          : null,
        // an unsent draft in the form would be replaced: that takes a second press
        confirmButton("再发一次", "再点一次覆盖草稿", async () => rebroadcast(findBroadcast(b.id) || b),
          { class: "btn quiet", title: "带上这个 prompt 和同一批 agent 去新建广播，发之前可以改" },
          () => { const draft = loadDraft(); return !!(draft.prompt || "").trim() && draft.prompt !== b.prompt; }),
        confirmButton("删除记录", "再点一次删除", async () => {
          await api(`/api/broadcasts/${b.id}`, { method: "DELETE" });
          toast("已删除");
          go("");
        }, { class: "btn quiet", title: "排队中的会一并取消；agent 和 pane 不会被关闭" }),
      ].filter(Boolean));
    }
  }

  update();
  read();
  return { update, escape, dispose() { disposed = true; clearTimeout(readTimer); clearInterval(ticker); observer.disconnect(); } };
}

// ---- wiring -----------------------------------------------------------------------------

function connect() {
  const conn = $("conn");
  const banner = $("banner");
  const source = new EventSource("/api/events");
  source.onopen = () => { conn.className = "conn"; conn.title = "已连接"; banner.hidden = true; };
  source.onerror = () => { conn.className = "conn bad"; conn.title = "连接断开，正在重连"; banner.hidden = false; };
  source.onmessage = (event) => {
    data = JSON.parse(event.data);
    loaded = true;
    banner.hidden = true;
    noticeWaiting();
    renderMachines();
    renderSidebar();
    if (view) view.update();
  };
}

$("new").addEventListener("click", () => go("#/new"));
$("search").addEventListener("input", () => renderSidebar());
$("search").addEventListener("keydown", (event) => { if (event.key === "Escape") event.target.blur(); });
addEventListener("hashchange", route);

/** Moves to the broadcast `step` places down the sidebar (up when negative), as it is filtered. */
function stepBroadcast(step) {
  const order = sidebarGroups().groups.flatMap(([, items]) => items.map((b) => b.id));
  if (order.length === 0) return;
  const at = order.indexOf(currentBroadcastId());
  const next = at < 0 ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + step));
  if (order[next] === currentBroadcastId()) return;
  revealCurrent = true;
  go(`#/b/${order[next]}`);
}

/** N new, / search, J and K down and up the broadcasts, Esc puts a big panel back. Not while typing. */
addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  const typing = event.target.closest && event.target.closest("input, textarea, select, [contenteditable]");
  if (event.key === "Escape") {
    if (!typing && view && view.escape && view.escape()) event.preventDefault();
    return;
  }
  if (typing) return;
  const key = event.key.toLowerCase();
  if (key === "n") go("#/new");
  else if (event.key === "/") {
    // on a phone the search is on the list screen
    if (matchMedia("(max-width: 820px)").matches && document.body.classList.contains("in-main")) go("");
    $("search").focus();
  } else if (key === "j") stepBroadcast(1);
  else if (key === "k") stepBroadcast(-1);
  else return;
  event.preventDefault();
});
// relative times move without new data
setInterval(() => { renderSidebar(); if (view && parseRoute().name === "broadcast") view.update(); }, 30000);
renderNotify();

api("/api/config").then((c) => { config = c; }).catch(() => {}).finally(() => { route(); connect(); });
