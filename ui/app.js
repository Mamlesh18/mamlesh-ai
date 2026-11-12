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
      <div class="msg bot" id="m-${rid}"><div class="bot-main"></div><div class="approvals"></div><div class="drafts"></div><div class="memory"></div></div>`).join("")
    + (pendingQuery ? `<div class="msg user">${esc(pendingQuery)}</div><div class="msg bot"><div class="answer"><span class="thinking">sending…</span></div></div>` : "");
  if (orphanApprovals.some((a) => a.status === "pending")) {  // waiting requests from a question not shown here
    box.insertAdjacentHTML("afterbegin", `<div class="msg bot" id="m-orphans"><b>Waiting for your approval</b><div class="approvals"></div></div>`);
    renderApprovals("orphans");
  }
  messages.forEach((rid) => { renderBot(rid); renderApprovals(rid); renderDrafts(rid); renderMemory(rid); });
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
  el.querySelectorAll(".meta button").forEach((b) => (b.onclick = () => (b.dataset.k === "trace" ? window.open(`/observability#trace/${rid}`, "_blank") : toggleDetail(rid, b.dataset.k))));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- Approvals: every write waits for Mamlesh's click ----------

let orphanApprovals = [];  // pending requests whose question isn't in the open chat (e.g. after a reload)

function approvalsOf(rid) { return rid === "orphans" ? orphanApprovals : runs[rid]?.approvals; }

function renderApprovals(rid) {
  const box = $(`m-${rid}`)?.querySelector(".approvals");
  const list = approvalsOf(rid);
  if (!box || !list) return;
  const label = { approved: "✓ Approved", rejected: "✗ Rejected", expired: "Expired - not done" };
  box.innerHTML = list.map((a) => {
    const args = esc(JSON.stringify(a.args || {}, null, 2));
    if (a.status !== "pending") {
      return `<div class="approval ${esc(a.status)}"><div class="draft-head"><b>${label[a.status] || esc(a.status)}</b>
        <span class="badge ${a.status === "approved" ? "done" : "disabled"}">${esc(a.server)} · ${esc(a.tool)}</span></div>
        ${a.note ? `<p class="muted">Your note: ${esc(a.note)}</p>` : ""}
        <details><summary>details</summary><pre>${args}</pre></details></div>`;
    }
    return `<div class="approval" data-id="${esc(a.approval_id)}">
      <div class="draft-head"><b>⚠ Approval needed</b><span class="badge auth_required">waiting for you</span></div>
      <p>The <b>${esc(a.agent)}</b> agent wants to run <b>${esc(a.tool)}</b> on <b>${esc(a.server)}</b>${rid === "orphans" && a.query ? ` for “${esc(a.query)}”` : ""}:</p>
      <pre>${args}</pre>
      <input class="ap-note" placeholder="Optional note for the agent (e.g. what to change)" autocomplete="off">
      <div class="draft-actions"><button type="button" class="approve">Approve →</button><button type="button" class="reject">Reject</button></div>
      <p class="muted ap-msg">Nothing happens until you choose. Expires in 10 minutes.</p>
    </div>`;
  }).join("");
  box.querySelectorAll(".approval[data-id]").forEach((card) => {
    card.querySelector(".approve").onclick = () => decideApproval(rid, card, true);
    card.querySelector(".reject").onclick = () => decideApproval(rid, card, false);
  });
  updateAttention();
}

async function decideApproval(rid, card, approved) {
  card.querySelectorAll("button").forEach((b) => (b.disabled = true));
  card.querySelector(".ap-msg").textContent = approved ? "Approving…" : "Rejecting…";
  const note = card.querySelector(".ap-note").value.trim();
  const r = await fetch(`/api/approvals/${card.dataset.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved, note }) });
  if (r.status === 401) return toLogin();
  const a = approvalsOf(rid)?.find((x) => x.approval_id === card.dataset.id);
  if (a) Object.assign(a, r.ok ? { status: approved ? "approved" : "rejected", note } : { status: "expired" });
  renderApprovals(rid);
}

function onApprovalEvent(ev) {
  const r = runs[ev.run_id];
  if (ev.type === "approval.request") {
    if (r) { (r.approvals ||= []).push(ev.approval); renderApprovals(ev.run_id); }
    else { orphanApprovals.push(ev.approval); renderMessages(); }
    if (r && !document.body.classList.contains("drawer-open")) openChat();  // a decision is needed: show the chat
  } else {
    const a = (r?.approvals || []).concat(orphanApprovals).find((x) => x.approval_id === ev.approval_id);
    if (a) Object.assign(a, { status: ev.status, note: ev.note });
    if (r) renderApprovals(ev.run_id); else renderMessages();
  }
  updateAttention();
}

function updateAttention() {
  const waiting = Object.values(runs).some((r) => r.approvals?.some((a) => a.status === "pending"))
    || orphanApprovals.some((a) => a.status === "pending");
  $("chat-fab").classList.toggle("attention", waiting);
  $("chat-fab").textContent = waiting ? "Approval needed →" : "Chat →";
}

async function loadPendingApprovals() {
  const r = await fetch("/api/approvals/pending");
  if (!r.ok) return;
  orphanApprovals = (await r.json()).filter((a) => !runs[a.run_id]);
  if (orphanApprovals.length) renderMessages();
  updateAttention();
}

// ---------- "Remember this?": facts from the chat, saved to the Brain only when Mamlesh clicks Save ----------

function renderMemory(rid) {
  const box = $(`m-${rid}`)?.querySelector(".memory");
  const list = runs[rid]?.memory;
  if (!box || !list) return;
  box.innerHTML = list.map((m) => m.status === "pending"
    ? `<div class="memcard" data-id="${esc(m.id)}"><b>💾 Remember this?</b>
        <input value="${esc(m.text)}" aria-label="Fact to remember" autocomplete="off">
        <div class="draft-actions"><button type="button" class="save">Save to memory</button><button type="button" class="dismiss">Dismiss</button></div></div>`
    : `<div class="memcard done"><b>${m.status === "saved" ? `✓ ${{ SUPERSEDE: "Saved - replaced an older fact", MERGE: "Merged into an existing memory", NOOP: "Already remembered" }[m.action] || "Saved to memory"}` : "Dismissed"}</b> <span class="muted">${esc(m.text)}</span></div>`).join("");
  box.querySelectorAll(".memcard[data-id]").forEach((card) => {
    const go = async (save) => {
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      const text = card.querySelector("input").value.trim();
      const r = await fetch(`/api/memory/${rid}/${card.dataset.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ save, text }) });
      if (r.status === 401) return toLogin();
      const m = list.find((x) => x.id === card.dataset.id);
      if (r.ok) { const d = await r.json(); Object.assign(m, { status: d.status, action: d.action, text }); }
      else Object.assign(m, { status: "dismissed" });
      renderMemory(rid);
    };
    card.querySelector(".save").onclick = () => go(true);
    card.querySelector(".dismiss").onclick = () => go(false);
  });
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
                           drafts: m.drafts || [], approvals: m.approvals || [], memory: m.memory || [] };
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
    ? chats.map((c) => `<div class="chat-row"><button type="button" data-id="${esc(c.chat_id)}" class="${c.chat_id === chatId ? "current" : ""}">${esc(c.title)}<small>${new Date(c.updated_at).toLocaleString()}</small></button>
        <button type="button" class="chat-del" data-del="${esc(c.chat_id)}" title="Delete this chat" aria-label="Delete chat">✕</button></div>`).join("")
    : `<p class="muted">No saved chats yet.</p>`;
  list.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => loadChat(b.dataset.id)));
  list.querySelectorAll("button[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this chat with its messages and traces? Sent emails and saved Brain notes are kept. This can't be undone.")) return;
    const r = await fetch(`/api/chats/${b.dataset.del}`, { method: "DELETE" });
    if (r.status === 401) return toLogin();
    if (b.dataset.del === chatId) loadChat(null);
    b.closest(".chat-row").remove();
  }));
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
      <div class="stat"><b>${tok(c.tool_tokens)}</b><span>tool definition tokens (all)</span></div>
    </div>
    ${c.selected ? `<p class="muted">Only the ~${c.selected} tools that fit each task are sent, so about ${tok(c.total)} instead of ${tok(c.total_all_tools)} tokens per call.</p>` : ""}`;
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
    "approval.request": () => `waiting for your approval: ${ev.approval?.server} · ${ev.approval?.tool}`,
    "approval.result": () => `${ev.tool}: ${ev.status}${ev.note ? ` (${ev.note})` : ""}`,
    "guard.injection": () => `⚠ ${ev.tool} result tried to instruct the AI - marked as data`,
    "guard.redacted": () => `removed ${ev.count} secret${ev.count > 1 ? "s" : ""} from ${ev.tool}`,
    "portfolio.updated": () => `new statement: ₹${Number(ev.total_value).toLocaleString("en-IN")} as on ${ev.as_on}`,
  }[ev.type];
  return d ? d() : "";
}

function eventKind(ev) {
  if (ev.type === "tool.error" || ev.type === "run.error" || ev.type === "guard.injection") return "lt-err";
  if (ev.type.startsWith("tool.")) return "lt-tool";
  return ev.type === "usage" ? "lt-cost" : "";
}

function onEvent(ev) {
  if (ev.type.startsWith("eval.")) return; // shown on the Observability page
  if (ev.type === "chat.title") return;     // the History list reads titles when it opens
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
    if (ev.type === "approval.request" || ev.type === "approval.result") onApprovalEvent(ev);
    if (ev.type === "memory.suggest") { r.memory = ev.suggestions; renderMemory(ev.run_id); }
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
  loadPendingApprovals();  // requests still waiting from before a reload
})();
