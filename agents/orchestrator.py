"""The Orchestrator (the "OS"). A LangGraph graph with 3 steps:

    planner  ->  domain (one per step, all run in parallel)  ->  synthesize

Every step reports what it is doing through services.events.emit(), which drives the live UI.
"""
import operator
import time
from datetime import datetime
from typing import Annotated, TypedDict

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from pydantic import BaseModel, Field

from agents.domain_agents import DOMAINS
from prompts import load_prompt
from services.events import emit
from utils.env import OPENAI_MODEL


class Step(BaseModel):
    domain: str = Field(description="Name of the domain agent")
    task: str = Field(description="A clear, self-contained task for that agent")


class Plan(BaseModel):
    steps: list[Step] = Field(default_factory=list)


class State(TypedDict, total=False):
    query: str
    steps: list[dict]
    results: Annotated[list[dict], operator.add]  # parallel agents append here
    answer: str


class ToolEvents(AsyncCallbackHandler):
    """Sends tool.start / tool.end / tool.error events while a domain agent runs."""

    def __init__(self, run_id: str, domain: str, owner: dict):
        self.run_id, self.domain, self.owner = run_id, domain, owner
        self.calls = {}  # langchain run id -> (tool name, start time)

    def _info(self, tool: str) -> dict:
        return {"domain": self.domain, "server": f"{self.domain}/{self.owner.get(tool, 'unknown')}", "tool": tool}

    async def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        tool = serialized.get("name", "tool")
        self.calls[run_id] = (tool, time.perf_counter())
        await emit(self.run_id, "tool.start", **self._info(tool), args=inputs or input_str)

    async def on_tool_end(self, output, *, run_id, **kwargs):
        tool, started = self.calls.pop(run_id, ("tool", time.perf_counter()))
        text = getattr(output, "content", output)
        if isinstance(text, list):  # MCP tools return content blocks; keep just the text
            text = "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in text)
        await emit(self.run_id, "tool.end", **self._info(tool),
                   result=str(text)[:2000], duration_ms=int((time.perf_counter() - started) * 1000))

    async def on_tool_error(self, error, *, run_id, **kwargs):
        tool, started = self.calls.pop(run_id, ("tool", time.perf_counter()))
        await emit(self.run_id, "tool.error", **self._info(tool),
                   error=str(error), duration_ms=int((time.perf_counter() - started) * 1000))


def build_orchestrator(agents: dict, tool_owner: dict):
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0)
    domain_list = "\n".join(
        f"- {name}: {desc} | tools: {', '.join(tool_owner[name]) or 'none yet'}"
        for name, desc in DOMAINS.items()
    )
    planner_prompt = load_prompt("planner").replace("{domains}", domain_list)
    synth_prompt = load_prompt("synthesizer")

    async def planner(state: State, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        await emit(run_id, "node.start", node="orchestrator")
        plan = await llm.with_structured_output(Plan).ainvoke(
            [("system", planner_prompt), ("user", state["query"])]
        )
        steps = [s.model_dump() for s in plan.steps if s.domain in agents]
        await emit(run_id, "plan", steps=steps)
        return {"steps": steps}

    def dispatch(state: State):
        if not state.get("steps"):
            return "synthesize"
        return [Send("domain", {"query": state["query"], **step}) for step in state["steps"]]

    async def domain(step: dict, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        name, task = step["domain"], step["task"]
        await emit(run_id, "domain.start", domain=name, task=task)
        try:
            now = datetime.now().strftime("%A, %Y-%m-%d %H:%M")
            out = await agents[name].ainvoke(
                {"messages": [("user", f"(Current date and time: {now})\n\n{task}")]},
                config={"callbacks": [ToolEvents(run_id, name, tool_owner[name])], "recursion_limit": 25},
            )
            result, status = out["messages"][-1].content, "done"
        except Exception as e:
            result, status = f"Failed: {e}", "error"
        await emit(run_id, "domain.end", domain=name, status=status, result=result)
        return {"results": [{"domain": name, "task": task, "result": result}]}

    async def synthesize(state: State, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        results = "\n\n".join(
            f"[{r['domain']}] task: {r['task']}\nresult: {r['result']}" for r in state.get("results", [])
        ) or "(no agent results)"
        messages = [("system", synth_prompt), ("user", f"User request: {state['query']}\n\nAgent results:\n{results}")]
        answer = ""
        async for chunk in llm.astream(messages):
            if chunk.content:
                answer += chunk.content
                await emit(run_id, "token", text=chunk.content)
        await emit(run_id, "node.end", node="orchestrator")
        return {"answer": answer}

    graph = StateGraph(State)
    graph.add_node("planner", planner)
    graph.add_node("domain", domain)
    graph.add_node("synthesize", synthesize)
    graph.add_edge(START, "planner")
    graph.add_conditional_edges("planner", dispatch, ["domain", "synthesize"])
    graph.add_edge("domain", "synthesize")
    graph.add_edge("synthesize", END)
    return graph.compile()
