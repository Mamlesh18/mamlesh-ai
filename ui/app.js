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

async function loadGraph() {
  graphData = await (await fetch("/api/graph")).json();
  const els = [{ data: { id: "orchestrator", label: "Orchestrator", base: "Orchestrator", kind: "orchestrator" } }];
  for (const d of graphData.domains) {
    els.push({ data: { id: `d:${d.name}`, label: d.name, base: d.name, kind: "domain" } });
    els.push({ data: { source: "orchestrator", target: `d:${d.name}` } });
    for (const s of d.servers) {
      els.push({ data: { id: `s:${s.id}`, label: s.name, kind: "server" }, classes: s.status });
      els.push({ data: { source: `d:${d.name}`, target: `s:${s.id}` } });
    }
  }

  cy = cytoscape({
    container: $("graph"),
    elements: els,
    layout: { name: "breadthfirst", roots: ["orchestrator"], spacingFactor: 1.15, padding: 30 },
    wheelSensitivity: 0.2,
    style: [
      { selector: "node", style: {
          label: "data(label)", color: "#e6e8ee", "font-size": 12, "text-valign": "bottom", "text-margin-y": 6,
          "text-wrap": "wrap", "text-halign": "center",
          "background-color": "#2a2f3d", "border-width": 2, "border-color": "#3a4152", width: 34, height: 34 } },
      { selector: "node[kind='orchestrator']", style: { width: 58, height: 58, "background-color": "#1f3b73", "font-size": 14, "font-weight": 600 } },
      { selector: "node[kind='domain']", style: { width: 44, height: 44, shape: "round-rectangle" } },
      { selector: "node[kind='server']", style: { shape: "diamond", width: 30, height: 30 } },
      { selector: "node.disabled", style: { opacity: 0.35 } },
      { selector: "node.error", style: { "border-color": "#f0566a" } },
      { selector: "node.queued", style: { "border-color": "#4f8cff", "border-style": "dashed" } },
      { selector: "node.running", style: { "border-color": "#4f8cff", "border-width": 5, "background-color": "#24407a" } },
      { selector: "node.done", style: { "border-color": "#3ecf8e", "border-width": 4 } },
      { selector: "node.failed", style: { "border-color": "#f0566a", "border-width": 4, "background-color": "#5a1f2a" } },
      { selector: "node:selected", style: { "overlay-color": "#4f8cff", "overlay-opacity": 0.15 } },
      { selector: "edge", style: { width: 2, "line-color": "#2a2f3d", "curve-style": "bezier" } },
      { selector: "edge.active", style: { width: 4, "line-color": "#4f8cff", "line-style": "dashed", "line-dash-pattern": [8, 4] } },
      { selector: "edge.done", style: { "line-color": "#3ecf8e" } },
    ],
  });

  cy.on("tap", "node", (e) => { selected = e.target.id(); renderPanel(); });
  setInterval(() => cy.edges(".active").forEach((e) => e.style("line-dash-offset", -((Date.now() / 40) % 12))), 50);
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
  const p = $("panel");
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
  $("panel").innerHTML = `<h2>${esc(s.name)}</h2>
    <span class="badge ${s.status}">${s.status}</span> <span class="muted">${esc(s.transport)}</span>
    ${s.error ? `<pre class="muted">${esc(s.error)}</pre>` : ""}
    <h4>Tools (${s.tools.length})</h4>${tools || '<p class="muted">No tools.</p>'}
    <h4>Calls</h4><div id="calls"><p class="muted">Loading…</p></div>`;

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
  const what = {
    "run.start": `query: ${ev.query}`,
    plan: `plan: ${ev.steps.map((s) => s.domain).join(", ") || "answer directly"}`,
    "domain.start": `${ev.domain} → ${ev.task}`,
    "domain.end": `${ev.domain} ${ev.status}`,
    "tool.start": `${ev.server} · ${ev.tool}()`,
    "tool.end": `${ev.server} · ${ev.tool} ✓ ${ev.duration_ms} ms`,
    "tool.error": `${ev.server} · ${ev.tool} ✗ ${ev.error}`,
    usage: `${ev.agent} LLM call: ${ev.input_tokens} in / ${ev.output_tokens} out · ${usd(ev.cost)}`,
    "run.end": `done · ${usd(ev.totals?.cost)} · ${tok((ev.totals?.input_tokens || 0) + (ev.totals?.output_tokens || 0))} tokens`,
    "run.error": `error: ${ev.error}`,
  }[ev.type] || "";
  const li = document.createElement("li");
  li.innerHTML = `<span class="t">${new Date(ev.ts).toLocaleTimeString()} ${esc(ev.type)}</span> ${esc(what)}`;
  $("log").prepend(li);
}

function onEvent(ev) {
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
  ws.onopen = () => { $("status-dot").className = "dot live"; $("status").textContent = "ready"; };
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => { $("status-dot").className = "dot"; $("status").textContent = "reconnecting…"; setTimeout(connect, 1500); };
}

function setBusy(busy) {
  $("status-dot").className = busy ? "dot busy" : "dot live";
  $("status").textContent = busy ? "working…" : "ready";
}

// ---------- Sending a query ----------

async function submit(source = "text") {
  const query = $("query").value.trim();
  if (!query) return;
  const r = await fetch("/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, source }) });
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
    socket.onerror = () => { $("status").textContent = "voice connection failed"; };
  } catch (e) {
    cleanupMic();
    $("status").textContent = `mic error: ${e.message}`;
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

loadGraph().then(connect);
