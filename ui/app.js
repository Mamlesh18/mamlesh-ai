// Mamlesh AI OS - full-screen agent map, chat with the Orchestrator, and an inspector for every node.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const tok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const usd = (c) => `$${(c || 0).toFixed(c < 0.01 ? 5 : 4)}`;
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(1)}s` : "");
const toLogin = () => { location.href = "/login"; };
const store = {  // per-browser convenience only (e.g. which chat was open); the app works without it
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

let cy;                   // the graph
let graphData = {};       // from /api/graph
let selected = null;      // node shown in the inspector
let graphRun = null;      // the run the map is showing: {id, plan, domains, usage}
const liveCalls = {};     // server id -> calls seen in this tab, newest first
const activeCalls = {};   // server id -> tool calls still running
const expanded = new Set(); // server ids whose tools are shown

// Chat state
let chatId = store.get("chatId");  // current chat (null = new chat)
let messages = [];                  // run ids in this chat, oldest first
const runs = {};                    // run id -> {query, answer, status, usage, totals, events, open}
let pendingQuery = null;            // a question sent but not yet started on the server
let busy = false;

// =====================================================================
// Graph: Orchestrator in the centre, agents on a circle, MCP servers fanned out, tools fanned out on demand
// =====================================================================

const C = { ink: "#0a0a0a", paper: "#ffffff", bg: "#f3efe6", yellow: "#ffe500", pink: "#ff4fa3", blue: "#2f6bff", green: "#00c46a", red: "#ff3b2f", orange: "#ff8a00" };
const R_DOMAIN = 210, R_SERVER = 120, SERVER_SPREAD = 0.7, R_TOOL = 85;
const polar = (cx, cy, r, a) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
const fitView = (animate) => {
  if (!cy) return;
  const opts = { eles: cy.elements(":visible"), padding: 70 };
  animate ? cy.animate({ fit: opts, duration: 300 }) : cy.fit(opts.eles, opts.padding);
};

async function loadGraph() {
  const res = await fetch("/api/graph");
  if (res.status === 401) return toLogin();
  graphData = await res.json();
  const els = [{ data: { id: "orchestrator", label: "ORCHESTRATOR\nclick to chat", base: "ORCHESTRATOR\nclick to chat", kind: "orchestrator" }, position: { x: 0, y: 0 } }];
  const n = graphData.domains.length;

  graphData.domains.forEach((d, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const dp = polar(0, 0, R_DOMAIN, a);
    const label = d.name.toUpperCase();
    els.push({ data: { id: `d:${d.name}`, label, base: label, kind: "domain" }, position: dp, classes: d.servers.length ? "" : "empty" });
    els.push({ data: { source: "orchestrator", target: `d:${d.name}` } });

    d.servers.forEach((s, j) => {
      const sa = a + (j - (d.servers.length - 1) / 2) * SERVER_SPREAD;
      const sp = polar(dp.x, dp.y, R_SERVER, sa);
      const serverLabel = s.status === "auth_required" ? `${s.name}\nLOGIN NEEDED` : `${s.name}\n${s.tools.length} tools`;
      els.push({ data: { id: `s:${s.id}`, label: serverLabel, kind: "server" }, position: sp, classes: s.status });
      els.push({ data: { source: `d:${d.name}`, target: `s:${s.id}` } });

      const m = s.tools.length;
      const step = Math.min(0.32, 2.8 / Math.max(m, 1));
      s.tools.forEach((t, k) => {
        const ta = sa + (k - (m - 1) / 2) * step;
        const tp = polar(sp.x, sp.y, R_TOOL + (m > 12 ? (k % 2) * 40 : 0), ta);
        els.push({ data: { id: `t:${s.id}/${t.name}`, label: t.name, kind: "tool", server: s.id }, position: tp, classes: "hidden" });
        els.push({ data: { source: `s:${s.id}`, target: `t:${s.id}/${t.name}`, server: s.id }, classes: "tool-edge hidden" });
      });
    });
  });

  cy = cytoscape({
    container: $("graph"),
    elements: els,
    layout: { name: "preset", fit: false },
    wheelSensitivity: 0.25,
    minZoom: 0.2,
    maxZoom: 3,
    style: [
      { selector: "node", style: {
          label: "data(label)", "font-family": "JetBrains Mono, monospace", "font-weight": 700, "font-size": 11,
          color: C.ink, "text-wrap": "wrap", "text-valign": "bottom", "text-halign": "center", "text-margin-y": 7,
          "text-background-color": C.paper, "text-background-opacity": 1, "text-background-padding": 3,
          "text-border-color": C.ink, "text-border-width": 2, "text-border-opacity": 1,
          shape: "rectangle", "background-color": C.paper, "border-width": 3, "border-color": C.ink, width: 30, height: 30 } },
      { selector: "node[kind='orchestrator']", style: {
          width: 100, height: 100, "background-color": C.ink, "font-size": 13, "text-valign": "center", "text-margin-y": 0,
          color: C.yellow, "text-background-color": C.ink, "text-border-width": 0 } },
      { selector: "node[kind='domain']", style: { width: 56, height: 56, "background-color": C.yellow, "font-size": 12 } },
      { selector: "node[kind='domain'].empty", style: { "background-color": C.bg, "border-style": "dashed", color: "#5c5c5c" } },
      { selector: "node[kind='server']", style: { shape: "diamond", width: 38, height: 38, "background-color": C.pink, "font-size": 10 } },
      { selector: "node[kind='server'].disabled", style: { "background-color": C.bg, opacity: 0.5 } },
      { selector: "node[kind='server'].error", style: { "background-color": C.red } },
      { selector: "node[kind='server'].auth_required", style: {
          "background-color": C.orange, "border-style": "dashed", "border-width": 4, "text-background-color": C.orange } },
      { selector: "node[kind='tool']", style: {
          width: 12, height: 12, "background-color": C.blue, "border-width": 2, "font-size": 9, "font-weight": 500,
          "text-opacity": 0, "text-background-opacity": 0, "text-border-opacity": 0 } },
      { selector: "node[kind='tool']:selected, node[kind='tool'].show-label, node[kind='tool'].running, node[kind='tool'].done, node[kind='tool'].failed", style: {
          "text-opacity": 1, "text-background-opacity": 1, "text-border-opacity": 1, width: 16, height: 16 } },
      { selector: "node.hidden, edge.hidden", style: { display: "none" } },
      { selector: "node.queued", style: { "border-style": "dashed", "border-width": 4 } },
      { selector: "node.running", style: { "background-color": C.yellow, "border-width": 6, "border-color": C.blue } },
      { selector: "node[kind='orchestrator'].running", style: { "background-color": C.blue, color: C.paper, "text-background-color": C.blue } },
      { selector: "node.done", style: { "background-color": C.green } },
      { selector: "node[kind='orchestrator'].done", style: { "background-color": C.green, color: C.ink, "text-background-color": C.green } },
      { selector: "node.failed", style: { "background-color": C.red } },
      { selector: "node:selected", style: { "border-width": 6, "border-color": C.blue } },
      { selector: "edge", style: { width: 3, "line-color": C.ink, "curve-style": "straight" } },
      { selector: "edge.tool-edge", style: { width: 1.5, "line-color": "#7a7a7a" } },
      { selector: "edge.active", style: { width: 6, "line-color": C.blue, "line-style": "dashed", "line-dash-pattern": [10, 6] } },
      { selector: "edge.done", style: { width: 4, "line-color": C.green } },
    ],
  });

  fitView(false);
  if (!loadGraph.started) {
    loadGraph.started = true;
    window.addEventListener("resize", () => { cy.resize(); fitView(false); placeAuthButtons(); });
    setInterval(() => cy && cy.edges(".active").forEach((e) => e.style("line-dash-offset", -((Date.now() / 30) % 16))), 50);
  }
  cy.on("pan zoom resize", placeAuthButtons);
  placeAuthButtons();

  cy.on("tap", "node", (e) => {
    const node = e.target;
    if (node.id() === "orchestrator") return openChat();
    selected = node.data("kind") === "tool" ? `s:${node.data("server")}` : node.id();
    if (node.data("kind") === "server") toggleTools(node.id().slice(2), true);
    openInspector();
  });
  cy.on("mouseover", "node[kind='tool']", (e) => e.target.addClass("show-label"));
  cy.on("mouseout", "node[kind='tool']", (e) => e.target.removeClass("show-label"));
  $("fit").onclick = () => fitView(true);
  $("collapse").onclick = () => { [...expanded].forEach((id) => toggleTools(id, false)); fitView(true); };
}

async function reloadGraph() {
  if (cy) cy.destroy();
  expanded.clear();
  await loadGraph();
  if ($("drawer").dataset.mode === "inspect") renderPanel();
}

function toggleTools(serverId, zoom) {
  const show = !expanded.has(serverId);
  const els = cy.elements(`[server = "${serverId}"]`);
  if (show) { expanded.add(serverId); els.removeClass("hidden"); }
  else { expanded.delete(serverId); els.addClass("hidden"); }
  if (show && zoom) cy.animate({ fit: { eles: cy.getElementById(`s:${serverId}`).union(els), padding: 60 }, duration: 350 });
}

function showTool(serverId) {
  if (!expanded.has(serverId)) { expanded.add(serverId); cy.elements(`[server = "${serverId}"]`).removeClass("hidden"); }
}

function setNode(id, state) {
  const n = cy?.getElementById(id);
  if (n?.length) n.removeClass("queued running done failed").addClass(state);
}

function setEdge(target, state) {
  const e = cy?.edges(`[target = "${target}"]`);
  if (!e) return;
  e.removeClass("active done");
  if (state) e.addClass(state);
}


function resetGraph() {
  if (!cy) return;
  cy.nodes().forEach((n) => n.data("base") && n.data("label", n.data("base")));
  cy.nodes().removeClass("queued running done failed");
  cy.edges().removeClass("active done");
  for (const k in activeCalls) delete activeCalls[k];
}

// "⚠ LOG IN" buttons pinned under servers that need a login (e.g. Upstox)
function placeAuthButtons() {
  const wrap = $("graph-wrap");
  wrap.querySelectorAll(".auth-btn").forEach((b) => b.remove());
  if (!cy) return;
  cy.nodes("[kind='server'].auth_required").forEach((n) => {
    const p = n.renderedPosition();
    const b = document.createElement("button");
    b.className = "auth-btn";
    b.textContent = "⚠ Log in";
    b.title = `Log in to ${n.id().slice(2)}`;
    b.style.left = `${p.x}px`;
    b.style.top = `${p.y + 48 * cy.zoom() + 18}px`;
    b.onclick = (e) => { e.stopPropagation(); startAuth(n.id().slice(2)); };
    wrap.appendChild(b);
  });
}

async function startAuth(serverId) {
  // Open the window straight from the click (pop-up blockers), then point it at the provider's login page.
  const popup = window.open("", "mcp-login", "width=520,height=760");
  const r = await fetch(`/api/mcp/${serverId}/auth/start`, { method: "POST" });
  if (r.status === 401) { popup?.close(); return toLogin(); }
  const data = await r.json();
  if (!r.ok) { popup?.close(); alert(data.detail || "Could not start login."); return; }
  if (popup) popup.location = data.url;
  else location.href = data.url;
  setStatus("waiting for login…");
}

window.addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data?.type === "mcp-auth") setStatus(e.data.ok ? "connected" : "login failed");
});

// =====================================================================
// Drawer: chat (orchestrator) or inspector (other nodes). The map shrinks to make room.
// =====================================================================

function openDrawer(mode) {
  const drawer = $("drawer");
  drawer.dataset.mode = mode;
  drawer.setAttribute("aria-hidden", "false");
  $("chat").hidden = mode !== "chat";
  $("inspector").hidden = mode !== "inspect";
  $("drawer-title").textContent = mode === "chat" ? "Orchestrator · chat" : "Inspector";
  const wasOpen = document.body.classList.contains("drawer-open");
  document.body.classList.add("drawer-open");
  if (!wasOpen) setTimeout(() => { cy?.resize(); fitView(true); placeAuthButtons(); }, 220);
}

function closeDrawer() {
  document.body.classList.remove("drawer-open");
  $("drawer").setAttribute("aria-hidden", "true");
  $("drawer").dataset.mode = "";
  selected = null;
  cy?.nodes().unselect();
  setTimeout(() => { cy?.resize(); fitView(true); placeAuthButtons(); }, 220);
}

function openChat() {
  openDrawer("chat");
  $("chat-list").hidden = true;
  renderMessages();
  setTimeout(() => $("query").focus(), 230);
}

function openInspector() {
  openDrawer("inspect");
  renderPanel();
}

$("drawer-close").onclick = closeDrawer;
$("chat-fab").onclick = openChat;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("drawer-open")) closeDrawer(); });

// =====================================================================
// Chat
// =====================================================================

const EXAMPLES = [
  "How are my mutual funds doing?",
  "What's on my GitHub this week?",
  "Search the web for today's top AI news",
  "Add to today's notes: worked on Mamlesh AI OS",
];

function renderMessages() {
  const box = $("messages");
  if (!messages.length) {
    box.innerHTML = `
      <div class="empty-chat">
        <h3>Ask the Orchestrator</h3>
        <p class="muted">It plans the work and hands it to your agents. Watch them light up on the map.</p>
        <div class="chips">${EXAMPLES.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
      </div>`;
    box.querySelectorAll(".chips button").forEach((b) => (b.onclick = () => sendMessage(b.dataset.q)));
    return;
  }
  box.innerHTML = messages.map((rid) => `<div class="msg user">${esc(runs[rid].query)}</div>
      <div class="msg bot" id="m-${rid}"><div class="bot-main"></div><div class="drafts"></div></div>`).join("")
    + (pendingQuery ? `<div class="msg user">${esc(pendingQuery)}</div><div class="msg bot"><div class="answer"><span class="thinking">sending…</span></div></div>` : "");
  messages.forEach((rid) => { renderBot(rid); renderDrafts(rid); });
  box.scrollTop = box.scrollHeight;
}

function formatAnswer(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

// One assistant message: answer, figures, and the Events / Cost toggles.
function renderBot(rid) {
  const el = $(`m-${rid}`);
  const r = runs[rid];
  if (!el || !r) return;
  const box = $("messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const t = r.totals || sumUsage(r.usage);
  const running = r.status === "running";
  const lastStep = running && r.events?.length ? describeEvent(r.events[r.events.length - 1]) : "planning…";
  el.className = `msg bot${r.status === "error" ? " error" : ""}`;
  // Only the answer part is redrawn (on every streamed word); email drafts live in their own box so edits survive.
  el.querySelector(".bot-main").innerHTML = `
    <div class="answer">${r.answer ? formatAnswer(r.answer) : running ? `<span class="thinking">${esc(lastStep)}</span>` : r.status === "error" ? esc(r.error || "Something went wrong.") : ""}</div>
    <div class="meta">
      <span class="figs">${t.calls ? `${usd(t.cost)} · ${tok((t.input_tokens || 0) + (t.output_tokens || 0))} tok` : running ? "working…" : ""}${t.duration_ms ? ` · ${secs(t.duration_ms)}` : ""}</span>
      <button type="button" data-k="events" class="${r.open.events ? "on" : ""}">Events${r.events ? ` (${r.events.length})` : ""}</button>
      <button type="button" data-k="cost" class="${r.open.cost ? "on" : ""}">Cost</button>
      ${running ? "" : `<button type="button" data-k="trace" title="Timeline of every step">Trace</button>`}
    </div>
    ${r.open.events ? `<div class="detail">${eventsHtml(r)}</div>` : ""}
    ${r.open.cost ? `<div class="detail">${usageTable(r.usage, r.totals)}</div>` : ""}`;
  el.querySelectorAll(".meta button").forEach((b) => (b.onclick = () => (b.dataset.k === "trace" ? openTrace(rid) : toggleDetail(rid, b.dataset.k))));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- Email drafts: the agent prepares, Mamlesh reviews, edits and sends ----------

function renderDrafts(rid) {
  const box = $(`m-${rid}`)?.querySelector(".drafts");
  const r = runs[rid];
  if (!box || !r) return;
  box.innerHTML = (r.drafts || []).map((d) => {
    if (d.status === "sent") {
      return `<div class="draft sent" id="dr-${esc(d._id)}"><div class="draft-head"><b>✉ Email sent</b><span class="badge done">sent</span></div>
        <p><b>To:</b> ${esc(d.to)}<br><b>Subject:</b> ${esc(d.subject)}</p>
        <details><summary>message</summary><pre>${esc(d.body)}</pre></details>
        <p class="muted">${d.sent_at ? new Date(d.sent_at).toLocaleString() : ""}</p></div>`;
    }
    if (d.status === "discarded") {
      return `<div class="draft discarded"><div class="draft-head"><b>✉ Draft discarded</b><span class="badge disabled">discarded</span></div>
        <p class="muted">To ${esc(d.to)} · ${esc(d.subject)}</p></div>`;
    }
    return `<form class="draft" id="dr-${esc(d._id)}" data-id="${esc(d._id)}">
      <div class="draft-head"><b>✉ Email draft</b><span class="badge auth_required">${d.status === "failed" ? "failed - edit &amp; retry" : "waiting for you"}</span></div>
      <label>To<input name="to" value="${esc(d.to)}" autocomplete="off"></label>
      <label>Subject<input name="subject" value="${esc(d.subject)}" autocomplete="off"></label>
      <label>Message<textarea name="body" rows="8">${esc(d.body)}</textarea></label>
      ${d.error ? `<div class="warn-box">${esc(d.error)}</div>` : ""}
      <div class="draft-actions"><button type="submit" class="send">Send email →</button><button type="button" class="discard">Discard</button></div>
      <p class="muted draft-note">Nothing is sent until you click Send.</p>
    </form>`;
  }).join("");
  box.querySelectorAll("form.draft").forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); sendDraft(rid, f); };
    f.querySelector(".discard").onclick = () => discardDraft(rid, f.dataset.id);
  });
}

async function sendDraft(rid, form) {
  const id = form.dataset.id;
  const f = form.elements;
  const fields = { to: f.namedItem("to").value, subject: f.namedItem("subject").value, body: f.namedItem("body").value };
  form.querySelectorAll("button").forEach((b) => (b.disabled = true));
  form.querySelector(".draft-note").textContent = "Sending…";
  const r = await fetch(`/api/email/drafts/${id}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) });
  if (r.status === 401) return toLogin();
  const data = await r.json();
  const d = runs[rid].drafts.find((x) => x._id === id);
  if (r.ok) Object.assign(d, fields, { status: "sent", sent_at: data.sent_at, error: null });
  else Object.assign(d, fields, { status: "failed", error: data.detail || "Sending failed." });
  renderDrafts(rid);
}

async function discardDraft(rid, id) {
  const r = await fetch(`/api/email/drafts/${id}/discard`, { method: "POST" });
  if (r.status === 401) return toLogin();
  const d = runs[rid].drafts.find((x) => x._id === id);
  if (r.ok) d.status = "discarded";
  renderDrafts(rid);
}

async function toggleDetail(rid, kind) {
  const r = runs[rid];
  r.open[kind] = !r.open[kind];
  if (kind === "events" && r.open.events && r.events == null) {
    r.events = [];
    renderBot(rid);
    const res = await fetch(`/api/runs/${rid}/events`);
    if (res.ok) r.events = (await res.json()).filter((e) => e.type !== "token");
  }
  renderBot(rid);
}

function eventsHtml(r) {
  if (!r.events?.length) return `<p class="muted">${r.events ? "No events yet." : "Loading…"}</p>`;
  return `<ol class="evlist">${r.events.map((ev) =>
    `<li><span class="t ${eventKind(ev)}">${new Date(ev.ts).toLocaleTimeString()} ${esc(ev.type)}</span> ${esc(describeEvent(ev))}</li>`).join("")}</ol>`;
}

function sumUsage(usage) {
  const rows = Object.values(usage || {});
  const s = (k) => rows.reduce((a, u) => a + (u[k] || 0), 0);
  return { calls: s("calls"), input_tokens: s("input_tokens"), cached_tokens: s("cached_tokens"), output_tokens: s("output_tokens"), cost: s("cost") };
}

function usageTable(usage, totals) {
  const rows = Object.entries(usage || {});
  if (!rows.length) return `<p class="muted">No LLM calls yet.</p>`;
  const t = totals || sumUsage(usage);
  const ctx = (a) => a === "orchestrator" ? "" : tok(graphData.domains?.find((d) => d.name === a)?.context?.total || 0);
  return `
    <table class="usage">
      <tr><th>agent</th><th>calls</th><th>in</th><th>cached</th><th>out</th><th>cost</th><th title="Prompt + tool definitions sent on every call">ctx</th></tr>
      ${rows.map(([a, u]) => `<tr><td>${esc(a)}</td><td>${u.calls}</td><td>${tok(u.input_tokens)}</td><td>${tok(u.cached_tokens)}</td><td>${tok(u.output_tokens)}</td><td>${usd(u.cost)}</td><td>${ctx(a)}</td></tr>`).join("")}
      <tr class="total"><td>total</td><td>${t.calls}</td><td>${tok(t.input_tokens)}</td><td>${tok(t.cached_tokens)}</td><td>${tok(t.output_tokens)}</td><td>${usd(t.cost)}</td><td>${secs(t.duration_ms)}</td></tr>
    </table>`;
}

async function sendMessage(text, source = "text") {
  const query = (text ?? $("query").value).trim();
  if (!query || busy) return;
  $("query").value = "";
  setBusy(true);
  pendingQuery = query;
  if ($("drawer").dataset.mode !== "chat") openChat(); else renderMessages();
  try {
    const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, source, chat_id: chatId }) });
    if (r.status === 401) return toLogin();
    if (!r.ok) throw new Error(await r.text());
    const { run_id, chat_id } = await r.json();
    chatId = chat_id;
    store.set("chatId", chatId);
    attachRun(run_id, query);
  } catch (err) {
    pendingQuery = null;
    setBusy(false);
    alert(`Could not send: ${err.message}`);
    renderMessages();
  }
}

// Link a started run to this chat (its run.start event may arrive before or after the POST returns).
function attachRun(rid, query) {
  runs[rid] ||= { query, answer: "", status: "running", usage: {}, totals: null, events: [], open: { events: false, cost: false } };
  if (!messages.includes(rid)) messages.push(rid);
  pendingQuery = null;
  renderMessages();
}

async function loadChat(id) {
  chatId = id;
  store.set("chatId", id);
  messages = [];
  if (id) {
    const r = await fetch(`/api/chats/${id}`);
    if (r.status === 401) return toLogin();
    const chat = await r.json();
    for (const m of chat.messages) {
      runs[m.run_id] ||= { query: m.query, answer: m.answer, status: m.status, usage: m.usage || {}, totals: m.totals,
                           events: null, open: { events: false, cost: false }, error: m.status === "error" ? "This query failed." : "",
                           drafts: m.drafts || [] };
      messages.push(m.run_id);
    }
    if (!chat.messages.length) { chatId = null; store.set("chatId", null); }
  }
  $("chat-list").hidden = true;
  renderMessages();
}

$("new-chat").onclick = () => { if (!busy) loadChat(null); $("query").focus(); };

$("history-btn").onclick = async () => {
  const list = $("chat-list");
  if (!list.hidden) { list.hidden = true; return; }
  list.hidden = false;
  list.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await fetch("/api/chats");
  if (r.status === 401) return toLogin();
  const chats = await r.json();
  list.innerHTML = chats.length
    ? chats.map((c) => `<button type="button" data-id="${esc(c.chat_id)}" class="${c.chat_id === chatId ? "current" : ""}">${esc(c.title)}<small>${new Date(c.updated_at).toLocaleString()}</small></button>`).join("")
    : `<p class="muted">No saved chats yet.</p>`;
  list.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => loadChat(b.dataset.id)));
};

$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
$("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// =====================================================================
// Inspector (agents and MCP servers)
// =====================================================================

function renderPanel() {
  const p = $("panel-body");
  if (!selected) return;

  if (selected.startsWith("d:")) {
    const name = selected.slice(2);
    const d = graphData.domains.find((x) => x.name === name);
    if (!d) return;
    const r = graphRun?.domains?.[name];
    const servers = d.servers.map((s) =>
      `<div class="tool"><b>${esc(s.name)}</b> <span class="badge ${s.status}">${s.status.replace("_", " ")}</span><p>${s.tools.length} tools · ${esc(s.transport)}</p></div>`).join("");
    p.innerHTML = `<h2>${esc(name)} agent</h2><p class="muted">${esc(d.description)}</p>
      <h4>Latest query</h4>${r ? `<span class="badge ${r.status}">${r.status}</span>
        <p><b>Task:</b> ${esc(r.task)}</p>${r.result ? `<p><b>Result:</b> ${esc(r.result)}</p>` : ""}` : '<p class="muted">Not used in the latest query.</p>'}
      ${name === "finance" ? '<div id="portfolio"><p class="muted">Loading portfolio…</p></div>' : ""}
      ${name === "healthcare" ? '<div id="health"><p class="muted">Loading health data…</p></div>' : ""}
      ${contextHtml(d.context)}
      <h4>MCP servers / tools</h4>${servers || '<p class="muted">No tools configured yet. Add MCP servers in mcp_servers/config.py.</p>'}`;
    if (name === "finance") renderPortfolio();
    if (name === "healthcare") renderHealth();
    return;
  }
  if (selected.startsWith("s:")) renderServer(selected.slice(2));
}

// ---------- Health (custom healthcare tools, data in MongoDB) ----------

async function renderHealth() {
  const r = await fetch("/api/healthcare?days=90");
  if (r.status === 401) return toLogin();
  const el = $("health");
  if (!el) return;
  if (!r.ok) { el.innerHTML = `<p class="muted">${esc((await r.json()).detail || "Could not load health data.")}</p>`; return; }
  const h = await r.json();
  const num = (v) => (v == null ? "–" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 1 }));
  const goals = h.goals.map((g) => {
    const pctDone = Math.max(0, Math.min(100, g.percent_done || 0));
    return `
      <div class="goal">
        <b>${esc(g.metric)} goal: ${num(g.start)} → ${num(g.target)} ${esc(g.unit)}</b>
        <div class="stats">
          <div class="stat"><b>${num(g.current)} ${esc(g.unit)}</b><span>now</span></div>
          <div class="stat"><b>${num(Math.abs(g.remaining))} ${esc(g.unit)}</b><span>${g.remaining > 0 === g.target < g.start ? "to go" : "past target"}</span></div>
        </div>
        <div class="progress"><span style="width:${pctDone}%"></span><em>${num(g.percent_done)}% done</em></div>
        <p class="muted">${g.rate_per_week_last_30_days != null ? `Pace: ${num(g.rate_per_week_last_30_days)} ${esc(g.unit)}/week` : "Log a few more days to see your pace"}${g.estimated_finish ? ` · on track for ${esc(g.estimated_finish)}` : ""}${g.needed_per_week_to_hit_deadline != null ? ` · need ${num(g.needed_per_week_to_hit_deadline)}/week for ${esc(g.deadline)}` : ""}</p>
      </div>`;
  }).join("");
  const goalW = h.goals.find((g) => g.metric === "weight");
  const latest = Object.values(h.latest_by_type).map((e) => `
    <tr><td>${esc(e.type.replace("_", " "))}</td><td>${e.value != null ? `${num(e.value)} ${esc(e.unit || "")}` : ""} ${esc(e.details || "")}</td><td>${esc(e.date)}</td></tr>`).join("");
  const recent = h.recent_entries.slice(0, 15).map((e) =>
    `<li><b>${esc(e.date)}</b> ${esc(e.type.replace("_", " "))}${e.value != null ? ` · ${num(e.value)} ${esc(e.unit || "")}` : ""}${e.details ? ` · ${esc(e.details)}` : ""}</li>`).join("");
  el.innerHTML = `
    <h4>My health</h4>
    ${goals || '<p class="muted">No goals yet. Tell the Orchestrator e.g. "my goal is to get to 80 kg".</p>'}
    ${h.weights.length ? `<h4>Weight</h4>${weightChart(h.weights, goalW?.target)}` : ""}
    ${latest ? `<h4>Latest</h4><table class="usage pf"><tr><th>type</th><th>value</th><th>date</th></tr>${latest}</table>` : ""}
    ${recent ? `<h4>Recent entries</h4><ul class="tx">${recent}</ul>` : ""}
    <p class="muted">Log anything in the chat: "I weigh 91.4 today", "walked 8,000 steps", "slept 6 hours".</p>`;
}

// Weight over time as a small line chart, with the target as a dashed line.
function weightChart(points, target) {
  const W = 420, H = 130, P = 26;
  const vals = points.map((p) => p.value).concat(target != null ? [target] : []);
  const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
  const t0 = new Date(points[0].date).getTime(), t1 = new Date(points.at(-1).date).getTime();
  const x = (d) => P + (t1 === t0 ? (W - 2 * P) / 2 : ((new Date(d).getTime() - t0) / (t1 - t0)) * (W - 2 * P));
  const y = (v) => H - P + 10 - ((v - lo) / (hi - lo)) * (H - P - 4);
  const line = points.map((p) => `${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return `<svg class="wchart" viewBox="0 0 ${W} ${H + 10}" role="img" aria-label="Weight chart">
    ${target != null ? `<line x1="${P}" x2="${W - P}" y1="${y(target)}" y2="${y(target)}" class="target"/><text x="${W - P}" y="${y(target) - 4}" text-anchor="end">target ${target}</text>` : ""}
    <polyline points="${line}" class="wline"/>
    ${points.map((p) => `<rect x="${x(p.date) - 4}" y="${y(p.value) - 4}" width="8" height="8"><title>${p.date}: ${p.value} kg</title></rect>`).join("")}
    <text x="${P}" y="${H + 8}">${esc(points[0].date)}</text><text x="${W - P}" y="${H + 8}" text-anchor="end">${esc(points.at(-1).date)}</text>
    <text x="2" y="${y(hi) + 10}">${hi}</text><text x="2" y="${y(lo)}">${lo}</text>
  </svg>`;
}

function contextHtml(c) {
  if (!c) return "";
  return `<h4>Context size (sent on every LLM call)</h4>
    <div class="stats">
      <div class="stat"><b>${tok(c.total)}</b><span>tokens per call</span></div>
      <div class="stat"><b>${c.tools}</b><span>tools</span></div>
      <div class="stat"><b>${tok(c.prompt_tokens)}</b><span>prompt tokens</span></div>
      <div class="stat"><b>${tok(c.tool_tokens)}</b><span>tool definition tokens</span></div>
    </div>`;
}

async function renderServer(id) {
  const s = graphData.domains.flatMap((d) => d.servers).find((x) => x.id === id);
  if (!s) return;
  const tools = s.tools.map((t) => `<div class="tool"><b>${esc(t.name)}</b><p>${esc(t.description)}</p></div>`).join("");
  const authCard = s.status === "auth_required" ? `
    <div class="auth-card">
      <b>⚠ Login needed</b>
      <p>${esc(s.name)} uses a browser login${s.name === "upstox" ? " (Upstox asks again once a day)" : ""}. Until you log in, its tools are switched off.</p>
      <button type="button" onclick="startAuth('${esc(s.id)}')">Log in to ${esc(s.name)} →</button>
    </div>` : s.oauth ? `<p class="muted">Logged in with OAuth. <a href="#" onclick="startAuth('${esc(s.id)}');return false">Log in again</a></p>` : "";
  $("panel-body").innerHTML = `<h2>${esc(s.name)}</h2>
    <span class="badge ${s.status}">${s.status.replace("_", " ")}</span> <span class="muted">${esc(s.transport)}</span>
    ${authCard}
    ${s.error && s.status !== "auth_required" ? `<pre class="muted">${esc(s.error)}</pre>` : ""}
    <h4>Calls</h4><div id="calls"><p class="muted">Loading…</p></div>
    <h4>Tools (${s.tools.length})</h4>${tools || '<p class="muted">No tools.</p>'}`;

  let saved = [];
  try { saved = await (await fetch(`/api/mcp/${id}/calls`)).json(); } catch {}
  if (selected !== `s:${id}`) return;
  const live = liveCalls[id] || [];
  const seen = new Set(live.map((c) => c.key));
  renderCalls([...live, ...saved.filter((c) => !seen.has(`${c.run_id}|${c.tool}|${c.ts}`))]);
}

function renderCalls(calls) {
  const el = $("calls");
  if (!el) return;
  el.innerHTML = calls.map((c) => `
    <div class="call ${c.status || (c.type === "tool.error" ? "error" : "done")}">
      <b>${esc(c.tool)}</b> <span class="muted">${new Date(c.ts).toLocaleTimeString()}${c.duration_ms != null ? ` · ${c.duration_ms} ms` : " · running…"}</span>
      <details><summary class="muted">args / result</summary>
        <pre>${esc(fmt(c.args))}</pre><pre>${esc(c.error || c.result || "")}</pre></details>
    </div>`).join("") || '<p class="muted">No calls yet.</p>';
}

// ---------- Portfolio (from the uploaded CAS statement) ----------

let portfolio;   // undefined = not loaded, null = no statement uploaded
const inr = (v) => `₹${Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const pct = (v) => (v == null ? "–" : `${v > 0 ? "+" : ""}${Number(v).toFixed(2)}%`);
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

async function renderPortfolio(reload = false) {
  if (!$("portfolio")) return;
  if (portfolio === undefined || reload) {
    const r = await fetch("/api/finance/portfolio");
    if (r.status === 401) return toLogin();
    portfolio = await r.json();
  }
  const el = $("portfolio");
  if (!el) return;
  const s = portfolio;
  const upload = `
    <form class="upload" id="cas-form">
      <b>Upload a new statement</b>
      <p class="muted">CAS PDF from CDSL, NSDL, CAMS or KFintech. It replaces the current one; the PDF itself is not stored.</p>
      <input type="file" id="cas-file" accept="application/pdf" required>
      <input type="password" id="cas-password" placeholder="PDF password (usually your PAN), if locked" autocomplete="off">
      <button type="submit" id="cas-submit">Upload &amp; extract →</button>
      <div id="cas-status" class="muted"></div>
    </form>`;
  if (!s) {
    el.innerHTML = `<h4>My portfolio</h4><p class="muted">No statement uploaded yet.</p>${upload}`;
  } else {
    const alloc = s.asset_allocation.map((a, i) =>
      `<span style="width:${a.percent}%" class="seg seg${i}" title="${esc(a.asset_class)}: ${inr(a.value)} (${a.percent}%)"></span>`).join("");
    const legend = s.asset_allocation.map((a, i) => `<span><i class="seg${i}"></i>${esc(a.asset_class)} ${a.percent}%</span>`).join("");
    const max = Math.max(...s.monthly_values.map((m) => m.value), 1);
    const bars = s.monthly_values.map((m) => `<span title="${m.month}: ${inr(m.value)}" style="height:${Math.max(4, (m.value / max) * 100)}%"></span>`).join("");
    const mf = s.mf_folios.slice().sort((a, b) => b.value - a.value).map((f) => `
      <tr><td title="${esc(f.scheme)} · folio ${esc(f.folio)} · ${esc(f.plan)}">${esc(f.scheme.replace(/ - (Regular|Direct) Plan.*$| Regular Plan.*$| - Growth.*$/i, ""))}
        <small>${esc(f.plan)}</small></td><td>${inr(f.invested)}</td><td>${inr(f.value)}</td><td class="${tone(f.gain_percent)}">${pct(f.gain_percent)}</td></tr>`).join("");
    const demat = s.demat_holdings.slice().sort((a, b) => b.value - a.value).map((h) => `
      <tr><td title="${esc(h.isin)} · ${esc(h.broker)}">${esc(h.name)} <small>${esc(h.kind.replace("_", " "))}</small></td>
        <td>${h.quantity}</td><td>${inr(h.price)}</td><td>${inr(h.value)}</td></tr>`).join("");
    const tx = s.transactions.map((t) => `<li><b>${esc(t.date)}</b> ${esc(t.name)} · ${esc(t.description.split(" ").slice(0, 3).join(" "))} · ${inr(t.amount)}</li>`).join("");
    el.innerHTML = `
      <h4>My portfolio</h4>
      <p class="muted">${esc(s.source)} statement · values as on <b>${esc(s.period_to)}</b> · uploaded ${new Date(s.uploaded_at).toLocaleDateString()}</p>
      ${s.warnings?.length ? `<div class="warn-box">⚠ ${s.warnings.map(esc).join("<br>⚠ ")}</div>` : ""}
      <div class="stats">
        <div class="stat"><b>${inr(s.total_value)}</b><span>total value</span></div>
        <div class="stat"><b class="${tone(s.mf_summary.gain)}">${pct(s.mf_summary.gain_percent)}</b><span>MF gain · ${inr(s.mf_summary.gain)}</span></div>
      </div>
      <div class="alloc">${alloc}</div><div class="alloc-legend">${legend}</div>
      <h4>Value by month</h4><div class="bars">${bars}</div>
      <div class="bars-axis"><span>${esc(s.monthly_values[0]?.month || "")}</span><span>${esc(s.monthly_values.at(-1)?.month || "")}</span></div>
      <h4>Mutual fund folios (${s.mf_folios.length})</h4>
      <table class="usage pf"><tr><th>scheme</th><th>invested</th><th>value</th><th>gain</th></tr>${mf}
        <tr class="total"><td>total</td><td>${inr(s.mf_summary.invested)}</td><td>${inr(s.mf_summary.value)}</td><td>${pct(s.mf_summary.gain_percent)}</td></tr></table>
      <h4>Demat holdings (${s.demat_holdings.length})</h4>
      <table class="usage pf"><tr><th>name</th><th>qty</th><th>price</th><th>value</th></tr>${demat}</table>
      ${tx ? `<h4>Transactions this period</h4><ul class="tx">${tx}</ul>` : ""}
      ${upload}`;
  }
  $("cas-form").onsubmit = uploadStatement;
}

async function uploadStatement(e) {
  e.preventDefault();
  const file = $("cas-file").files[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  form.append("password", $("cas-password").value);
  $("cas-submit").disabled = true;
  $("cas-status").textContent = "Reading the PDF and extracting your holdings… (about 20–40 s)";
  try {
    const r = await fetch("/api/finance/statement", { method: "POST", body: form });
    if (r.status === 401) return toLogin();
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "Upload failed");
    $("cas-status").textContent = `Done: ${inr(data.total_value)} as on ${data.as_on}${data.warnings.length ? ` · ${data.warnings.length} warning(s)` : ""}`;
    await renderPortfolio(true);
  } catch (err) {
    $("cas-status").textContent = `✗ ${err.message}`;
    $("cas-submit").disabled = false;
  }
}

// =====================================================================
// Live events from the server
// =====================================================================

function describeEvent(ev) {
  const d = {
    "run.start": () => `query: ${ev.query}`,
    "node.start": () => "planning…",
    plan: () => `plan: ${(ev.steps || []).map((s) => s.domain).join(", ") || "answer directly"}`,
    "domain.start": () => `${ev.domain} → ${ev.task}`,
    "domain.end": () => `${ev.domain} ${ev.status}`,
    "tool.start": () => `${ev.server} · ${ev.tool}()`,
    "tool.end": () => `${ev.server} · ${ev.tool} ✓ ${ev.duration_ms} ms`,
    "tool.error": () => `${ev.server} · ${ev.tool} ✗ ${ev.error}`,
    usage: () => `${ev.agent} LLM call: ${ev.input_tokens} in / ${ev.output_tokens} out · ${usd(ev.cost)}`,
    "node.end": () => "writing the answer…",
    "run.end": () => `done · ${usd(ev.totals?.cost)} · ${tok((ev.totals?.input_tokens || 0) + (ev.totals?.output_tokens || 0))} tokens`,
    "run.error": () => `error: ${ev.error}`,
    "mcp.status": () => `${ev.server} → ${ev.status.replace("_", " ")}`,
    "email.draft": () => `email draft ready for ${ev.draft?.to} (not sent)`,
    "portfolio.updated": () => `new statement: ₹${Number(ev.total_value).toLocaleString("en-IN")} as on ${ev.as_on}`,
  }[ev.type];
  return d ? d() : "";
}

function eventKind(ev) {
  if (ev.type === "tool.error" || ev.type === "run.error") return "lt-err";
  if (ev.type.startsWith("tool.")) return "lt-tool";
  return ev.type === "usage" ? "lt-cost" : "";
}

function onEvent(ev) {
  if (ev.type === "eval.progress") { if (harnessTab === "evals" && !$("harness").hidden) evalProgress(ev); return; }
  if (ev.type === "eval.done") { if (harnessTab === "evals" && !$("harness").hidden && $("ev-form")) loadEvals(); return; }
  if (ev.type === "portfolio.updated") {
    portfolio = undefined;
    if (selected === "d:finance") renderPortfolio(true);
    return;
  }
  if (ev.type === "mcp.status") {
    setStatus(ev.status === "connected" ? `${ev.server} connected` : `${ev.server}: ${ev.status.replace("_", " ")}`);
    reloadGraph();
    return;
  }

  // ---- the chat message for this run ----
  if (ev.type === "run.start" && pendingQuery && !runs[ev.run_id] && (ev.chat_id === chatId || ev.query === pendingQuery)) {
    chatId = ev.chat_id;
    store.set("chatId", chatId);
    attachRun(ev.run_id, ev.query);
  }
  const r = runs[ev.run_id];
  if (r) {
    if (ev.type === "email.draft") { (r.drafts ||= []).push(ev.draft); renderDrafts(ev.run_id); }
    if (ev.type === "token") r.answer += ev.text;
    else {
      r.events?.push(ev);
      if (ev.type === "usage") r.usage[ev.agent] = ev.agent_total;
      if (ev.type === "run.end") Object.assign(r, { status: "done", answer: ev.answer || r.answer, usage: ev.usage || r.usage, totals: ev.totals });
      if (ev.type === "run.error") Object.assign(r, { status: "error", error: ev.error });
    }
    renderBot(ev.run_id);
    if (ev.type === "run.end" || ev.type === "run.error") setBusy(false);
  }

  // ---- the map ----
  if (ev.type === "run.start") {
    graphRun = { id: ev.run_id, plan: [], domains: {}, usage: {} };
    resetGraph();
    setStatus("working…", true);
  }
  if (!graphRun || ev.run_id !== graphRun.id) return;

  switch (ev.type) {
    case "node.start": setNode("orchestrator", "running"); break;
    case "plan":
      graphRun.plan = ev.steps;
      ev.steps.forEach((s) => setNode(`d:${s.domain}`, "queued"));
      break;
    case "domain.start":
      graphRun.domains[ev.domain] = { task: ev.task, status: "running" };
      setNode(`d:${ev.domain}`, "running"); setEdge(`d:${ev.domain}`, "active");
      break;
    case "domain.end":
      Object.assign(graphRun.domains[ev.domain] ||= {}, { status: ev.status, result: ev.result });
      setNode(`d:${ev.domain}`, ev.status === "done" ? "done" : "failed");
      setEdge(`d:${ev.domain}`, "done");
      break;
    case "tool.start":
      activeCalls[ev.server] = (activeCalls[ev.server] || 0) + 1;
      setNode(`s:${ev.server}`, "running"); setEdge(`s:${ev.server}`, "active");
      showTool(ev.server);
      setNode(`t:${ev.server}/${ev.tool}`, "running"); setEdge(`t:${ev.server}/${ev.tool}`, "active");
      (liveCalls[ev.server] ||= []).unshift({ ...ev, status: "running", key: null });
      break;
    case "tool.end":
    case "tool.error": {
      activeCalls[ev.server] = Math.max(0, (activeCalls[ev.server] || 1) - 1);
      const list = liveCalls[ev.server] ||= [];
      const i = list.findIndex((c) => c.status === "running" && c.tool === ev.tool && c.run_id === ev.run_id);
      const call = { ...ev, args: i >= 0 ? list[i].args : null, status: ev.type === "tool.end" ? "done" : "error", key: `${ev.run_id}|${ev.tool}|${ev.ts}` };
      if (i >= 0) list[i] = call; else list.unshift(call);
      setNode(`t:${ev.server}/${ev.tool}`, ev.type === "tool.end" ? "done" : "failed");
      setEdge(`t:${ev.server}/${ev.tool}`, "done");
      if (!activeCalls[ev.server]) {
        setNode(`s:${ev.server}`, ev.type === "tool.end" ? "done" : "failed");
        setEdge(`s:${ev.server}`, "done");
      }
      break;
    }
    case "run.end":
      setNode("orchestrator", "done");
      setStatus("ready");
      break;
    case "run.error":
      setNode("orchestrator", "failed");
      setStatus("ready");
      break;
  }

  // Keep the inspector live.
  if ($("drawer").dataset.mode === "inspect" && ev.type !== "token") {
    if (selected?.startsWith("s:")) { if (ev.server === selected.slice(2)) renderCalls(liveCalls[ev.server]); }
    // Panels that load data (finance, healthcare) only refresh when an agent finishes, not on every event.
    else if (!["d:finance", "d:healthcare"].includes(selected) || ev.type === "domain.end" || ev.type === "run.end") renderPanel();
  }
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => setStatus(busy ? "working…" : "ready", busy);
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = async () => {
    $("status-dot").className = "dot";
    $("status-text").textContent = "reconnecting…";
    try { if ((await fetch("/api/graph")).status === 401) return toLogin(); } catch {}
    setTimeout(connect, 1500);
  };
}

function setStatus(text, working = false) {
  $("status-dot").className = working ? "dot busy" : "dot live";
  $("status-text").textContent = text;
}

function setBusy(b) {
  busy = b;
  $("send").disabled = b;
  $("send").textContent = b ? "Working…" : "Send →";
}

// =====================================================================
// Observability (harness): dashboard + trace waterfall. Traces live in MongoDB and expire after N days.
// =====================================================================

let harnessDays = 7;
const ms = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const KIND_LABEL = { run: "Query", planner: "Step", agent: "Step", synthesizer: "Step", llm: "LLM call", tool: "Tool call" };

let harnessTab = "live";

function openHarness() {
  $("profile-menu").hidden = true;
  $("harness").hidden = false;
  showTab(harnessTab);
}

function showTab(tab) {
  harnessTab = tab;
  document.querySelectorAll(".h-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelector(".h-range").hidden = tab !== "live";
  tab === "live" ? loadHarness() : loadEvals();
}
document.querySelectorAll(".h-tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function closeHarness() { $("harness").hidden = true; hideTip(); }
$("open-harness").onclick = openHarness;
$("harness-close").onclick = closeHarness;
document.querySelectorAll(".h-range button").forEach((b) => (b.onclick = () => {
  harnessDays = Number(b.dataset.days);
  document.querySelectorAll(".h-range button").forEach((x) => x.classList.toggle("on", x === b));
  loadHarness();
}));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("harness").hidden) closeHarness(); });

async function loadHarness() {
  const body = $("harness-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await fetch(`/api/harness/metrics?days=${harnessDays}`);
  if (r.status === 401) return toLogin();
  const m = await r.json();
  if (harnessTab !== "live") return; // the user switched tabs while this was loading
  if (!m.available) { body.innerHTML = `<p class="muted">MongoDB is not connected, so there are no traces.</p>`; return; }
  const k = m.kpis;
  $("h-sub").textContent = `last ${m.days === 1 ? "24 hours" : `${m.days} days`} · ${k.queries} queries`;
  if (!k.queries) {
    body.innerHTML = `<div class="h-empty"><h3>No traces yet</h3><p class="muted">Ask something in the chat - every query is traced here.</p></div>${retentionHtml(m)}`;
    bindRetention();
    return;
  }
  const tile = (v, label, sub = "") => `<div class="stat"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const maxCost = Math.max(...m.daily.map((d) => d.cost), 0.000001);
  const maxStep = Math.max(...m.steps.map((s) => s.avg_ms || 0), 1);
  body.innerHTML = `
    <div class="h-kpis">
      ${tile(ms(k.p50_ms), "typical answer time", `p95 ${ms(k.p95_ms)}`)}
      ${tile(ms(k.ttft_p50_ms), "until the first word", "median")}
      ${tile(usd(k.cost), "total cost", `${usd(k.avg_cost)} per query`)}
      ${tile(tok(k.avg_tokens), "tokens per query", `${k.cached_share}% of input cached`)}
      ${tile(k.avg_llm_calls, "LLM calls per query")}
      ${tile(`${k.queries ? Math.round((k.errors / k.queries) * 100) : 0}%`, "failed queries", `${k.errors} of ${k.queries}`)}
    </div>
    <div class="h-grid">
      <section class="h-card">
        <h4>Cost per day</h4>
        <div class="vbars" role="img" aria-label="Cost per day">
          ${m.daily.map((d) => `<div class="vbar" data-tip="${esc(d.day)}<br><b>${usd(d.cost)}</b> · ${d.queries} queries">
            <span style="height:${d.cost ? Math.max(2, (d.cost / maxCost) * 100) : 0}%"></span><em>${esc(d.day.slice(5))}</em></div>`).join("")}
        </div>
      </section>
      <section class="h-card">
        <h4>Where the time goes <span class="muted">(average per query)</span></h4>
        ${m.steps.map((s) => `<div class="hbar" data-tip="${esc(s.step)}<br>avg <b>${ms(s.avg_ms)}</b> · p95 ${ms(s.p95_ms)}<br>in ${s.queries} queries">
          <span class="hbar-label">${esc(s.step)}</span>
          <span class="hbar-track"><span style="width:${s.avg_ms ? Math.max(1, (s.avg_ms / maxStep) * 100) : 0}%"></span></span>
          <span class="hbar-val">${ms(s.avg_ms)}</span></div>`).join("")}
        <p class="muted small">Agents include their tool calls, so the rows overlap.</p>
      </section>
    </div>
    <div class="h-grid">
      <section class="h-card">
        <h4>LLM calls by agent</h4>
        <table class="usage"><tr><th>agent</th><th>calls</th><th>avg</th><th>p95</th><th title="Average input tokens per call">in/call</th><th>cached</th><th>cost</th></tr>
          ${m.agents.map((a) => `<tr><td>${esc(a.agent)}</td><td>${a.calls}</td><td>${ms(a.avg_ms)}</td><td>${ms(a.p95_ms)}</td><td>${tok(a.avg_input_tokens)}</td><td>${a.cached_share}%</td><td>${usd(a.cost)}</td></tr>`).join("")}
        </table>
      </section>
      <section class="h-card">
        <h4>Tool calls <span class="muted">(slowest first)</span></h4>
        <table class="usage"><tr><th>tool</th><th>calls</th><th>errors</th><th>avg</th><th>p95</th><th title="Average size of the tool result">result</th></tr>
          ${m.tools.map((t) => `<tr><td>${esc(t.tool)}</td><td>${t.calls}</td><td class="${t.errors ? "down" : ""}">${t.errors}</td><td>${ms(t.avg_ms)}</td><td>${ms(t.p95_ms)}</td><td>${t.avg_result_chars == null ? "–" : tok(t.avg_result_chars) + "ch"}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No tool calls yet.</td></tr>`}
        </table>
      </section>
    </div>
    <div class="h-grid">
      <section class="h-card"><h4>Slowest queries</h4>${runList(m.slowest, "time")}</section>
      <section class="h-card"><h4>Most expensive queries</h4>${runList(m.expensive, "cost")}</section>
    </div>
    ${retentionHtml(m)}`;
  body.querySelectorAll("[data-run]").forEach((b) => (b.onclick = () => openTrace(b.dataset.run)));
  bindRetention();
}

function runList(rows, by) {
  if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
  return `<ol class="runlist">${rows.map((r) => `<li><button type="button" data-run="${esc(r.run_id)}">
    <span class="q">${esc(r.query)}</span>
    <span class="f">${by === "time" ? `<b>${ms(r.duration_ms)}</b> · ${usd(r.cost)}` : `<b>${usd(r.cost)}</b> · ${ms(r.duration_ms)}`} · ${tok(r.tokens)} tok${r.status !== "ok" ? ` · <span class="down">${esc(r.status)}</span>` : ""}</span>
  </button></li>`).join("")}</ol>`;
}

function retentionHtml(m) {
  return `<section class="h-card h-retention">
    <h4>Data retention</h4>
    <p>Traces, step-by-step events and eval answers are <b>deleted automatically after ${m.retention_days} days</b>. Your chats, their answers and eval scores are kept.</p>
    <p class="muted">${m.stored_spans} spans stored${m.oldest_trace ? ` · oldest from ${new Date(m.oldest_trace).toLocaleString()}` : ""}</p>
    <button type="button" id="delete-traces">Delete all traces now</button> <span id="delete-status" class="muted"></span>
  </section>`;
}

function bindRetention() {
  $("delete-traces").onclick = async () => {
    if (!confirm("Delete all traces and step-by-step events now? Chats and answers are kept. This can't be undone.")) return;
    const r = await fetch("/api/harness/traces", { method: "DELETE" });
    if (r.status === 401) return toLogin();
    const d = await r.json();
    $("delete-status").textContent = `Deleted ${d.spans} spans and ${d.events} events.`;
    setTimeout(loadHarness, 1200);
  };
}

// One query as a waterfall: every step, LLM call and tool call on a shared timeline.
async function openTrace(runId) {
  $("harness").hidden = false;
  $("profile-menu").hidden = true;
  const body = $("harness-body");
  body.innerHTML = `<p class="muted">Loading trace…</p>`;
  const r = await fetch(`/api/harness/traces/${runId}`);
  if (r.status === 401) return toLogin();
  const spans = await r.json();
  if (!spans.length) {
    body.innerHTML = `<p><button type="button" id="h-back">← Dashboard</button></p>
      <p class="muted">No trace for this query - it ran before tracing existed, or it is older than the retention period.</p>`;
    $("h-back").onclick = loadHarness;
    return;
  }
  const root = spans.find((s) => s.kind === "run") || spans[0];
  const total = Math.max(root.duration_ms || 0, ...spans.map((s) => s.offset_ms + (s.duration_ms || 0)), 1);
  const a = root.attrs;
  $("h-sub").textContent = `trace · ${ms(total)}`;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span style="left:${f * 100}%">${ms(Math.round(total * f))}</span>`).join("");
  const tipFor = (s) => {
    const x = s.attrs;
    const lines = [`<b>${esc(s.name)}</b>`, `${ms(s.duration_ms)} · starts at ${ms(s.offset_ms)}`];
    if (x.input_tokens != null) lines.push(`${tok(x.input_tokens)} in (${tok(x.cached_tokens || 0)} cached) · ${tok(x.output_tokens)} out · ${usd(x.cost)}`);
    if (x.result_chars != null) lines.push(`result ${x.result_chars.toLocaleString()} characters`);
    if (x.ttft_ms != null) lines.push(`first word after ${ms(x.ttft_ms)}`);
    if (x.task) lines.push(esc(x.task));
    if (s.error) lines.push(`<span class="down">${esc(s.error)}</span>`);
    return lines.join("<br>");
  };
  body.innerHTML = `
    <p><button type="button" id="h-back">← Dashboard</button></p>
    <section class="h-card">
      <h4>${esc(a.query || "Query")}</h4>
      <p class="muted">${ms(total)} · ${usd(a.cost)} · ${tok((a.input_tokens || 0) + (a.output_tokens || 0))} tokens · ${a.calls || 0} LLM calls${a.history_chars ? ` · ${tok(a.history_chars)} characters of chat history sent` : ""}</p>
      <div class="wf-legend"><span><i class="k-step"></i>Step</span><span><i class="k-llm"></i>LLM call</span><span><i class="k-tool"></i>Tool call</span><span><i class="k-run"></i>Whole query</span></div>
      <div class="wf">
        <div class="wf-row wf-axis"><span class="wf-name"></span><span class="wf-track">${ticks}</span><span class="wf-ms"></span></div>
        ${spans.map((s) => {
          const kind = s.kind === "llm" ? "llm" : s.kind === "tool" ? "tool" : s.kind === "run" ? "run" : "step";
          const left = (s.offset_ms / total) * 100, width = Math.max(0.4, ((s.duration_ms || 0) / total) * 100);
          return `<div class="wf-row${s.status === "error" ? " err" : ""}" data-tip="${esc(tipFor(s))}">
            <span class="wf-name" style="padding-left:${s.depth * 14}px" title="${esc(KIND_LABEL[s.kind] || s.kind)}">${esc(s.name)}</span>
            <span class="wf-track"><span class="wf-bar k-${kind}" style="left:${left}%;width:${width}%"></span></span>
            <span class="wf-ms">${ms(s.duration_ms)}</span></div>`;
        }).join("")}
      </div>
    </section>`;
  $("h-back").onclick = loadHarness;
}

// ---------- Evals tab ----------

let evalCompare = new Set();   // two eval ids to compare
let evalCases = null;          // the test set (cached)
const pctTxt = (r) => (r?.rate == null ? "–" : `${r.rate}%`);
const passIcon = (ok) => (ok ? `<span class="ok-mark" title="passed">✓</span>` : `<span class="bad-mark" title="failed">✗</span>`);

async function loadEvals() {
  const body = $("harness-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const [r, rc] = await Promise.all([fetch("/api/harness/evals"), evalCases ? null : fetch("/api/harness/evals/cases")]);
  if (r.status === 401) return toLogin();
  const { running, runs } = await r.json();
  if (rc) evalCases = await rc.json();
  if (harnessTab !== "evals") return; // the user switched tabs while this was loading
  const tags = [...new Set(evalCases.flatMap((c) => c.tags || []))].sort();
  $("h-sub").textContent = `${evalCases.length} test cases · ${runs.length} runs`;
  const runRow = (x) => {
    const s = x.summary;
    return `<tr data-eval="${esc(x.eval_id)}" class="clickable">
      <td><input type="checkbox" data-cmp="${esc(x.eval_id)}" ${evalCompare.has(x.eval_id) ? "checked" : ""} ${x.status !== "done" ? "disabled" : ""} aria-label="compare"></td>
      <td>${esc(x.label)}<small>${new Date(x.started_at).toLocaleString()} · prompts ${esc(x.prompts)}</small></td>
      ${x.status !== "done" ? `<td colspan="7" class="muted">${x.status === "running" ? `running… ${x.done}/${x.total}` : esc(x.status)}</td>` : `
      <td><b>${s.pass_rate}%</b> <small>${s.passed}/${s.cases}</small></td><td>${pctTxt(s.routing)}</td><td>${pctTxt(s.tools)}</td>
      <td>${pctTxt(s.judge)}<small>avg ${s.judge_avg_score ?? "–"}/5</small></td><td>${ms(s.p50_ms)}<small>p95 ${ms(s.p95_ms)}</small></td>
      <td>${tok(s.avg_tokens)}</td><td>${usd(s.avg_cost)}</td>`}
    </tr>`;
  };
  body.innerHTML = `
    <section class="h-card ev-start">
      <h4>Run the test set</h4>
      <p class="muted">Runs every case against your real agents in <b>sandbox mode</b>: anything that would write, send, pay or delete only reports what it would have done. Takes a few minutes and costs a few cents.</p>
      <form id="ev-form" class="ev-form">
        <input id="ev-label" placeholder="Label, e.g. baseline" autocomplete="off">
        <select id="ev-tag" aria-label="Only cases tagged"><option value="">All ${evalCases.length} cases</option>${tags.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
        <button type="submit" id="ev-run" ${running ? "disabled" : ""}>${running ? "Running…" : "Run evals →"}</button>
      </form>
      <div id="ev-progress" ${running ? "" : "hidden"}><div class="progress"><span style="width:0%"></span><em>starting…</em></div></div>
    </section>
    <section class="h-card">
      <h4>Runs ${runs.length > 1 ? `<span class="muted">tick two to compare</span>` : ""}</h4>
      ${runs.length ? `<table class="usage ev-runs"><tr><th></th><th>run</th><th>pass</th><th>routing</th><th>tools</th><th>judge</th><th>latency</th><th>tokens/q</th><th>cost/q</th></tr>
        ${runs.map(runRow).join("")}</table>
        <button type="button" id="ev-compare" ${evalCompare.size === 2 ? "" : "disabled"}>Compare selected</button>` : `<p class="muted">No runs yet. Start the first one above - it becomes your baseline.</p>`}
    </section>
    <details class="h-card ev-cases"><summary>Test set (${evalCases.length} cases) - harness/evals/cases.yaml</summary>
      <table class="usage"><tr><th>case</th><th>question</th><th>expects</th></tr>
        ${evalCases.map((c) => `<tr><td>${esc(c.id)}<small>${esc((c.tags || []).join(", "))}</small></td><td>${esc(c.query)}${c.history ? "<small>(with earlier chat turns)</small>" : ""}</td><td>${expectText(c.expect || {})}</td></tr>`).join("")}
      </table></details>`;
  $("ev-form").onsubmit = startEval;
  body.querySelectorAll("tr[data-eval]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.matches("input")) openEval(tr.dataset.eval); }));
  body.querySelectorAll("input[data-cmp]").forEach((cb) => (cb.onchange = () => {
    cb.checked ? evalCompare.add(cb.dataset.cmp) : evalCompare.delete(cb.dataset.cmp);
    if (evalCompare.size > 2) { evalCompare.delete([...evalCompare][0]); loadEvals(); return; }
    $("ev-compare").disabled = evalCompare.size !== 2;
  }));
  if ($("ev-compare")) $("ev-compare").onclick = () => compareEvals(...evalCompare);
  if (running) $("ev-progress").hidden = false;
}

function expectText(x) {
  const parts = [];
  if (x.no_domains) parts.push("no agent");
  if (x.domains) parts.push(`agent: ${x.domains.join(" + ")}${x.only_domains ? " only" : ""}`);
  if (x.tools_all) parts.push(`tools: ${x.tools_all.join(", ")}`);
  if (x.tools_any) parts.push(`any of: ${x.tools_any.join(", ")}`);
  if (x.tools_none) parts.push(`never: ${x.tools_none.join(", ")}`);
  if (x.contains_all || x.contains_any) parts.push(`text: ${(x.contains_all || x.contains_any).join(", ")}`);
  if (x.not_contains || x.not_regex) parts.push("forbidden text");
  if (x.judge) parts.push(`<i>judge:</i> ${esc(x.judge)}`);
  return parts.join("<br>");
}

async function startEval(e) {
  e.preventDefault();
  const tag = $("ev-tag").value;
  $("ev-run").disabled = true;
  const r = await fetch("/api/harness/evals", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: $("ev-label").value.trim(), tags: tag ? [tag] : null }) });
  if (r.status === 401) return toLogin();
  if (!r.ok) { alert((await r.json()).detail); $("ev-run").disabled = false; return; }
  loadEvals();
}

function evalProgress(ev) {
  const box = $("ev-progress");
  if (!box) return;
  box.hidden = false;
  box.querySelector("span").style.width = `${Math.round((ev.done / ev.total) * 100)}%`;
  box.querySelector("em").textContent = `${ev.done}/${ev.total} · last: ${ev.case_id} ${ev.passed ? "✓" : "✗"}`;
}

async function openEval(id) {
  const body = $("harness-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await fetch(`/api/harness/evals/${id}`);
  if (r.status === 401) return toLogin();
  const run = await r.json();
  const s = run.summary;
  $("h-sub").textContent = `eval · ${run.label}`;
  if (!s) { body.innerHTML = `<p><button type="button" id="h-back">← Evals</button></p><p class="muted">This run is ${esc(run.status)}.</p>`; $("h-back").onclick = loadEvals; return; }
  const tile = (v, label, sub = "") => `<div class="stat"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const tagRows = Object.entries(s.by_tag).map(([t, v]) => {
    const p = Math.round((v.passed / v.of) * 100);
    return `<div class="hbar" data-tip="${esc(t)}: ${v.passed} of ${v.of} passed"><span class="hbar-label">${esc(t)}</span>
      <span class="hbar-track"><span style="width:${p}%"></span></span><span class="hbar-val">${v.passed}/${v.of}</span></div>`;
  }).join("");
  const hasDetails = Object.keys(run.details).length > 0;
  const rows = run.cases.slice().sort((a, b) => a.passed - b.passed).map((c) => {
    const d = run.details[c.case_id];
    return `<tr class="clickable" data-case="${esc(c.case_id)}"><td>${passIcon(c.passed)}</td><td>${esc(c.case_id)}</td>
      <td>${c.failed.length ? `<span class="down">${esc(c.failed.join(", "))}</span>` : "–"}</td>
      <td>${c.judge_score ? `${c.judge_score}/5` : "–"}</td><td>${ms(c.latency_ms)}</td><td>${tok(c.tokens)}</td><td>${usd(c.cost)}</td></tr>
      ${d ? `<tr class="case-detail" data-for="${esc(c.case_id)}" hidden><td></td><td colspan="6">
        <p><b>Q:</b> ${esc(d.query)}</p>
        <p><b>Agents:</b> ${esc(d.planned.join(", ") || "none")} · <b>Tools:</b> ${esc(d.tools.join(", ") || "none")}</p>
        <p><b>Answer:</b></p><pre>${esc(d.answer || d.error || "")}</pre>
        <ul class="checks">${Object.entries(d.checks).map(([n, ch]) => `<li>${passIcon(ch.passed)} <b>${esc(n)}</b> ${esc(ch.detail)}</li>`).join("")}</ul>
      </td></tr>` : ""}`;
  }).join("");
  body.innerHTML = `
    <p><button type="button" id="h-back">← Evals</button></p>
    <div class="h-kpis">
      ${tile(`${s.pass_rate}%`, "cases passed", `${s.passed} of ${s.cases}`)}
      ${tile(pctTxt(s.routing), "right agents", `${s.routing.passed}/${s.routing.of}`)}
      ${tile(pctTxt(s.tools), "right tools", `${s.tools.passed}/${s.tools.of}`)}
      ${tile(pctTxt(s.judge), "judge passed", `avg ${s.judge_avg_score ?? "–"}/5`)}
      ${tile(ms(s.p50_ms), "typical time", `p95 ${ms(s.p95_ms)}`)}
      ${tile(tok(s.avg_tokens), "tokens per case", `${s.avg_llm_calls} LLM calls`)}
      ${tile(usd(s.avg_cost), "cost per case", `run ${usd(s.total_cost)} + judge ${usd(s.judge_cost)}`)}
    </div>
    <div class="h-grid">
      <section class="h-card"><h4>Pass rate by tag</h4>${tagRows}</section>
      <section class="h-card"><h4>Run</h4><p>${esc(run.label)} · ${new Date(run.started_at).toLocaleString()}</p>
        <p class="muted">model ${esc(run.model)} · prompts version ${esc(run.prompts)}</p>
        ${hasDetails ? "" : `<p class="muted">Answers and tool details were deleted after the ${7}-day retention; the scores are kept.</p>`}</section>
    </div>
    <section class="h-card"><h4>Cases <span class="muted">(failures first - click a row for the answer and checks)</span></h4>
      <table class="usage ev-cases-t"><tr><th></th><th>case</th><th>failed checks</th><th>judge</th><th>time</th><th>tokens</th><th>cost</th></tr>${rows}</table>
    </section>`;
  $("h-back").onclick = loadEvals;
  body.querySelectorAll("tr[data-case]").forEach((tr) => (tr.onclick = () => {
    const det = body.querySelector(`tr[data-for="${CSS.escape(tr.dataset.case)}"]`);
    if (det) det.hidden = !det.hidden;
  }));
}

async function compareEvals(a, b) {
  const [ra, rb] = await Promise.all([a, b].map((id) => fetch(`/api/harness/evals/${id}`).then((r) => r.json())));
  const [older, newer] = new Date(ra.started_at) < new Date(rb.started_at) ? [ra, rb] : [rb, ra];
  const so = older.summary, sn = newer.summary;
  // lower is better for time, tokens and cost; higher is better for the rates
  const line = (label, o, n, fmtv, lowerBetter) => {
    const delta = n != null && o != null ? n - o : null;
    const better = delta == null || delta === 0 ? "" : (delta < 0) === lowerBetter ? "up" : "down";
    const arrow = delta == null || delta === 0 ? "=" : delta > 0 ? "▲" : "▼";
    return `<tr><td>${label}</td><td>${fmtv(o)}</td><td>${fmtv(n)}</td><td class="${better}">${arrow} ${delta == null ? "" : fmtv(Math.abs(delta))}</td></tr>`;
  };
  const p = (v) => (v == null ? "–" : `${v}%`);
  const caseMap = (r) => Object.fromEntries(r.cases.map((c) => [c.case_id, c]));
  const co = caseMap(older), cn = caseMap(newer);
  const fixed = Object.keys(cn).filter((k) => co[k] && !co[k].passed && cn[k].passed);
  const broke = Object.keys(cn).filter((k) => co[k] && co[k].passed && !cn[k].passed);
  $("h-sub").textContent = `compare · ${older.label} → ${newer.label}`;
  $("harness-body").innerHTML = `
    <p><button type="button" id="h-back">← Evals</button></p>
    <div class="h-grid">
      <section class="h-card"><h4>${esc(older.label)} → ${esc(newer.label)}</h4>
        <table class="usage"><tr><th>metric</th><th>before</th><th>after</th><th>change</th></tr>
          ${line("Cases passed", so.pass_rate, sn.pass_rate, p, false)}
          ${line("Right agents", so.routing.rate, sn.routing.rate, p, false)}
          ${line("Right tools", so.tools.rate, sn.tools.rate, p, false)}
          ${line("Judge passed", so.judge.rate, sn.judge.rate, p, false)}
          ${line("Typical time (p50)", so.p50_ms, sn.p50_ms, ms, true)}
          ${line("Slow time (p95)", so.p95_ms, sn.p95_ms, ms, true)}
          ${line("Tokens per case", so.avg_tokens, sn.avg_tokens, tok, true)}
          ${line("LLM calls per case", so.avg_llm_calls, sn.avg_llm_calls, (v) => (v == null ? "–" : String(Math.round(v * 100) / 100)), true)}
          ${line("Cost per case", so.avg_cost, sn.avg_cost, usd, true)}
        </table>
        <p class="muted small">prompts ${esc(older.prompts)} → ${esc(newer.prompts)}</p></section>
      <section class="h-card"><h4>Case changes</h4>
        <p><b class="up">Fixed (${fixed.length}):</b> ${fixed.map(esc).join(", ") || "none"}</p>
        <p><b class="down">Newly failing (${broke.length}):</b> ${broke.map(esc).join(", ") || "none"}</p></section>
    </div>`;
  $("h-back").onclick = loadEvals;
}

// Shared tooltip for the dashboard (any element with data-tip).
function hideTip() { $("tip").hidden = true; }
$("harness").addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]");
  const tip = $("tip");
  if (!t) return hideTip();
  tip.innerHTML = t.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});
$("harness").addEventListener("mouseleave", hideTip);

// =====================================================================
// Profile menu (top right)
// =====================================================================

$("profile-btn").onclick = (e) => {
  e.stopPropagation();
  const menu = $("profile-menu");
  menu.hidden = !menu.hidden;
  $("profile-btn").setAttribute("aria-expanded", String(!menu.hidden));
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile")) { $("profile-menu").hidden = true; $("profile-btn").setAttribute("aria-expanded", "false"); }
});
$("logout").onclick = async () => {
  await fetch("/api/logout", { method: "POST" });
  store.set("chatId", null);
  toLogin();
};

async function loadProfile() {
  const r = await fetch("/api/me");
  if (!r.ok) return;
  const { email } = await r.json();
  $("profile-email").textContent = email;
  $("profile-btn").textContent = (email || "M")[0].toUpperCase();
}

// =====================================================================
// Voice (Deepgram STT through the server): click the mic to start, again to stop and send
// =====================================================================

let mic = null; // {stream, recorder, socket, finalText}

$("mic").addEventListener("click", () => (mic ? stopMic() : startMic()));

async function startMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/stt`);
    mic = { stream, socket, recorder: null, finalText: "" };
    $("mic").classList.add("listening");
    $("query").value = "";

    socket.onopen = () => {
      mic.recorder = new MediaRecorder(stream);
      mic.recorder.ondataavailable = (e) => e.data.size && socket.readyState === 1 && socket.send(e.data);
      mic.recorder.start(250);
    };
    socket.onmessage = (m) => {
      const d = JSON.parse(m.data);
      const text = d.channel?.alternatives?.[0]?.transcript;
      if (!text || !mic) return;
      if (d.is_final) mic.finalText += text + " ";
      $("query").value = d.is_final ? mic.finalText : mic.finalText + text;
    };
    socket.onclose = () => {
      const hadMic = !!mic;
      cleanupMic();
      if (hadMic && $("query").value.trim()) sendMessage(undefined, "voice");
    };
    socket.onerror = () => setStatus("voice connection failed");
  } catch (e) {
    cleanupMic();
    setStatus(`mic error: ${e.message}`);
  }
}

function stopMic() {
  if (!mic) return;
  mic.recorder?.stop();
  mic.stream.getTracks().forEach((t) => t.stop());
  if (mic.socket.readyState === 1) mic.socket.send(JSON.stringify({ type: "CloseStream" }));
  else mic.socket.close();
}

function cleanupMic() {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic = null;
  $("mic").classList.remove("listening");
}

// =====================================================================
// Start
// =====================================================================

(async () => {
  await loadGraph();
  if (!graphData.domains) return;
  connect();
  loadProfile();
  await loadChat(chatId);
})();
