# Mamlesh AI OS

A personal AI operating system. An **Orchestrator** (LangGraph) sends your request to **domain agents**
(Coding, Conversation, Personal, General, Healthcare, Finance, Brain). Each agent uses its own **MCP servers**
and tools. A web page shows every agent and tool call live, and you can talk to it with your voice (Deepgram).

## Run it

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
python main.py
```

Open http://127.0.0.1:8000

`.env` needs `OPENAI_API_KEY`, `MONGODB_URL`, `DEEPGRAM_API_KEY`.
Optional (each switches on its MCP server): `GITHUB_ACCESS_TOKEN`, `RAZORPAY_API_KEY` + `RAZORPAY_API_SECRET`,
`MCP_API_KEY`, `TAVILY_API_KEY`. Node.js is needed for the filesystem MCP server.

## Folders

| Folder | What goes in it |
|---|---|
| `main.py` | Starts the app |
| `agents/` | `domain_agents.py` sets up each domain agent. `orchestrator.py` is the LangGraph graph (plan → agents in parallel → answer) |
| `prompts/` | One `.md` prompt per agent, plus the planner and synthesizer prompts |
| `tools/` | Custom Python tools (e.g. the Brain FAISS tools) |
| `mcp_servers/` | `config.py` lists the MCP servers for each domain (stdio or HTTP). `servers/` holds our own MCP servers |
| `api/` | HTTP and WebSocket endpoints |
| `services/` | The logic behind the endpoints: running queries, live events, MongoDB, Deepgram |
| `ui/` | The web page (HTML + JS + CSS) |
| `utils/` | Logging and environment variables |
| `kb/` | Knowledge files for the Brain agent (`.md`/`.txt`). Indexed into FAISS automatically when they change |
| `memory/` | Daily notes (`YYYY-MM-DD.md`) written by the Personal agent. Also searchable by Brain |
| `data/` | The FAISS index built from `kb/` and `memory/` |

## Add an MCP server

Add it to the right domain in `mcp_servers/config.py` and restart:

```python
"finance": {
    "stocks": {"transport": "stdio", "command": "python", "args": ["path/to/stocks_server.py"]},
    # or a server that is already running:
    "funds": {"transport": "streamable_http", "url": "http://localhost:8200/mcp"},
},
```

It shows up as a new node under its domain on the page.

## Add a custom tool

Write a function with `@tool` in `tools/`, then add it to `CUSTOM_TOOLS` in `tools/__init__.py`.

## How it works

1. The **planner** reads your request and splits it into steps, one domain per step.
2. Each step runs on its domain agent, **in parallel**. Agents call their MCP and custom tools.
3. The **synthesizer** combines the results and streams the answer.
4. Every step is sent to the page over the `/ws` WebSocket and saved in MongoDB (`events`, `runs`).
5. Voice: the page streams mic audio to `/ws/stt`, the server forwards it to Deepgram, and the transcript is sent as your query.
