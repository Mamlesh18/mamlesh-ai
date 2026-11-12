// Observability page: Overview (traces + metrics), Evals (run, watch live, compare) and Prompts (versions).
// Routes live in the URL hash: #overview, #trace/<run>, #evals, #eval/<id>, #compare/<a>/<b>, #prompts, #prompt/<name>

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));
const usd = (c) => `$${(c || 0).toFixed(c < 0.01 ? 5 : 4)}`;
const ms = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
const pctTxt = (r) => (r?.rate == null ? "–" : `${r.rate}%`);
const passIcon = (ok) => (ok ? `<span class="ok-mark" title="passed">✓</span>` : `<span class="bad-mark" title="failed">✗</span>`);
const tile = (v, label, sub = "") => `<div class="stat"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
const KIND_LABEL = { run: "Query", planner: "Step", agent: "Step", synthesizer: "Step", llm: "LLM call", tool: "Tool call" };
const body = $("harness-body");

class LoggedOut extends Error {}
async function api(url, opts = {}) {
  const r = await fetch(url, opts.json ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.json) } : opts);
  if (r.status === 401) { location.href = "/login"; throw new LoggedOut(); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `${r.status}`);
  return data;
}
const post = (url, json) => api(url, { json });

// ---------------------------------------------------------------- routing

let view = 0;          // bumps on every navigation, so a slow load never paints over a newer page
let days = 7;
let route = [];        // e.g. ["eval", "abc123"]

function go() {
  route = (location.hash.slice(1) || "overview").split("/").map(decodeURIComponent);
  const sec = { trace: "overview", eval: "evals", compare: "evals", prompt: "prompts" }[route[0]] || route[0];
  document.querySelectorAll(".h-tabs a").forEach((a) => a.classList.toggle("on", a.dataset.sec === sec));
  document.querySelector(".h-range").hidden = route[0] !== "overview";
  hideTip();
  const v = ++view;
  const page = { overview: overview, trace: trace, evals: evals, eval: evalRun, compare: compare, prompts: prompts, prompt: promptPage, memory: memoryPage }[route[0]] || overview;
  body.innerHTML = `<p class="muted">Loading…</p>`;
  page(v, ...route.slice(1)).catch((e) => { if (!(e instanceof LoggedOut) && v === view) body.innerHTML = `<p class="down">${esc(e.message)}</p>`; });
}
window.addEventListener("hashchange", go);
document.querySelectorAll(".h-range button").forEach((b) => (b.onclick = () => {
  days = Number(b.dataset.days);
  document.querySelectorAll(".h-range button").forEach((x) => x.classList.toggle("on", x === b));
  go();
}));
const stale = (v) => v !== view;
const sub = (t) => ($("h-sub").textContent = t);

// ---------------------------------------------------------------- live events

const live = {};          // run id -> {query, started} for queries running right now
let evalLive = null;      // {eval_id, total, case_ids, state: {case_id: "run"|"pass"|"fail"}, failed: {case_id: [...]}}
let refreshTimer = null;

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => { $("status-dot").className = "dot live"; $("status-text").textContent = "live"; };
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => {
    $("status-dot").className = "dot";
    $("status-text").textContent = "reconnecting…";
    setTimeout(connect, 1500);
  };
}

function onEvent(ev) {
  if (ev.type === "run.start") { live[ev.run_id] = { query: ev.query, started: Date.now() }; paintLive(); }
  if (ev.type === "run.end" || ev.type === "run.error") {
    delete live[ev.run_id];
    paintLive();
    if (route[0] === "overview") { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => route[0] === "overview" && go(), 1500); }
  }
  if (!evalLive && !evalsLoading && ev.type?.startsWith("eval.") && ev.type !== "eval.done" && route[0] === "evals") { go(); return; } // a run started elsewhere
  if (!evalLive || ev.eval_id !== evalLive.eval_id) return;
  if (ev.type === "eval.case") evalLive.state[ev.case_id] = "run";
  if (ev.type === "eval.progress") {
    evalLive.state[ev.case_id] = ev.passed ? "pass" : "fail";
    evalLive.failed[ev.case_id] = ev.failed || [];
  }
  if (ev.type === "eval.done") { const id = evalLive.eval_id; evalLive = null; if (route[0] === "evals") go(); else if (route[0] === "eval" && route[1] === id) go(); return; }
  paintEvalLive();
}

function paintLive() {
  const box = $("live-now");
  if (!box) return;
  const rows = Object.entries(live);
  box.innerHTML = rows.length
    ? rows.map(([id, r]) => `<li><span class="dot busy"></span> ${esc(r.query)} <small class="muted" data-since="${r.started}"></small></li>`).join("")
    : `<li class="muted">Nothing running. Ask something on the agent map and it shows up here as it runs.</li>`;
  tickLive();
}
function tickLive() {
  document.querySelectorAll("[data-since]").forEach((el) => (el.textContent = `${((Date.now() - Number(el.dataset.since)) / 1000).toFixed(0)}s`));
}
setInterval(tickLive, 1000);

// ---------------------------------------------------------------- overview

async function overview(v) {
  const m = await api(`/api/harness/metrics?days=${days}`);
  if (stale(v)) return;
  if (!m.available) { body.innerHTML = `<p class="muted">MongoDB is not connected, so there are no traces.</p>`; return; }
  const k = m.kpis;
  sub(`last ${m.days === 1 ? "24 hours" : `${m.days} days`} · ${k.queries} queries`);
  const liveCard = `<section class="h-card live-card"><h4>Running now</h4><ul id="live-now" class="live-list"></ul></section>`;
  if (!k.queries) {
    body.innerHTML = `${liveCard}<div class="h-empty"><h3>No traces yet</h3><p class="muted">Ask something in the chat - every query is traced here.</p></div>${retentionHtml(m)}`;
    paintLive(); bindRetention();
    return;
  }
  const maxCost = Math.max(...m.daily.map((d) => d.cost), 0.000001);
  const maxStep = Math.max(...m.steps.map((s) => s.avg_ms || 0), 1);
  body.innerHTML = `
    <div class="h-kpis">
      ${tile(ms(k.p50_ms), "typical answer time", `p95 ${ms(k.p95_ms)}`)}
      ${tile(ms(k.ttft_p50_ms), "until the first word", "median")}
      ${tile(usd(k.cost), "total cost", `${usd(k.avg_cost)} per query${m.background_cost ? ` + ${usd(m.background_cost)} titles/summaries` : ""}`)}
      ${tile(tok(k.avg_tokens), "tokens per query", `${k.cached_share}% of input cached`)}
      ${tile(k.avg_llm_calls, "LLM calls per query")}
      ${tile(`${k.queries ? Math.round((k.errors / k.queries) * 100) : 0}%`, "failed queries", `${k.errors} of ${k.queries}`)}
    </div>
    <div class="h-grid">
      ${liveCard}
      <section class="h-card"><h4>Latest queries <span class="muted">(click for the timeline)</span></h4>${runList(m.recent || [], "recent")}</section>
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
    ${guardHtml(m.guardrails)}
    <div class="h-grid">
      <section class="h-card"><h4>Slowest queries</h4>${runList(m.slowest, "time")}</section>
      <section class="h-card"><h4>Most expensive queries</h4>${runList(m.expensive, "cost")}</section>
    </div>
    ${retentionHtml(m)}`;
  paintLive();
  bindRetention();
}

function guardHtml(g) {
  if (!g) return "";
  const st = { approved: "up", rejected: "down", expired: "muted", pending: "" };
  return `<div class="h-grid">
    <section class="h-card"><h4>Approvals <span class="muted">every write waits for your click</span></h4>
      <div class="h-kpis mini-kpis">${tile(g.approvals, "asked")}${tile(g.approved, "approved")}${tile(g.rejected, "rejected")}${tile(g.expired, "expired", "no answer in 10 min")}</div>
      ${g.recent_approvals.length ? `<table class="usage"><tr><th>tool</th><th>server</th><th>decision</th><th>when</th></tr>
        ${g.recent_approvals.map((a) => `<tr><td>${esc(a.tool)}</td><td>${esc(a.server || "")}</td><td class="${st[a.status] || ""}">${esc(a.status)}</td><td>${ago(a.at)}</td></tr>`).join("")}</table>`
        : `<p class="muted">No write actions asked for yet.</p>`}
      ${g.avg_wait_ms ? `<p class="muted small">You took ${ms(g.avg_wait_ms)} on average to decide.</p>` : ""}
    </section>
    <section class="h-card"><h4>Protection</h4>
      <div class="h-kpis mini-kpis">${tile(g.injections, "injection warnings", "tool results that tried to instruct the AI")}${tile(g.secrets_removed, "secrets removed", "keys, tokens, passwords, card numbers")}</div>
      ${g.recent_injections.length ? `<ul class="checks">${g.recent_injections.map((i) => `<li><span class="bad-mark">!</span> <b>${esc(i.tool)}</b> ${esc((i.found || []).join("; "))} <a href="#trace/${encodeURIComponent(i.run_id)}">trace</a></li>`).join("")}</ul>`
        : `<p class="muted">Nothing suspicious in tool results.</p>`}
      <p class="muted small">Email addresses must come from you (this chat or earlier emails) - the agent can't guess them.</p>
    </section></div>`;
}

function runList(rows, by) {
  if (!rows.length) return `<p class="muted">Nothing yet.</p>`;
  return `<ol class="runlist">${rows.map((r) => `<li><a class="run-btn" href="#trace/${encodeURIComponent(r.run_id)}">
    <span class="q">${esc(r.query)}</span>
    <span class="f">${by === "cost" ? `<b>${usd(r.cost)}</b> · ${ms(r.duration_ms)}` : `<b>${ms(r.duration_ms)}</b> · ${usd(r.cost)}`} · ${tok(r.tokens)} tok${by === "recent" ? ` · ${ago(r.start)}` : ""}${r.status !== "ok" ? ` · <span class="down">${esc(r.status)}</span>` : ""}</span>
  </a></li>`).join("")}</ol>`;
}

function retentionHtml(m) {
  return `<section class="h-card h-retention">
    <h4>Data retention</h4>
    <p>Traces, step-by-step events and eval answers are <b>deleted automatically after ${m.retention_days} days</b>. Your chats, their answers, eval scores and prompt versions are kept.</p>
    <p class="muted">${m.stored_spans} spans stored${m.oldest_trace ? ` · oldest from ${new Date(m.oldest_trace).toLocaleString()}` : ""}</p>
    <button type="button" id="delete-traces">Delete all traces now</button> <span id="delete-status" class="muted"></span>
  </section>`;
}

function bindRetention() {
  $("delete-traces").onclick = async () => {
    if (!confirm("Delete all traces and step-by-step events now? Chats and answers are kept. This can't be undone.")) return;
    const d = await api("/api/harness/traces", { method: "DELETE" });
    $("delete-status").textContent = `Deleted ${d.spans} spans and ${d.events} events.`;
    setTimeout(go, 1200);
  };
}

// One query as a waterfall: every step, LLM call and tool call on a shared timeline.
async function trace(v, runId) {
  const spans = await api(`/api/harness/traces/${encodeURIComponent(runId)}`);
  if (stale(v)) return;
  if (!spans.length) {
    body.innerHTML = `<p><a class="btn-link" href="#overview">← Overview</a></p>
      <p class="muted">No trace for this query - it ran before tracing existed, or it is older than the retention period.</p>`;
    return;
  }
  const root = spans.find((s) => s.kind === "run") || spans[0];
  const total = Math.max(root.duration_ms || 0, ...spans.map((s) => s.offset_ms + (s.duration_ms || 0)), 1);
  const a = root.attrs;
  sub(`trace · ${ms(total)}`);
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
  const versions = a.prompts ? Object.entries(a.prompts).map(([n, ver]) => `${esc(n)} v${ver}`).join(" · ") : "";
  body.innerHTML = `
    <p><a class="btn-link" href="#overview">← Overview</a></p>
    <section class="h-card">
      <h4>${esc(a.query || "Query")}</h4>
      <p class="muted">${new Date(root.start).toLocaleString()} · ${ms(total)} · ${usd(a.cost)} · ${tok((a.input_tokens || 0) + (a.output_tokens || 0))} tokens · ${a.calls || 0} LLM calls${a.history_chars ? ` · ${tok(a.history_chars)} characters of chat history sent` : ""}</p>
      ${versions ? `<p class="muted small">prompts: ${versions}</p>` : ""}
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
}

// ---------------------------------------------------------------- evals

let evalCompare = new Set();   // two eval ids to compare
let evalCases = null;          // the test set (cached)
let trying = {};               // {prompt: version} to try in the next run (set from the Prompts tab)
let evalsLoading = false;

const versionsText = (pv, tried) => Object.entries(tried || {}).map(([n, ver]) => `${esc(n)} v${ver}`).join(", ");

async function evals(v) {
  evalsLoading = true;
  try { await evalsPage(v); } finally { evalsLoading = false; }
}

async function evalsPage(v) {
  const [{ running, runs }, cases] = await Promise.all([api("/api/harness/evals"), evalCases || api("/api/harness/evals/cases")]);
  evalCases = cases;
  if (stale(v)) return;
  const tags = [...new Set(evalCases.flatMap((c) => c.tags || []))].sort();
  sub(`${evalCases.length} test cases · ${runs.length} runs`);
  const runRow = (x) => {
    const s = x.summary;
    const tried = versionsText(x.prompt_versions, x.trying);
    return `<tr data-eval="${esc(x.eval_id)}" class="clickable">
      <td><input type="checkbox" data-cmp="${esc(x.eval_id)}" ${evalCompare.has(x.eval_id) ? "checked" : ""} ${x.status !== "done" ? "disabled" : ""} aria-label="compare"></td>
      <td>${esc(x.label)}<small>${new Date(x.started_at).toLocaleString()} · ${x.total} cases${tried ? ` · <b>trying ${tried}</b>` : ""}</small></td>
      ${x.status !== "done" ? `<td colspan="7" class="muted">${x.status === "running" ? `running… ${x.done}/${x.total}` : esc(x.status)}</td>` : `
      <td><b>${s.pass_rate}%</b> <small>${s.passed}/${s.cases}</small></td><td>${pctTxt(s.routing)}</td><td>${pctTxt(s.tools)}</td>
      <td>${pctTxt(s.judge)}<small>avg ${s.judge_avg_score ?? "–"}/5</small></td><td>${ms(s.p50_ms)}<small>p95 ${ms(s.p95_ms)}</small></td>
      <td>${tok(s.avg_tokens)}</td><td>${usd(s.avg_cost)}</td>`}
    </tr>`;
  };
  const tryingChips = Object.entries(trying).map(([n, ver]) => `<span class="chip">${esc(n)} v${ver} <button type="button" data-untry="${esc(n)}" title="Use the live version">✕</button></span>`).join("");
  body.innerHTML = `
    <section class="h-card ev-start">
      <h4>Run the test set</h4>
      <p class="muted">Runs the cases against your real agents in <b>sandbox mode</b>: anything that would write, send, pay or delete only reports what it would have done. Read tools run for real. A full run takes about 2 minutes and costs about $0.09.</p>
      <form id="ev-form" class="ev-form">
        <input id="ev-label" placeholder="Label, e.g. baseline" autocomplete="off">
        <select id="ev-tag" aria-label="Only cases tagged"><option value="">All ${evalCases.length} cases</option>${tags.map((t) => `<option ${route[1] === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
        <button type="submit" id="ev-run" ${running ? "disabled" : ""}>${running ? "Running…" : "Run evals →"}</button>
      </form>
      <p class="ev-trying">${tryingChips ? `Prompt versions to try (live agents are not changed): ${tryingChips}` : `<span class="muted">Uses the live prompt versions. To test a new version, open it in <a href="#prompts">Prompts</a> and click “Test in evals”.</span>`}</p>
      <div id="ev-live" ${running ? "" : "hidden"}></div>
    </section>
    <section class="h-card">
      <h4>Runs ${runs.length > 1 ? `<span class="muted">tick two to compare</span>` : ""}</h4>
      ${runs.length ? `<table class="usage ev-runs"><tr><th></th><th>run</th><th>pass</th><th>routing</th><th>tools</th><th>judge</th><th>latency</th><th>tokens/q</th><th>cost/q</th></tr>
        ${runs.map(runRow).join("")}</table>
        <button type="button" id="ev-compare" ${evalCompare.size === 2 ? "" : "disabled"}>Compare selected</button>` : `<p class="muted">No runs yet. Start the first one above - it becomes your baseline.</p>`}
    </section>
    <section class="h-card ev-cases">
      <h4>Test set <span class="muted">${evalCases.length} cases in harness/evals/cases.yaml · “Run” tests one case on its own</span></h4>
      <table class="usage"><tr><th></th><th>case</th><th>question</th><th>expects</th></tr>
        ${evalCases.map((c) => `<tr><td><button type="button" class="mini" data-one="${esc(c.id)}" ${running ? "disabled" : ""}>Run</button></td><td>${esc(c.id)}<small>${esc((c.tags || []).join(", "))}</small></td><td>${esc(c.query)}${c.history ? "<small>(with earlier chat turns)</small>" : ""}</td><td>${expectText(c.expect || {})}</td></tr>`).join("")}
      </table></section>`;

  $("ev-form").onsubmit = (e) => {
    e.preventDefault();
    const tag = $("ev-tag").value;
    startEval({ label: $("ev-label").value.trim(), tags: tag ? [tag] : null });
  };
  body.querySelectorAll("[data-one]").forEach((b) => (b.onclick = () => startEval({ label: `case ${b.dataset.one}`, ids: [b.dataset.one] })));
  body.querySelectorAll("[data-untry]").forEach((b) => (b.onclick = () => { delete trying[b.dataset.untry]; go(); }));
  body.querySelectorAll("tr[data-eval]").forEach((tr) => (tr.onclick = (e) => { if (!e.target.matches("input")) location.hash = `eval/${tr.dataset.eval}`; }));
  body.querySelectorAll("input[data-cmp]").forEach((cb) => (cb.onchange = () => {
    cb.checked ? evalCompare.add(cb.dataset.cmp) : evalCompare.delete(cb.dataset.cmp);
    if (evalCompare.size > 2) { evalCompare.delete([...evalCompare][0]); go(); return; }
    $("ev-compare").disabled = evalCompare.size !== 2;
  }));
  if ($("ev-compare")) $("ev-compare").onclick = () => (location.hash = `compare/${[...evalCompare].join("/")}`);

  if (running) await watchEval(running, runs.find((r) => r.eval_id === running));
}

async function startEval(req) {
  document.querySelectorAll("#ev-run, [data-one]").forEach((b) => (b.disabled = true));
  try {
    const { eval_id } = await post("/api/harness/evals", { ...req, prompts: Object.keys(trying).length ? trying : null });
    trying = {};
    evalLive = null;
    if (location.hash !== "#evals") location.hash = "evals"; else go();
    return eval_id;
  } catch (e) {
    if (!(e instanceof LoggedOut)) alert(e.message);
    document.querySelectorAll("#ev-run, [data-one]").forEach((b) => (b.disabled = false));
  }
}

// The run in progress: one square per case, filled in live as each case starts and finishes.
async function watchEval(id, row) {
  if (!evalLive || evalLive.eval_id !== id) {
    evalLive = { eval_id: id, total: row?.total || 0, case_ids: row?.case_ids || [], state: {}, failed: {}, label: row?.label };
    const run = await api(`/api/harness/evals/${id}`);  // cases already finished before this page opened
    Object.values(run.details || {}).forEach((d) => {
      evalLive.state[d.case_id] = d.passed ? "pass" : "fail";
      evalLive.failed[d.case_id] = Object.entries(d.checks).filter(([, c]) => !c.passed).map(([n]) => n);
    });
  }
  paintEvalLive();
}

function paintEvalLive() {
  const box = $("ev-live");
  if (!box || !evalLive) return;
  box.hidden = false;
  const L = evalLive, ids = L.case_ids.length ? L.case_ids : Object.keys(L.state);
  const done = ids.filter((c) => ["pass", "fail"].includes(L.state[c])).length;
  const passed = ids.filter((c) => L.state[c] === "pass").length;
  const total = L.total || ids.length;
  const row = document.querySelector(`tr[data-eval="${CSS.escape(L.eval_id)}"] td[colspan]`);
  if (row) row.textContent = `running… ${done}/${total}`;
  box.innerHTML = `
    <div class="ev-live-head"><b>Running “${esc(L.label || "")}”</b> <span class="muted">${done}/${total} done · ${passed} passed · ${done - passed} failed</span></div>
    <div class="progress"><span style="width:${total ? Math.round((done / total) * 100) : 0}%"></span><em>${done}/${total}</em></div>
    <div class="case-grid">${ids.map((c) => {
      const st = L.state[c] || "wait";
      const tipTxt = { wait: "waiting", run: "running…", pass: "passed", fail: `failed: ${(L.failed[c] || []).join(", ")}` }[st];
      return `<span class="cg cg-${st}" data-tip="<b>${esc(c)}</b><br>${esc(tipTxt)}">${st === "pass" ? "✓" : st === "fail" ? "✗" : st === "run" ? "…" : ""}<em>${esc(c)}</em></span>`;
    }).join("")}</div>
    <p class="muted small">Grey: waiting · yellow: running · ✓ passed · ✗ failed. Results open when the run finishes.</p>`;
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

async function evalRun(v, id) {
  const run = await api(`/api/harness/evals/${encodeURIComponent(id)}`);
  if (stale(v)) return;
  const s = run.summary;
  sub(`eval · ${run.label}`);
  if (!s) {
    body.innerHTML = `<p><a class="btn-link" href="#evals">← Evals</a></p><p class="muted">This run is ${esc(run.status)}${run.status === "running" ? ` (${run.done}/${run.total}) - watch it live on the Evals tab` : ""}.</p>`;
    return;
  }
  const tagRows = Object.entries(s.by_tag).map(([t, x]) => {
    const p = Math.round((x.passed / x.of) * 100);
    return `<div class="hbar" data-tip="${esc(t)}: ${x.passed} of ${x.of} passed"><span class="hbar-label">${esc(t)}</span>
      <span class="hbar-track"><span style="width:${p}%"></span></span><span class="hbar-val">${x.passed}/${x.of}</span></div>`;
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
  const pv = run.prompt_versions ? Object.entries(run.prompt_versions).map(([n, ver]) => `${n} v${ver}${run.trying?.[n] ? "*" : ""}`).join(" · ") : `fingerprint ${run.prompts}`;
  body.innerHTML = `
    <p><a class="btn-link" href="#evals">← Evals</a></p>
    <div class="h-kpis">
      ${tile(`${s.pass_rate}%`, "cases passed", `${s.passed} of ${s.cases}`)}
      ${tile(pctTxt(s.routing), "right agents", `${s.routing.passed}/${s.routing.of}`)}
      ${tile(pctTxt(s.tools), "right tools", `${s.tools.passed}/${s.tools.of}`)}
      ${tile(pctTxt(s.judge), "judge passed", `avg ${s.judge_avg_score ?? "–"}/5`)}
      ${tile(ms(s.p50_ms), "typical time", `p95 ${ms(s.p95_ms)}${s.first_word_p50_ms ? ` · first word ${ms(s.first_word_p50_ms)}` : ""}`)}
      ${tile(tok(s.avg_tokens), "tokens per case", `${s.avg_llm_calls} LLM calls`)}
      ${tile(usd(s.avg_cost), "cost per case", `run ${usd(s.total_cost)} + judge ${usd(s.judge_cost)}`)}
    </div>
    <div class="h-grid">
      <section class="h-card"><h4>Pass rate by tag</h4>${tagRows}</section>
      <section class="h-card"><h4>Run</h4><p>${esc(run.label)} · ${new Date(run.started_at).toLocaleString()}</p>
        <p class="muted">model ${esc(run.model)}</p>
        <p class="muted small">prompts: ${esc(pv)}${run.trying && Object.keys(run.trying).length ? " (* tried, not live)" : ""}</p>
        ${hasDetails ? "" : `<p class="muted">Answers and tool details were deleted after the 7-day retention; the scores are kept.</p>`}</section>
    </div>
    <section class="h-card"><h4>Cases <span class="muted">(failures first - click a row for the answer and checks)</span></h4>
      <table class="usage ev-cases-t"><tr><th></th><th>case</th><th>failed checks</th><th>judge</th><th>time</th><th>tokens</th><th>cost</th></tr>${rows}</table>
    </section>`;
  body.querySelectorAll("tr[data-case]").forEach((tr) => (tr.onclick = () => {
    const det = body.querySelector(`tr[data-for="${CSS.escape(tr.dataset.case)}"]`);
    if (det) det.hidden = !det.hidden;
  }));
}

async function compare(v, a, b) {
  const [ra, rb] = await Promise.all([a, b].map((id) => api(`/api/harness/evals/${encodeURIComponent(id)}`)));
  if (stale(v)) return;
  const [older, newer] = new Date(ra.started_at) < new Date(rb.started_at) ? [ra, rb] : [rb, ra];
  const so = older.summary, sn = newer.summary;
  // lower is better for time, tokens and cost; higher is better for the rates
  const line = (label, o, n, fmtv, lowerBetter) => {
    const delta = n != null && o != null ? n - o : null;
    const better = delta == null || delta === 0 ? "" : (delta < 0) === lowerBetter ? "up" : "down";
    const arrow = delta == null || delta === 0 ? "=" : delta > 0 ? "▲" : "▼";
    return `<tr><td>${label}</td><td>${fmtv(o)}</td><td>${fmtv(n)}</td><td class="${better}">${arrow} ${delta == null ? "" : fmtv(Math.abs(delta))}</td></tr>`;
  };
  const p = (x) => (x == null ? "–" : `${x}%`);
  const caseMap = (r) => Object.fromEntries(r.cases.map((c) => [c.case_id, c]));
  const co = caseMap(older), cn = caseMap(newer);
  const fixed = Object.keys(cn).filter((k) => co[k] && !co[k].passed && cn[k].passed);
  const broke = Object.keys(cn).filter((k) => co[k] && co[k].passed && !cn[k].passed);
  const both = Object.keys(cn).filter((k) => co[k]).length;
  const po = older.prompt_versions || {}, pn = newer.prompt_versions || {};
  const changed = [...new Set([...Object.keys(po), ...Object.keys(pn)])].filter((n) => po[n] !== pn[n]);
  sub(`compare · ${older.label} → ${newer.label}`);
  body.innerHTML = `
    <p><a class="btn-link" href="#evals">← Evals</a></p>
    <div class="h-grid">
      <section class="h-card"><h4>${esc(older.label)} → ${esc(newer.label)}</h4>
        <table class="usage"><tr><th>metric</th><th>before</th><th>after</th><th>change</th></tr>
          ${line("Cases passed", so.pass_rate, sn.pass_rate, p, false)}
          ${line("Right agents", so.routing.rate, sn.routing.rate, p, false)}
          ${line("Right tools", so.tools.rate, sn.tools.rate, p, false)}
          ${line("Judge passed", so.judge.rate, sn.judge.rate, p, false)}
          ${line("Typical time (p50)", so.p50_ms, sn.p50_ms, ms, true)}
          ${line("Slow time (p95)", so.p95_ms, sn.p95_ms, ms, true)}
          ${line("First word (p50)", so.first_word_p50_ms, sn.first_word_p50_ms, ms, true)}
          ${line("Tokens per case", so.avg_tokens, sn.avg_tokens, tok, true)}
          ${line("LLM calls per case", so.avg_llm_calls, sn.avg_llm_calls, (x) => (x == null ? "–" : String(Math.round(x * 100) / 100)), true)}
          ${line("Cost per case", so.avg_cost, sn.avg_cost, usd, true)}
        </table>
        ${so.cases !== sn.cases ? `<p class="muted small">The runs have different case sets (${so.cases} vs ${sn.cases}); compare rates, not counts.</p>` : ""}</section>
      <section class="h-card"><h4>What changed</h4>
        <p><b>Prompts:</b> ${older.prompt_versions && newer.prompt_versions ? (changed.map((n) => `${esc(n)} v${po[n] ?? "–"} → v${pn[n] ?? "–"}`).join(", ") || "same versions")
          : Object.keys(newer.trying || {}).length ? `tried ${versionsText(null, newer.trying)}` : older.prompts === newer.prompts ? "same prompt files" : "prompt files changed"}</p>
        <p><b class="up">Fixed (${fixed.length}):</b> ${fixed.map(esc).join(", ") || "none"}</p>
        <p><b class="down">Newly failing (${broke.length}):</b> ${broke.map(esc).join(", ") || "none"}</p>
        <p class="muted small">${both} cases in both runs. LLM answers vary a little between runs, so one case flipping is not always a real change - re-run it on its own to check.</p></section>
    </div>`;
}

// ---------------------------------------------------------------- prompts

async function prompts(v) {
  const [list, { runs }] = await Promise.all([api("/api/harness/prompts"), api("/api/harness/evals")]);
  if (stale(v)) return;
  sub(`${list.length} prompts`);
  const total = list.filter((p) => p.name !== "synthesizer" && p.name !== "planner").reduce((a, p) => a + p.tokens, 0);
  body.innerHTML = `
    <section class="h-card">
      <h4>Prompts <span class="muted">every save is a new version; the live one is what the agents use</span></h4>
      <table class="usage pr-list"><tr><th>prompt</th><th>live</th><th>versions</th><th title="Tokens of this prompt, sent on every call of that agent">tokens</th><th>last eval with this version</th><th>changed</th></tr>
        ${list.map((p) => {
          const r = lastEvalWith(runs, p.name, p.active);
          return `<tr class="clickable" data-prompt="${esc(p.name)}"><td><b>${esc(p.name)}</b><small>${p.name === "planner" ? "picks the agents" : p.name === "synthesizer" ? "writes the final answer" : "agent"}</small></td>
          <td>${p.active ? `v${p.active}` : "file"}</td><td>${p.versions}</td><td>${tok(p.tokens)}</td>
          <td>${r ? `${r.summary.pass_rate}% <small>${esc(r.label)}</small>` : "–"}</td><td>${p.updated_at ? ago(p.updated_at) : "–"}</td></tr>`;
        }).join("")}
      </table>
      <p class="muted small">Agent prompts total ${tok(total)} tokens. Tool descriptions are sent too and are usually bigger - see the agent nodes on the map.</p>
    </section>
    <section class="h-card"><h4>How to change a prompt safely</h4>
      <ol class="steps">
        <li>Open a prompt, edit it (or click <b>Improve with AI</b> to draft a fix from the last eval failures).</li>
        <li><b>Save as new version</b>. Nothing changes for your chats yet.</li>
        <li><b>Test in evals</b> runs the test set with that version on a separate copy of the agents.</li>
        <li>If it scores better, <b>Make live</b>. Any old version can be made live again in one click.</li>
      </ol></section>`;
  body.querySelectorAll("tr[data-prompt]").forEach((tr) => (tr.onclick = () => (location.hash = `prompt/${tr.dataset.prompt}`)));
}

function lastEvalWith(runs, name, version) {
  return runs.find((r) => r.status === "done" && r.prompt_versions && r.prompt_versions[name] === version);
}

// Line diff (longest common subsequence) - prompts are short, so the simple O(n·m) table is fine.
function diffLines(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  const n = x.length, m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push([" ", x[i]]); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) out.push(["-", x[i++]]);
    else out.push(["+", y[j++]]);
  }
  while (i < n) out.push(["-", x[i++]]);
  while (j < m) out.push(["+", y[j++]]);
  return out;
}

function diffHtml(a, b) {
  const d = diffLines(a, b);
  if (!d.some(([k]) => k !== " ")) return `<p class="muted">Same as the live version.</p>`;
  const add = d.filter(([k]) => k === "+").length, del = d.filter(([k]) => k === "-").length;
  // Show changed lines with 2 lines of context; fold longer unchanged stretches.
  const near = d.map((_, i) => d.slice(Math.max(0, i - 2), i + 3).some(([k]) => k !== " "));
  const out = [];
  for (let i = 0; i < d.length; i++) {
    if (near[i]) { const [k, line] = d[i]; out.push(`<span class="d${k === "+" ? "a" : k === "-" ? "d" : "s"}">${k} ${esc(line) || " "}</span>`); continue; }
    let j = i; while (j < d.length && !near[j]) j++;
    out.push(`<span class="dfold">··· ${j - i} unchanged line${j - i > 1 ? "s" : ""}</span>`);
    i = j - 1;
  }
  return `<p class="muted small"><span class="up">+${add}</span> / <span class="down">−${del}</span> lines vs the live version</p>
    <pre class="diff">${out.join("")}</pre>`;
}

async function promptPage(v, name) {
  const [h, { runs }] = await Promise.all([api(`/api/harness/prompts/${encodeURIComponent(name)}`), api("/api/harness/evals")]);
  if (stale(v)) return;
  const live = h.versions.find((x) => x.version === h.active) || h.versions[0];
  const liveText = live?.text || "";
  sub(`prompt · ${name} · live v${h.active ?? "–"}`);
  const verRow = (x) => {
    const r = lastEvalWith(runs, name, x.version);
    return `<li class="ver${x.version === h.active ? " live" : ""}">
      <div><b>v${x.version}</b> ${x.version === h.active ? `<span class="badge done">live</span>` : ""}
        <small>${esc(x.note || "")} · ${x.source === "file" ? "from file" : "UI"} · ${new Date(x.created_at).toLocaleString()} · ${tok(x.tokens)} tok${r ? ` · eval ${r.summary.pass_rate}% (${esc(r.label)})` : ""}</small></div>
      <div class="ver-actions">
        <button type="button" class="mini" data-load="${x.version}">Open</button>
        ${x.version !== h.active ? `<button type="button" class="mini" data-test="${x.version}">Test in evals</button>
        <button type="button" class="mini live-btn" data-live="${x.version}">Make live</button>` : ""}
      </div></li>`;
  };
  body.innerHTML = `
    <p><a class="btn-link" href="#prompts">← Prompts</a></p>
    <div class="pr-grid">
      <section class="h-card">
        <h4>Edit ${esc(name)} <span class="muted" id="pr-base">showing live v${h.active ?? "–"}</span></h4>
        ${h.placeholders.length ? `<p class="muted small">Keep ${h.placeholders.map(esc).join(", ")} in the text - the app fills it in.</p>` : ""}
        <textarea id="pr-text" spellcheck="false">${esc(liveText)}</textarea>
        <div class="pr-actions">
          <input id="pr-note" placeholder="What changed? (shown in the history)" autocomplete="off">
          <button type="button" id="pr-save">Save as new version</button>
        </div>
        <div class="pr-improve">
          <input id="pr-instr" placeholder="Optional: tell the AI what to change" autocomplete="off">
          <button type="button" id="pr-ai">Improve with AI</button>
        </div>
        <div id="pr-msg"></div>
        <h4 class="pr-diff-h">Changes</h4>
        <div id="pr-diff"><p class="muted">Same as the live version.</p></div>
      </section>
      <section class="h-card">
        <h4>Versions <span class="muted">newest first</span></h4>
        <ul class="versions">${h.versions.map(verRow).join("")}</ul>
      </section>
    </div>`;

  const text = $("pr-text");
  const msg = (html, cls = "") => ($("pr-msg").innerHTML = html ? `<div class="pr-note ${cls}">${html}</div>` : "");
  let t;
  text.oninput = () => { clearTimeout(t); t = setTimeout(() => ($("pr-diff").innerHTML = diffHtml(liveText, text.value.trim())), 200); };

  $("pr-save").onclick = async () => {
    try {
      const { version } = await post(`/api/harness/prompts/${encodeURIComponent(name)}`, { text: text.value, note: $("pr-note").value.trim() });
      msg(`Saved as <b>v${version}</b>. Next: <b>Test in evals</b>, then <b>Make live</b> if it scores better.`, "ok");
      setTimeout(go, 900);
    } catch (e) { if (!(e instanceof LoggedOut)) msg(esc(e.message), "bad"); }
  };

  $("pr-ai").onclick = async () => {
    const b = $("pr-ai");
    b.disabled = true; b.textContent = "Thinking…";
    try {
      const s = await post(`/api/harness/prompts/${encodeURIComponent(name)}/improve`, { instructions: $("pr-instr").value });
      text.value = s.text;
      text.oninput();
      $("pr-note").value = s.cases.length ? `AI fix for ${s.cases.join(", ")}` : "AI suggestion";
      msg(`<b>Suggestion</b>${s.run ? ` from failures in “${esc(s.run)}”` : ""}${s.cases.length ? ` (${s.cases.map(esc).join(", ")})` : ""} · ${usd(s.cost)}
        <div class="pr-summary">${esc(s.summary).replace(/\n/g, "<br>")}</div>
        <span class="muted">Not saved yet - check the changes below, then <b>Save as new version</b>.</span>`, "ok");
    } catch (e) { if (!(e instanceof LoggedOut)) msg(esc(e.message), "bad"); }
    b.disabled = false; b.textContent = "Improve with AI";
  };

  body.querySelectorAll("[data-load]").forEach((b) => (b.onclick = () => {
    const x = h.versions.find((y) => y.version === Number(b.dataset.load));
    text.value = x.text;
    text.oninput();
    $("pr-base").textContent = `showing v${x.version}${x.version === h.active ? " (live)" : ""}`;
    text.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  body.querySelectorAll("[data-live]").forEach((b) => (b.onclick = async () => {
    const ver = Number(b.dataset.live);
    if (!confirm(`Make ${name} v${ver} live? Your chats use it from the next question. You can switch back any time.`)) return;
    try { await post(`/api/harness/prompts/${encodeURIComponent(name)}/activate`, { version: ver }); go(); }
    catch (e) { if (!(e instanceof LoggedOut)) msg(esc(e.message), "bad"); }
  }));
  body.querySelectorAll("[data-test]").forEach((b) => (b.onclick = () => {
    trying = { ...trying, [name]: Number(b.dataset.test) };
    // An agent's prompt is tested on its own cases; the planner and synthesizer affect every case.
    const tag = ["planner", "synthesizer"].includes(name) ? "" : name;
    location.hash = tag ? `evals/${tag}` : "evals";
  }));
}

// ---------------------------------------------------------------- personal memory (MemDream)

let memQuery = "";
const ACTION_LABEL = { ADD: "added", SUPERSEDE: "replaced an old fact", MERGE: "merged", NOOP: "already known",
  MANUAL_ADD: "added by hand", FORGET: "forgotten", EXPIRE: "expired", SYNTHESIS: "pattern found" };

async function memoryPage(v) {
  const d = await api(`/api/harness/memory?q=${encodeURIComponent(memQuery)}`);
  if (stale(v)) return;
  if (!d.enabled) {
    body.innerHTML = `<section class="h-card"><h4>Personal memory</h4><p class="down">MemDream is not running: ${esc(d.error || "starting")}</p></section>`;
    return;
  }
  const c = d.stats.counts || {};
  const t = d.stats.tokens?.totals || {};
  sub(`${c.active || 0} memories`);
  const row = (m) => `<tr data-mem="${esc(m.id)}">
      <td>${esc(m.content)}${m.superseded_by ? `<small>replaced by a newer fact</small>` : ""}</td>
      <td>${esc(m.type)}</td><td class="${m.status === "active" ? "" : "muted"}">${esc(m.status)}</td>
      <td>${m.created_at ? ago(m.created_at) : "–"}</td>
      <td class="mem-actions"><button type="button" class="mini" data-hist="${esc(m.id)}">History</button>
        ${m.status === "active" ? `<button type="button" class="mini" data-forget="${esc(m.id)}">Forget</button>` : ""}</td></tr>
    <tr class="case-detail" data-histfor="${esc(m.id)}" hidden><td colspan="5"></td></tr>`;
  body.innerHTML = `
    <div class="h-kpis">
      ${tile(c.active || 0, "memories in use")}
      ${tile(c.superseded || 0, "replaced", "kept for history")}
      ${tile(c.merged || 0, "merged")}
      ${tile(c.expired || 0, "forgotten")}
      ${tile(usd(t.estimatedCost || 0), "memory LLM cost", `${tok(t.totalTokens || 0)} tokens`)}
    </div>
    <section class="h-card">
      <h4>Personal memory <span class="muted">MemDream · only personal details: ${d.types.map(esc).join(", ")}</span></h4>
      <form id="mem-search" class="ev-form"><input id="mem-q" placeholder="Search memories, e.g. sister's email" value="${esc(memQuery)}" autocomplete="off">
        <button type="submit">Search</button>${memQuery ? `<button type="button" id="mem-clear">Show all</button>` : ""}</form>
      ${d.memories.length ? `<table class="usage mem-t"><tr><th>memory</th><th>type</th><th>status</th><th>saved</th><th></th></tr>${d.memories.map(row).join("")}</table>`
        : `<p class="muted">${memQuery ? "Nothing matches." : "No memories yet. Save one from a “Remember this?” card in the chat, or tell the assistant “remember that …”."}</p>`}
      <p class="muted small">Before every question, the memories that fit it are given to the planner (see “memories” on a trace's planner step).
        Saving always needs your click; Forget is reversible (the memory stays in History).</p>
    </section>
    <section class="h-card"><h4>Recent decisions <span class="muted">what MemDream did with each fact, and why</span></h4>
      ${d.audit.length ? `<table class="usage mem-t"><tr><th>when</th><th>decision</th><th>fact</th><th>why</th></tr>
        ${d.audit.map((a) => `<tr><td>${ago(a.timestamp)}</td><td>${esc(ACTION_LABEL[a.action] || a.action)}</td><td>${esc(a.inputContent || "")}</td><td>${esc(a.reason || "")}</td></tr>`).join("")}</table>`
        : `<p class="muted">No decisions yet.</p>`}
    </section>`;
  $("mem-search").onsubmit = (e) => { e.preventDefault(); memQuery = $("mem-q").value.trim(); go(); };
  if ($("mem-clear")) $("mem-clear").onclick = () => { memQuery = ""; go(); };
  body.querySelectorAll("[data-hist]").forEach((b) => (b.onclick = async () => {
    const cell = body.querySelector(`tr[data-histfor="${CSS.escape(b.dataset.hist)}"]`);
    if (!cell.hidden) { cell.hidden = true; return; }
    const chain = await api(`/api/harness/memory/${encodeURIComponent(b.dataset.hist)}/history`);
    cell.firstElementChild.innerHTML = `<ol class="mem-chain">${chain.map((m) => `<li><b>${esc(m.status)}</b> ${esc(m.content)} <small class="muted">${m.created_at ? new Date(m.created_at).toLocaleString() : ""}</small></li>`).join("")}</ol>`;
    cell.hidden = false;
  }));
  body.querySelectorAll("[data-forget]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Forget this memory? The assistant stops using it. It stays in the history, so this can be undone later.")) return;
    await post(`/api/harness/memory/${encodeURIComponent(b.dataset.forget)}/forget`, {});
    go();
  }));
}

// ---------------------------------------------------------------- tooltip

function hideTip() { $("tip").hidden = true; }
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest?.("[data-tip]");
  const tip = $("tip");
  if (!t) return hideTip();
  tip.innerHTML = t.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});

go();
connect();
