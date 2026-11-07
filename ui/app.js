// Mamlesh AI OS - live view of the Orchestrator, domain agents and MCP servers.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const tok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const usd = (c) => `$${(c || 0).toFixed(c < 0.01 ? 5 : 4)}`;

let cy;                 // the graph
let graphData = {};     // from /api/graph
let selected = null;    // id of the node shown in the side panel
let run = null;         // the run currently shown: {id, plan, domains: {name: {task, result, status}}, usage: {agent: totals}, totals}
const liveCalls = {};   // server id -> [calls in this browser session, newest first]
const activeCalls = {}; // server id -> number of tool calls still running

// ---------- Graph ----------

// Radial layout: Orchestrator in the centre, domain agents on a circle around it,
// each agent's MCP servers fanned outward, and each server's tools fanned outward again (shown on demand).
const C = { ink: "#0a0a0a", paper: "#ffffff", bg: "#f3efe6", yellow: "#ffe500", pink: "#ff4fa3", blue: "#2f6bff", green: "#00c46a", red: "#ff3b2f", orange: "#ff8a00" };
const R_DOMAIN = 210, R_SERVER = 120, SERVER_SPREAD = 0.7, R_TOOL = 85;
const polar = (cx, cy, r, a) => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
const expanded = new Set(); // server ids whose tools are shown

const toLogin = () => { location.href = "/login"; };

async function loadGraph() {
  const res = await fetch("/api/graph");
  if (res.status === 401) return toLogin();
  graphData = await res.json();
  const els = [{ data: { id: "orchestrator", label: "ORCHESTRATOR", base: "ORCHESTRATOR", kind: "orchestrator" }, position: { x: 0, y: 0 } }];
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

      // Tools: an arc facing away from the agent, two staggered rows when there are many.
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
          width: 92, height: 92, "background-color": C.ink, "font-size": 14, "text-valign": "center", "text-margin-y": 0,
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

  cy.fit(cy.elements(":visible"), 40); // fit only what is shown, not the hidden tool nodes
  if (!loadGraph.started) {
    // Things that must only be set up once, even when the graph is rebuilt after an MCP login.
    loadGraph.started = true;
    window.addEventListener("resize", () => cy.fit(cy.elements(":visible"), 40));
    setInterval(() => cy.edges(".active").forEach((e) => e.style("line-dash-offset", -((Date.now() / 30) % 16))), 50);
  }
  cy.on("pan zoom resize", placeAuthButtons);
  placeAuthButtons();

  cy.on("tap", "node", (e) => {
    const node = e.target;
    selected = node.id();
    if (node.data("kind") === "server") toggleTools(node.id().slice(2), true);
    if (node.data("kind") === "tool") selected = `s:${node.data("server")}`; // show the tool's server in the panel
    renderPanel();
  });
  cy.on("mouseover", "node[kind='tool']", (e) => e.target.addClass("show-label"));
  cy.on("mouseout", "node[kind='tool']", (e) => e.target.removeClass("show-label"));
  $("fit").onclick = () => cy.animate({ fit: { eles: cy.elements(":visible"), padding: 40 }, duration: 300 });
  $("collapse").onclick = () => { [...expanded].forEach((id) => toggleTools(id, false)); cy.animate({ fit: { eles: cy.elements(":visible"), padding: 40 }, duration: 300 }); };
}

// Rebuild the map (e.g. after an MCP server logged in or its login expired). Keeps the current run's colours.
async function reloadGraph() {
  if (cy) cy.destroy();
  expanded.clear();
  await loadGraph();
  if (selected) renderPanel();
}

// ---------- MCP login (OAuth) ----------

// A "⚠ LOG IN" button pinned under every server node that needs a login.
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
  // Open the window first (browsers only allow pop-ups straight from a click), then send it to the login page.
  const popup = window.open("", "mcp-login", "width=520,height=760");
  const r = await fetch(`/api/mcp/${serverId}/auth/start`, { method: "POST" });
  if (r.status === 401) { popup?.close(); return toLogin(); }
  const data = await r.json();
  if (!r.ok) { popup?.close(); alert(data.detail || "Could not start login."); return; }
  if (popup) popup.location = data.url;
  else location.href = data.url; // pop-ups blocked: log in in this tab, the callback page brings you back
  $("status-text").textContent = "waiting for login…";
}

// The callback page tells us when the login window is done; the server also sends an mcp.status event.
window.addEventListener("message", (e) => {
  if (e.origin === location.origin && e.data?.type === "mcp-auth") {
    $("status-text").textContent = e.data.ok ? "connected" : "login failed";
  }
});

function toggleTools(serverId, zoom) {
  const show = !expanded.has(serverId);
  const els = cy.elements(`[server = "${serverId}"]`);
  if (show) { expanded.add(serverId); els.removeClass("hidden"); }
  else { expanded.delete(serverId); els.addClass("hidden"); }
  if (show && zoom) cy.animate({ fit: { eles: cy.getElementById(`s:${serverId}`).union(els), padding: 60 }, duration: 350 });
}

function showTool(serverId) {
  // A tool is being called: make sure its server's tools are visible (without moving the camera).
  if (!expanded.has(serverId)) { expanded.add(serverId); cy.elements(`[server = "${serverId}"]`).removeClass("hidden"); }
}

function setNode(id, state) {
  const n = cy.getElementById(id);
  if (!n.length) return;
  n.removeClass("queued running done failed").addClass(state);
}

function setEdge(target, state) {
  const e = cy.edges(`[target = "${target}"]`);
  e.removeClass("active done");
  if (state) e.addClass(state);
}

// ---------- Cost & tokens ----------

function setUsageLabel(agent, u) {
  const n = cy.getElementById(agent === "orchestrator" ? "orchestrator" : `d:${agent}`);
  if (n.length) n.data("label", `${n.data("base")}\n${usd(u.cost)} · ${tok(u.input_tokens + u.output_tokens)} tok`);
}

function renderUsage() {
  const el = $("usage");
  const rows = Object.entries(run?.usage || {});
  if (!rows.length) { el.className = "muted"; el.textContent = "No LLM calls yet."; return; }
  el.className = "";
  const sum = (k) => rows.reduce((s, [, u]) => s + (u[k] || 0), 0);
  const t = run.totals || { calls: sum("calls"), input_tokens: sum("input_tokens"), cached_tokens: sum("cached_tokens"), output_tokens: sum("output_tokens"), cost: sum("cost") };
  const ctx = (a) => a === "orchestrator" ? "" : tok(graphData.domains.find((d) => d.name === a)?.context?.total || 0);
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${usd(t.cost)}</b><span>total cost${t.duration_ms ? ` · ${(t.duration_ms / 1000).toFixed(1)} s` : ""}</span></div>
      <div class="stat"><b>${tok(t.input_tokens + t.output_tokens)}</b><span>tokens · ${t.calls} LLM calls</span></div>
    </div>
    <table class="usage">
      <tr><th>agent</th><th>calls</th><th>in</th><th>cached</th><th>out</th><th>cost</th><th title="Prompt + tool definitions sent on every call">ctx/call</th></tr>
      ${rows.map(([a, u]) => `<tr><td>${esc(a)}</td><td>${u.calls}</td><td>${tok(u.input_tokens)}</td><td>${tok(u.cached_tokens)}</td><td>${tok(u.output_tokens)}</td><td>${usd(u.cost)}</td><td>${ctx(a)}</td></tr>`).join("")}
      <tr class="total"><td>total</td><td>${t.calls}</td><td>${tok(t.input_tokens)}</td><td>${tok(t.cached_tokens)}</td><td>${tok(t.output_tokens)}</td><td>${usd(t.cost)}</td><td></td></tr>
    </table>`;
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

function usageHtml(agent) {
  const u = run?.usage?.[agent];
  if (!u) return "";
  return `<h4>Tokens &amp; cost in this run</h4>
    <div class="stats">
      <div class="stat"><b>${usd(u.cost)}</b><span>cost · ${u.calls} LLM calls</span></div>
      <div class="stat"><b>${tok(u.input_tokens)} / ${tok(u.output_tokens)}</b><span>in / out tokens (${tok(u.cached_tokens)} cached)</span></div>
    </div>`;
}

function resetGraph() {
  cy.nodes().forEach((n) => n.data("base") && n.data("label", n.data("base")));
  cy.nodes().removeClass("queued running done failed");
  cy.edges().removeClass("active done");
  for (const k in activeCalls) delete activeCalls[k];
}

// ---------- Side panel ----------

function renderPanel() {
  const p = $("panel-body");
  if (!selected) return;

  if (selected === "orchestrator") {
    const steps = run?.plan?.map((s) => `<div class="tool"><b>${esc(s.domain)}</b><p>${esc(s.task)}</p></div>`).join("");
    const oc = graphData.orchestrator?.context || {};
    p.innerHTML = `<h2>Orchestrator</h2><p class="muted">Plans the work and sends each step to a domain agent.</p>
      <h4>Current plan</h4>${steps || '<p class="muted">No plan yet.</p>'}
      ${usageHtml("orchestrator")}
      <h4>Prompt sizes</h4>
      <div class="stats">
        <div class="stat"><b>${tok(oc.planner_prompt_tokens)}</b><span>planner prompt tokens</span></div>
        <div class="stat"><b>${tok(oc.synthesizer_prompt_tokens)}</b><span>synthesizer prompt tokens</span></div>
      </div>`;
    return;
  }

  if (selected.startsWith("d:")) {
    const name = selected.slice(2);
    const d = graphData.domains.find((x) => x.name === name);
    const r = run?.domains?.[name];
    const servers = d.servers.map((s) =>
      `<div class="tool"><b>${esc(s.name)}</b> <span class="badge ${s.status}">${s.status}</span><p>${s.tools.length} tools · ${esc(s.transport)}</p></div>`).join("");
    p.innerHTML = `<h2>${esc(name)} agent</h2><p class="muted">${esc(d.description)}</p>
      <h4>In this run</h4>${r ? `<span class="badge ${r.status}">${r.status}</span>
        <p><b>Task:</b> ${esc(r.task)}</p>${r.result ? `<p><b>Result:</b> ${esc(r.result)}</p>` : ""}` : '<p class="muted">Not used in this run.</p>'}
      ${usageHtml(name)}
      ${contextHtml(d.context)}
      <h4>MCP servers / tools</h4>${servers || '<p class="muted">No tools configured yet. Add MCP servers in mcp_servers/config.py.</p>'}`;
    return;
  }

  if (selected.startsWith("s:")) renderServer(selected.slice(2));
}

async function renderServer(id) {
  const s = graphData.domains.flatMap((d) => d.servers).find((x) => x.id === id);
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
    ${s.error ? `<pre class="muted">${esc(s.error)}</pre>` : ""}
    <h4>Calls</h4><div id="calls"><p class="muted">Loading…</p></div>
    <h4>Tools (${s.tools.length})</h4>${tools || '<p class="muted">No tools.</p>'}`;

  // Merge saved history (MongoDB) with calls seen live in this tab.
  let saved = [];
  try { saved = await (await fetch(`/api/mcp/${id}/calls`)).json(); } catch {}
  if (selected !== `s:${id}`) return;
  const live = liveCalls[id] || [];
  const seen = new Set(live.map((c) => c.key));
  const calls = [...live, ...saved.filter((c) => !seen.has(`${c.run_id}|${c.tool}|${c.ts}`))];
  renderCalls(calls);
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

// ---------- Live events ----------

function logEvent(ev) {
  if (ev.type === "token") return;
  // Functions, so only the matching event's text is built (each event has different fields).
  const describe = {
    "run.start": () => `query: ${ev.query}`,
    plan: () => `plan: ${(ev.steps || []).map((s) => s.domain).join(", ") || "answer directly"}`,
    "domain.start": () => `${ev.domain} → ${ev.task}`,
    "domain.end": () => `${ev.domain} ${ev.status}`,
    "tool.start": () => `${ev.server} · ${ev.tool}()`,
    "tool.end": () => `${ev.server} · ${ev.tool} ✓ ${ev.duration_ms} ms`,
    "tool.error": () => `${ev.server} · ${ev.tool} ✗ ${ev.error}`,
    usage: () => `${ev.agent} LLM call: ${ev.input_tokens} in / ${ev.output_tokens} out · ${usd(ev.cost)}`,
    "run.end": () => `done · ${usd(ev.totals?.cost)} · ${tok((ev.totals?.input_tokens || 0) + (ev.totals?.output_tokens || 0))} tokens`,
    "run.error": () => `error: ${ev.error}`,
    "mcp.status": () => `${ev.server} → ${ev.status.replace("_", " ")}`,
  }[ev.type];
  const what = describe ? describe() : "";
  const li = document.createElement("li");
  const kind = ev.type.startsWith("tool.") ? (ev.type === "tool.error" ? "lt-err" : "lt-tool") : ev.type === "usage" ? "lt-cost" : ev.type === "run.error" ? "lt-err" : "";
  li.innerHTML = `<span class="t ${kind}">${new Date(ev.ts).toLocaleTimeString()} ${esc(ev.type)}</span> ${esc(what)}`;
  $("log").prepend(li);
}

function onEvent(ev) {
  if (ev.type === "mcp.status") {
    // An MCP server logged in, or its login expired: redraw the map with its new tools / LOG IN button.
    logEvent(ev);
    $("status-text").textContent = ev.status === "connected" ? `${ev.server} connected` : `${ev.server}: ${ev.status.replace("_", " ")}`;
    reloadGraph();
    return;
  }
  if (ev.type === "run.start") {
    run = { id: ev.run_id, plan: [], domains: {}, usage: {}, totals: null };
    resetGraph();
    renderUsage();
    $("log").innerHTML = "";
    $("answer").textContent = "";
    $("answer").classList.remove("muted");
    if (!$("query").value) $("query").value = ev.query;
    setBusy(true);
  }
  if (!run || ev.run_id !== run.id) return;
  logEvent(ev);

  switch (ev.type) {
    case "node.start": setNode("orchestrator", "running"); break;
    case "plan":
      run.plan = ev.steps;
      ev.steps.forEach((s) => setNode(`d:${s.domain}`, "queued"));
      break;
    case "domain.start":
      run.domains[ev.domain] = { task: ev.task, status: "running" };
      setNode(`d:${ev.domain}`, "running"); setEdge(`d:${ev.domain}`, "active");
      break;
    case "domain.end":
      Object.assign(run.domains[ev.domain] ||= {}, { status: ev.status, result: ev.result });
      setNode(`d:${ev.domain}`, ev.status === "done" ? "done" : "failed");
      setEdge(`d:${ev.domain}`, "done");
      break;
    case "tool.start": {
      activeCalls[ev.server] = (activeCalls[ev.server] || 0) + 1;
      setNode(`s:${ev.server}`, "running"); setEdge(`s:${ev.server}`, "active");
      showTool(ev.server);
      setNode(`t:${ev.server}/${ev.tool}`, "running"); setEdge(`t:${ev.server}/${ev.tool}`, "active");
      (liveCalls[ev.server] ||= []).unshift({ ...ev, status: "running", key: null });
      break;
    }
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
    case "token": $("answer").textContent += ev.text; break;
    case "usage":
      run.usage[ev.agent] = ev.agent_total;
      setUsageLabel(ev.agent, ev.agent_total);
      renderUsage();
      break;
    case "run.end":
      run.usage = ev.usage || run.usage;
      run.totals = ev.totals;
      Object.entries(run.usage).forEach(([a, u]) => setUsageLabel(a, u));
      renderUsage();
      setNode("orchestrator", "done");
      if (!$("answer").textContent) $("answer").textContent = ev.answer;
      setBusy(false);
      break;
    case "run.error":
      setNode("orchestrator", "failed");
      $("answer").textContent = `Error: ${ev.error}`;
      setBusy(false);
      break;
  }

  // Keep the side panel live.
  if (selected?.startsWith("s:") && ev.server === selected.slice(2)) renderCalls(liveCalls[ev.server]);
  else if (selected && !selected.startsWith("s:") && ev.type !== "token") renderPanel();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { $("status-dot").className = "dot live"; $("status-text").textContent = "ready"; };
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = async () => {
    $("status-dot").className = "dot";
    $("status-text").textContent = "reconnecting…";
    // If the socket closed because the session expired, go to the login page instead of retrying forever.
    try { if ((await fetch("/api/graph", { method: "GET" })).status === 401) return toLogin(); } catch {}
    setTimeout(connect, 1500);
  };
}

function setBusy(busy) {
  $("status-dot").className = busy ? "dot busy" : "dot live";
  $("status-text").textContent = busy ? "working…" : "ready";
}

// ---------- Sending a query ----------

async function submit(source = "text") {
  const query = $("query").value.trim();
  if (!query) return;
  const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, source }) });
  if (r.status === 401) return toLogin();
  if (!r.ok) alert(await r.text());
  $("query").value = "";
}

$("query-form").addEventListener("submit", (e) => { e.preventDefault(); submit("text"); });

// ---------- Voice (Deepgram STT): click mic to start, click again to stop and send ----------

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
      if (hadMic && $("query").value.trim()) submit("voice");
    };
    socket.onerror = () => { $("status-text").textContent = "voice connection failed"; };
  } catch (e) {
    cleanupMic();
    $("status-text").textContent = `mic error: ${e.message}`;
  }
}

function stopMic() {
  if (!mic) return;
  mic.recorder?.stop();
  mic.stream.getTracks().forEach((t) => t.stop());
  if (mic.socket.readyState === 1) mic.socket.send(JSON.stringify({ type: "CloseStream" })); // Deepgram sends final words, then closes
  else mic.socket.close();
}

function cleanupMic() {
  mic?.stream.getTracks().forEach((t) => t.stop());
  mic = null;
  $("mic").classList.remove("listening");
}

// ---------- Start ----------

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  toLogin();
});

loadGraph().then(() => graphData.domains && connect());
