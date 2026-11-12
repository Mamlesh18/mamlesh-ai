"""The 7 domain agents. Each one gets:
  - a description  (the Orchestrator reads this to decide who gets a task)
  - a prompt       (prompts/<name>.md)
  - its tools      (its MCP servers from mcp_servers/config.py + custom tools from tools/)
"""
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

from agents.tool_selection import KEEP, MIN_TOOLS, ToolSelector
from harness import guardrails
from prompts import load_prompt
from tools import CUSTOM_TOOLS
from utils.cost import context_size
from utils.env import MEMORY_DIR, OPENAI_MODEL, ROOT_DIR

DOMAINS = {
    "coding": "GitHub (repos, issues, PRs, commits), draw.io diagrams, and files in the mamlesh-ai project folder.",
    "conversation": "Email from Mamlesh's Gmail: write and draft emails (Mamlesh reviews and sends them from the chat), and check which emails were sent.",
    "personal": "Mamlesh's own platform (profile, blogs, papers, talks, students, leads, site analytics, WhatsApp batches), Razorpay payments, and writing/reading daily notes in the memory folder.",
    "general": "Live web search and reading web pages (Tavily), current date/time, and maths.",
    "healthcare": "Mamlesh's personal health log and goals: weight and weight goal, steps, sleep, workouts, meals, water, blood pressure, symptoms, medication. Save new data and report progress.",
    "finance": "Mamlesh's investments: the consolidated portfolio statement (all demat accounts and mutual funds, invested vs current value, monthly value history), the Upstox account (live positions, orders, funds), live stock prices (NSE, BSE, US), and Indian mutual fund NAVs and returns.",
    "brain": "Mamlesh's long-term memory and knowledge base: facts about Mamlesh, saved notes and documents. Search them or save new ones.",
}


# Core tools an agent must always see, even when tool selection hides the rest.
ALWAYS_TOOLS = {
    "personal": {"read_text_file", "write_file", "edit_file", "list_directory"},  # daily notes (memory folder)
    "coding": {"get_me", "get_file_contents", "search_repositories", "list_commits"},
}
SERVER_LABELS = {"memory": "memory: daily notes", "mamlesh_mcp": "Mamlesh's website", "razorpay": "razorpay payments"}


def build_domain_agents(mcp_tools: dict) -> tuple[dict, dict, dict]:
    """Returns (agents, tool_owner, context).

    agents:     {domain: compiled agent}
    tool_owner: {domain: {tool_name: server_name}}  -> tells the UI which node a tool call belongs to
    context:    {domain: {prompt_tokens, tool_tokens, total, tools}}  -> tokens sent on every call
    """
    # streaming=True: when one agent answers on its own, its words reach the chat as they are written
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0, stream_usage=True, streaming=True)
    agents, tool_owner, context = {}, {}, {}

    for domain in DOMAINS:
        tools, owner = [], {}
        for server_name, server in mcp_tools.get(domain, {}).items():
            for t in server["tools"]:
                t.metadata = {**(t.metadata or {}), "server": SERVER_LABELS.get(server_name, server_name)}
                tools.append(t)
                owner[t.name] = server_name
        for t in CUSTOM_TOOLS.get(domain, []):
            tools.append(t)
            owner[t.name] = "custom"
        # approvals for writes, sandbox in evals, secret removal, injection warnings (harness/guardrails.py)
        tools = [guardrails.protect(t, owner[t.name]) for t in tools]

        prompt = load_prompt(domain).replace("{memory_dir}", str(MEMORY_DIR)).replace("{root_dir}", str(ROOT_DIR))
        # Many tools -> show the model only the ones that fit the task (agents/tool_selection.py)
        middleware = [ToolSelector(domain, tools, always=ALWAYS_TOOLS.get(domain, set()))] if len(tools) >= MIN_TOOLS else []
        agents[domain] = create_agent(llm, tools=tools, system_prompt=prompt, middleware=middleware)
        tool_owner[domain] = owner
        context[domain] = context_size(prompt, tools)
        if middleware:  # roughly what is sent per call now: the prompt + about KEEP tools
            c = context[domain]
            c["selected"] = KEEP
            c["total_all_tools"] = c["total"]
            c["total"] = c["prompt_tokens"] + round(c["tool_tokens"] * KEEP / len(tools))

    return agents, tool_owner, context
