"""The 7 domain agents. Each one gets:
  - a description  (the Orchestrator reads this to decide who gets a task)
  - a prompt       (prompts/<name>.md)
  - its tools      (its MCP servers from mcp_servers/config.py + custom tools from tools/)
"""
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

from prompts import load_prompt
from tools import CUSTOM_TOOLS
from utils.cost import context_size
from utils.env import MEMORY_DIR, OPENAI_MODEL, ROOT_DIR

DOMAINS = {
    "coding": "GitHub (repos, issues, PRs, commits), draw.io diagrams, and files in the mamlesh-ai project folder.",
    "conversation": "Email, Microsoft Teams and Slack: read, search, summarise and draft messages.",
    "personal": "Mamlesh's own platform (profile, blogs, papers, talks, students, leads, site analytics, WhatsApp batches), Razorpay payments, and writing/reading daily notes in the memory folder.",
    "general": "Live web search and reading web pages (Tavily), current date/time, and maths.",
    "healthcare": "The healthcare system: health records, appointments and related data.",
    "finance": "Live stock prices (NSE, BSE, US) and Indian mutual fund NAVs and returns.",
    "brain": "Mamlesh's long-term memory and knowledge base: facts about Mamlesh, saved notes and documents. Search them or save new ones.",
}


def build_domain_agents(mcp_tools: dict) -> tuple[dict, dict, dict]:
    """Returns (agents, tool_owner, context).

    agents:     {domain: compiled agent}
    tool_owner: {domain: {tool_name: server_name}}  -> tells the UI which node a tool call belongs to
    context:    {domain: {prompt_tokens, tool_tokens, total, tools}}  -> tokens sent on every call
    """
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0, stream_usage=True)
    agents, tool_owner, context = {}, {}, {}

    for domain in DOMAINS:
        tools, owner = [], {}
        for server_name, server in mcp_tools.get(domain, {}).items():
            for t in server["tools"]:
                tools.append(t)
                owner[t.name] = server_name
        for t in CUSTOM_TOOLS.get(domain, []):
            tools.append(t)
            owner[t.name] = "custom"

        prompt = load_prompt(domain).replace("{memory_dir}", str(MEMORY_DIR)).replace("{root_dir}", str(ROOT_DIR))
        agents[domain] = create_agent(llm, tools=tools, system_prompt=prompt)
        tool_owner[domain] = owner
        context[domain] = context_size(prompt, tools)

    return agents, tool_owner, context
