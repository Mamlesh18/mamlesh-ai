# Mamlesh AI OS — Product Requirements Document

**Status:** Draft v0.1 · **Date:** 2026-11-06 · **Owner:** Mamlesh

---

## 1. What we are building

A personal **AI operating system**. You speak or type a query. An **Orchestrator** works out which **domains** it needs. Each domain is a specialist **agent** with its own **MCP servers** and tools. The agents do the work and the Orchestrator writes the final answer.

A web page shows all of this **live**, as a graph:

```
                         ┌──────────────┐
          voice/text ──▶ │ Orchestrator │  (the "OS")
                         └──────┬───────┘
     ┌──────────┬──────────┬────┴─────┬──────────┬──────────┬──────────┐
     ▼          ▼          ▼          ▼          ▼          ▼          ▼
  Coding   Conversation  Personal   General  Healthcare  Finance     Brain
     │          │          │          │          │          │          │
  github     email      mamlesh.mem  misc     health-sys  stocks     FAISS RAG
  drawio     teams      razorpay     MCPs        MCP      mutualfnds  (KB)
  ...        slack
     │
  [tools: create_issue, list_prs, ...]   ← click an MCP node to see its tools + live calls
```

### Goals
1. One entry point (voice or text) for every personal and work task.
2. Domain isolation: each agent loads only its own tools. This keeps prompts small and routing accurate.
3. Adding an MCP server is a config change, not a code change.
4. Full observability: every step, tool call, argument, result, and timing is streamed to the UI and stored.
5. Risky actions (send email, pay, trade, write health data) need explicit human approval.

### Non-goals (v1)
- Text-to-speech or voice replies (STT only).
- Multi-user accounts or SaaS. This is single-user and self-hosted.
- Autonomous background agents and schedules (maybe in v2).
- A mobile app.

---

## 2. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | Python 3.11+ | async throughout |
| API server | FastAPI + Uvicorn | REST + WebSocket |
| Orchestration | LangGraph (≥1.1) | `StateGraph`, subgraphs, `interrupt()`, checkpointer |
| LLM | OpenAI `gpt-4.1-mini` via `langchain-openai` | Every agent uses it. Model name is configurable per agent. |
| MCP client | `langchain-mcp-adapters` (`MultiServerMCPClient`) + `mcp` SDK | stdio and streamable-HTTP transports |
| Database | MongoDB (`motor` async driver) | config, runs, events, conversations, checkpoints |
| Vector store | FAISS (`faiss-cpu`) + OpenAI embeddings (`text-embedding-3-small`) | the Brain domain |
| STT | Deepgram streaming (`nova-3`) | browser → Deepgram directly, using a short-lived token |
| UI | One HTML page + vanilla JS + a graph library from a CDN (Cytoscape.js or vis-network) | no build step |
| Secrets | `.env` (`OPENAI_API_KEY`, `MONGODB_URL`, `DEEPGRAM_API_KEY`) | already present and gitignored |

---

## 3. Core concepts

| Term | Meaning |
|---|---|
| **Orchestrator** | The top-level LangGraph graph. Plans the work, routes to domains, gathers results, writes the answer. |
| **Domain** | A named specialist agent (Coding, Conversation, …). Built as a LangGraph **subgraph**: a ReAct-style agent bound to the tools of its own MCP servers. |
| **MCP server** | An external tool provider (GitHub, Slack, Razorpay, …) attached to exactly one domain. |
| **Tool** | One callable function exposed by an MCP server. |
| **Run** | One user query, from input to final answer. Has a `run_id`. |
| **Event** | One observable thing that happens during a run (node start, tool call, token, …). Streamed to the UI and saved in MongoDB. |

---

## 4. Domains (initial set)

| Domain | Purpose | MCP servers / tools (initial) | Risky actions (need approval) |
|---|---|---|---|
| **Coding** | Repos, issues, PRs, diagrams | GitHub MCP, draw.io MCP, (later: filesystem, Jira) | push, merge, delete, create PR |
| **Conversation** | Communication | Email (Gmail/Outlook), MS Teams, Slack | send, reply, post message |
| **Personal** | Personal memory and payments | `mamlesh.mem` (personal memory), Razorpay | create payment links, refunds, any money movement |
| **General** | Utilities and misc tools | web search, weather, time, calculator, other MCPs | depends on tool, flag in config |
| **Healthcare** | Health records and system | Healthcare system MCP | any write; all reads are logged |
| **Finance** | Investments | Stocks and mutual-fund MCP/tools (quotes, portfolio, NAV) | any order or trade, always approval-gated |
| **Brain** | Long-term knowledge (RAG) | Built-in FAISS retriever (`kb_search`, `kb_ingest`, `kb_list_sources`) | ingest or delete documents |

**Brain is special.** Any other domain, and the Orchestrator, can call it to get context (for example, "use what you know about my project X").

---

## 5. Architecture

### 5.1 Components

```
Browser (index.html)
  ├─ Mic → Deepgram WS (token from /api/stt/token) → transcript
  ├─ POST /api/runs {query}            → run_id
  └─ WS  /ws/runs/{run_id}             ← live events
                │
FastAPI ────────┤
  ├─ Run Manager      : starts graph.astream() as a background task
  ├─ Event Bus        : fan-out to WebSocket subscribers + persist to Mongo
  ├─ MCP Registry     : loads server configs from Mongo, keeps sessions, caches tool lists
  ├─ Domain Factory   : builds one agent subgraph per enabled domain
  └─ Orchestrator     : LangGraph StateGraph (checkpointed in Mongo)
                │
MCP servers (stdio processes / HTTP endpoints)    MongoDB    FAISS index on disk
```

### 5.2 Orchestrator graph

Build a **custom `StateGraph`** rather than using the prebuilt `langgraph-supervisor`. A custom graph gives full control over parallel fan-out, event emission, and approval gates.

```
START → recall_context → planner ─┬─▶ dispatch (Send × N domains, parallel)
                                  │        └─▶ domain_<name> subgraph(s)
                                  │                 └─▶ collect
                                  │                        └─▶ planner (loop if more steps needed, max N iterations)
                                  └─▶ direct_answer (no domain needed)
                                                          └─▶ synthesize → save_memory → END
```

- **recall_context**: optional quick Brain lookup plus recent chat history from Mongo.
- **planner**: `gpt-4.1-mini` with **structured output** returns
  `{"steps": [{"domain": "coding", "task": "...", "depends_on": []}], "needs_domains": bool}`.
  The domain list and each domain's description come from the registry, so new domains route automatically.
- **dispatch**: uses `Send()` to run independent steps in parallel. Dependent steps run in later loop iterations.
- **collect**: merges domain results into state (with a list-append reducer).
- **synthesize**: writes the final answer from all step results.
- **Guards**: max planner iterations (default 4), per-run timeout, per-tool timeout.

### 5.3 Domain agent subgraph

- One per domain, built as a ReAct agent (`create_react_agent` / `create_agent`). It is bound to:
  - the tools of that domain's MCP servers (from `MultiServerMCPClient.get_tools()`), and
  - an optional `ask_brain` tool.
- System prompt per domain is stored in Mongo and editable.
- Returns `{domain, task, result_summary, artifacts, status}` to the Orchestrator.
- Max tool-call iterations per domain run (default 8).

### 5.4 MCP integration

- **Config-driven.** Each server is a Mongo document (see §7) with transport `stdio` or `streamable_http`, a command or URL, env/header references, and a domain.
- **Persistent sessions.** By default the adapter opens a new session for each tool call. For servers that are slow to start (stdio), the registry should open **one long-lived session per server** at startup and reuse it.
- **Tool discovery.** On startup and on `POST /api/mcp/{id}/refresh`, call `list_tools`. Cache name, description, and input schema in Mongo for the UI.
- **Instrumentation wrapper.** Every MCP tool is wrapped so that each call emits `tool.start` and `tool.end`/`tool.error` events (args, result preview, duration, MCP server id, domain). This is what makes the MCP node light up in the UI.
- **Approval gate.** Tools marked `requires_approval` in config call LangGraph `interrupt()` before running. The UI shows Approve/Reject. The run resumes with `Command(resume=...)`.
- **Health.** Each server has a status (`connected` / `error` / `disabled`) shown on its node.

### 5.5 Brain (RAG)

- Ingest: files (PDF, MD, TXT, DOCX), URLs, notes, and optionally finished run summaries. Chunk (~800 tokens, 100 overlap) → embed → FAISS.
- FAISS index saved on disk (`data/faiss/`). Chunk text and metadata (source, domain tag, created_at) saved in Mongo `kb_chunks`, keyed by vector id.
- Tools: `kb_search(query, k, domain_filter?)`, `kb_ingest(source)`, `kb_list_sources()`, `kb_delete(source_id)`.
- Can be exposed as a local MCP server too, so it shows up in the graph like everything else.

### 5.6 Event streaming (backbone of the UI)

- Run graph with `graph.astream(input, config, stream_mode=["updates", "custom", "messages"], subgraphs=True, version="v2")`.
  - `updates` → node started or finished.
  - `custom` → our own events from `get_stream_writer()` (tool calls, plans, approvals).
  - `messages` → LLM tokens (for live typing of the final answer).
  - `subgraphs=True` + `ns` (namespace) → tells us **which domain** emitted the event.
- Every chunk is normalised to the **Event schema** below, written to Mongo `events`, and pushed to WebSocket subscribers of that `run_id`.
- When the UI reconnects, it replays events from Mongo, then continues live.

**Event schema**
```json
{
  "run_id": "r_...", "seq": 42, "ts": "2026-11-06T12:00:00.123Z",
  "type": "run.start | plan.created | node.start | node.end | agent.thinking | tool.start | tool.end | tool.error | approval.required | approval.resolved | token | run.end | run.error",
  "node": {"kind": "orchestrator|domain|mcp|tool", "id": "coding/github/create_issue"},
  "domain": "coding", "mcp_server": "github", "tool": "create_issue",
  "payload": {"args": {}, "result_preview": "...", "duration_ms": 812}
}
```

---

## 6. Web UI requirements

Single page (`static/index.html`) served by FastAPI.

### 6.1 Layout
- **Top bar:** text input, **mic button**, send, run status.
- **Center: live graph canvas.**
  - Level 0: Orchestrator node.
  - Level 1: Domain nodes (always shown; disabled ones greyed).
  - Level 2: MCP server nodes under each domain (shown when you expand a domain, or always, by toggle).
  - Edges animate when data flows (Orchestrator → Domain → MCP).
- **Right panel: details for the selected node.**
  - Domain: current task, reasoning steps, result, timings.
  - **MCP server:** status, **list of tools** (name, description, input schema), and **call history** (time, args, result preview, duration, run link). New calls appear live.
- **Bottom panel:** event timeline/log for the current run, plus the final answer streaming in.

### 6.2 Node states (colours)
`idle` grey · `queued` blue outline · `running` pulsing blue · `waiting_approval` amber · `success` green · `error` red.

### 6.3 Interaction requirements
- Clicking any node opens its details. Clicking a tool row shows the full args and result JSON.
- Approval card for `approval.required` events, with Approve / Reject / Edit-args.
- Run history list (past runs from Mongo). Opening a past run replays its graph.
- MCP admin view: list, add, enable/disable, and refresh servers (v1 can be a simple form).

### 6.4 Voice (Deepgram STT)
- Browser asks `GET /api/stt/token`. The backend uses `DEEPGRAM_API_KEY` to mint a **short-lived Deepgram token** (the main key never reaches the browser).
- Browser opens the Deepgram live WebSocket (`model=nova-3`, `interim_results=true`, `smart_format=true`, `endpointing`) and streams mic audio from `MediaRecorder`.
- Interim transcripts show in the input box. When the final transcript arrives (or the user releases push-to-talk), submit it as the query.
- Modes: push-to-talk (default) and toggle. Optional wake word later.
- `keyterm` prompting with domain words (e.g. "Razorpay", "draw.io", fund names) to improve accuracy.

---

## 7. Data model (MongoDB)

| Collection | Key fields |
|---|---|
| `domains` | `_id` (e.g. `coding`), `name`, `description` (used by the planner), `system_prompt`, `model`, `enabled`, `max_iterations` |
| `mcp_servers` | `_id`, `domain_id`, `name`, `transport` (`stdio`/`streamable_http`), `command`, `args`, `url`, `env_refs`, `headers_refs`, `enabled`, `status`, `last_error` |
| `mcp_tools` | `server_id`, `name`, `description`, `input_schema`, `requires_approval`, `enabled`, `last_seen_at` |
| `runs` | `_id`, `query`, `source` (`voice`/`text`), `status`, `plan`, `final_answer`, `started_at`, `ended_at`, `token_usage`, `cost_estimate` |
| `events` | Event schema (§5.6). Index on `(run_id, seq)`. |
| `tool_calls` | `run_id`, `domain`, `server_id`, `tool`, `args`, `result`, `status`, `duration_ms`, `ts`. Index on `(server_id, ts)` for the MCP history panel. |
| `approvals` | `run_id`, `tool_call_id`, `status`, `decided_at`, `edited_args` |
| `conversations` | thread id, message history for follow-up questions |
| `kb_sources` / `kb_chunks` | Brain metadata. Vectors live in FAISS. |
| `checkpoints` | LangGraph checkpointer (`langgraph-checkpoint-mongodb`), needed for `interrupt`/resume |

Secrets are **never stored in Mongo**. `env_refs` hold variable *names*, which are resolved from `.env` at runtime.

---

## 8. API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/runs` | `{query, source, thread_id?}` → `{run_id}`; starts the run |
| GET | `/api/runs` / `/api/runs/{id}` | history / details |
| GET | `/api/runs/{id}/events` | replay events |
| WS | `/ws/runs/{id}` | live events for one run |
| WS | `/ws/live` | all events (dashboard view) |
| POST | `/api/runs/{id}/approvals/{approval_id}` | `{decision, edited_args?}`; resumes the graph |
| GET | `/api/domains` | domains + their MCP servers (to build the graph) |
| GET | `/api/mcp/servers` · POST · PATCH · DELETE | manage MCP servers |
| POST | `/api/mcp/servers/{id}/refresh` | reconnect and re-list tools |
| GET | `/api/mcp/servers/{id}/tools` | tool list |
| GET | `/api/mcp/servers/{id}/calls` | call history (paged) |
| GET | `/api/stt/token` | short-lived Deepgram token |
| POST | `/api/brain/ingest` · GET `/api/brain/search` | knowledge base |
| GET | `/api/health` | app, Mongo, and each MCP server status |

---

## 9. Proposed project structure

```
mamlesh-ai/
├─ app/
│  ├─ main.py                # FastAPI app, lifespan (Mongo, MCP registry, graph)
│  ├─ config.py              # settings from .env
│  ├─ api/                   # runs.py, mcp.py, stt.py, brain.py, ws.py
│  ├─ orchestrator/
│  │  ├─ state.py            # OrchestratorState (TypedDict + reducers)
│  │  ├─ graph.py            # build_orchestrator()
│  │  ├─ planner.py          # structured-output planner
│  │  └─ synthesize.py
│  ├─ domains/
│  │  ├─ factory.py          # build_domain_agent(domain_cfg, tools)
│  │  └─ prompts/            # default system prompts per domain
│  ├─ mcp/
│  │  ├─ registry.py         # load configs, sessions, tool cache, health
│  │  └─ instrument.py       # tool wrapper → events + approval interrupt
│  ├─ brain/                 # faiss_store.py, ingest.py, tools.py
│  ├─ events/                # bus.py (pub/sub + Mongo persist), schema.py
│  └─ db/                    # mongo.py, repositories
├─ mcp_servers/              # local/custom MCP servers (brain, mamlesh.mem, finance…)
├─ static/                   # index.html, app.js, styles.css
├─ data/faiss/               # index files (gitignored)
├─ scripts/seed_domains.py   # seeds domains + MCP configs
├─ tests/
├─ docs/PRD.md
├─ pyproject.toml
└─ .env
```

---

## 10. Non-functional requirements

- **Latency:** first event on the UI under 500 ms after submit. Planner decision under ~2 s.
- **Reliability:** a failing MCP server must not crash the run. The domain reports the error and the Orchestrator continues with the other domains.
- **Security and privacy:**
  - Keys only in `.env`. Deepgram key never reaches the browser.
  - Bind to `localhost` by default. If exposed, add simple auth (API key or basic auth).
  - Healthcare and Finance tool args/results can be redacted in stored events (config flag per domain).
  - Prompt-injection hygiene: tool outputs (emails, web pages) are treated as data. Risky tools always need approval, whatever the model "decides".
- **Cost tracking:** record token usage per run and per agent.
- **Observability:** optional LangSmith tracing via env flag, in addition to our own event log.

---

## 11. Delivery phases

| Phase | Scope | Done when |
|---|---|---|
| **P0 — Skeleton** | FastAPI, Mongo, `.env` config, `/api/health`, static page served | page loads, health is green |
| **P1 — One domain, end to end** | Orchestrator (planner + 1 domain) + GitHub MCP + event bus + WebSocket + basic graph UI | a query → GitHub tool call shows live on the GitHub MCP node |
| **P2 — All domains + registry** | Config-driven domains and MCP servers, tool panel, call history, parallel dispatch | multi-domain query fans out in parallel and is visible in the UI |
| **P3 — Brain** | FAISS ingest/search, Brain domain, `ask_brain` tool for other agents | "what did I note about X" answers from the KB |
| **P4 — Approvals** | `interrupt()` gates, Mongo checkpointer, approval UI | sending an email pauses for Approve |
| **P5 — Voice** | Deepgram token endpoint, mic streaming, interim transcripts | spoken query runs end to end |
| **P6 — Polish** | run history and replay, MCP admin form, cost display, redaction | — |

---

## 12. Open questions (need your input)

1. **mamlesh.mem**: is this your own MCP server or app? Where does it run, and what does it store, compared with Brain?
2. **Email / Teams / Slack**: which providers and accounts? Are there existing MCP servers for them, or do we write thin ones?
3. **Healthcare system MCP**: does it already exist? Which system, and what data sensitivity?
4. **Finance**: which broker/data source (e.g. Zerodha Kite, Groww, AMFI NAV feed)? Read-only in v1?
5. **MCP hosting**: will the servers run locally as stdio processes, or remotely over HTTP?
6. **Brain sources**: what goes into the KB first (folders, Notion, Drive, past runs)?
7. **Follow-up turns**: should the OS keep chat context across queries (threads), or treat each query as fresh?
8. **Deployment**: only on your laptop, or on a server you reach from your phone?
