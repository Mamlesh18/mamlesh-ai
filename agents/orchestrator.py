"""The Orchestrator (the "OS"). A LangGraph graph with 3 steps:

    planner  ->  domain (one per step, all run in parallel)  ->  synthesize

Every step reports what it is doing through services.events.emit(), which drives the live UI.
"""
import operator
import time
from datetime import datetime, timezone
from typing import Annotated, TypedDict

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send
from pydantic import BaseModel, Field

from agents.domain_agents import DOMAINS
from harness.sandbox import SANDBOX
from harness.tracing import end_span, start_span
from prompts import load_prompt
from services.events import emit
from utils.cost import count_tokens, llm_cost
from utils.env import OPENAI_MODEL


class Step(BaseModel):
    domain: str = Field(description="Name of the domain agent")
    task: str = Field(description="A clear, self-contained task for that agent")


class Plan(BaseModel):
    steps: list[Step] = Field(default_factory=list)


class State(TypedDict, total=False):
    query: str
    history: str  # earlier turns of this chat ("" for a new chat)
    steps: list[dict]
    results: Annotated[list[dict], operator.add]  # parallel agents append here
    answer: str


class AgentEvents(AsyncCallbackHandler):
    """Sends tool.start / tool.end / tool.error events, and a usage event (tokens + cost) for every LLM call.

    usage is the run's shared totals dict: {agent: {"calls", "input_tokens", "cached_tokens", "output_tokens", "cost"}}
    """

    def __init__(self, run_id: str, domain: str, owner: dict, usage: dict, trace: list | None = None, parent: str | None = None):
        self.run_id, self.domain, self.owner, self.usage = run_id, domain, owner, usage
        self.trace, self.parent = trace, parent  # spans go into the query's trace, under the given parent span
        self.calls = {}      # langchain run id -> (tool name, start time)
        self.spans = {}      # langchain run id -> open span (LLM call or tool call)

    async def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        self.spans[run_id] = start_span(self.trace, "llm", f"{self.domain} · LLM call", self.parent,
                                        agent=self.domain, model=OPENAI_MODEL, messages=sum(len(m) for m in messages))

    async def on_llm_error(self, error, *, run_id, **kwargs):
        if run_id in self.spans:
            end_span(self.spans.pop(run_id), status="error", error=str(error))

    async def on_llm_end(self, response, *, run_id, **kwargs):
        span = self.spans.pop(run_id, None)
        span_usage = {"input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "cost": 0.0}
        for generations in response.generations:
            for g in generations:
                u = getattr(getattr(g, "message", None), "usage_metadata", None)
                if not u:
                    continue
                inp, out = u.get("input_tokens", 0), u.get("output_tokens", 0)
                cached = (u.get("input_token_details") or {}).get("cache_read", 0) or 0
                cost = llm_cost(OPENAI_MODEL, inp, cached, out)
                total = self.usage.setdefault(self.domain, {"calls": 0, "input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "cost": 0.0})
                total["calls"] += 1
                total["input_tokens"] += inp
                total["cached_tokens"] += cached
                total["output_tokens"] += out
                total["cost"] += cost
                for k, v in (("input_tokens", inp), ("cached_tokens", cached), ("output_tokens", out), ("cost", cost)):
                    span_usage[k] += v
                await emit(self.run_id, "usage", agent=self.domain, input_tokens=inp, cached_tokens=cached,
                           output_tokens=out, cost=cost, agent_total=dict(total))
        if span:
            end_span(span, **span_usage)

    def _info(self, tool: str) -> dict:
        return {"domain": self.domain, "server": f"{self.domain}/{self.owner.get(tool, 'unknown')}", "tool": tool}

    async def on_tool_start(self, serialized, input_str, *, run_id, inputs=None, **kwargs):
        tool = serialized.get("name", "tool")
        self.calls[run_id] = (tool, time.perf_counter())
        info = self._info(tool)
        self.spans[run_id] = start_span(self.trace, "tool", f"{info['server']} · {tool}", self.parent,
                                        agent=self.domain, server=info["server"], tool=tool)
        await emit(self.run_id, "tool.start", **info, args=inputs or input_str)

    async def on_tool_end(self, output, *, run_id, **kwargs):
        tool, started = self.calls.pop(run_id, ("tool", time.perf_counter()))
        text = getattr(output, "content", output)
        if isinstance(text, list):  # MCP tools return content blocks; keep just the text
            text = "\n".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in text)
        if run_id in self.spans:
            extra = {"result_preview": str(text)[:8000]} if SANDBOX.get() else {}  # evals only: evidence for the judge
            end_span(self.spans.pop(run_id), result_chars=len(str(text)), **extra)
        await emit(self.run_id, "tool.end", **self._info(tool),
                   result=str(text)[:2000], duration_ms=int((time.perf_counter() - started) * 1000))

    async def on_tool_error(self, error, *, run_id, **kwargs):
        tool, started = self.calls.pop(run_id, ("tool", time.perf_counter()))
        if run_id in self.spans:
            end_span(self.spans.pop(run_id), status="error", error=str(error))
        await emit(self.run_id, "tool.error", **self._info(tool),
                   error=str(error), duration_ms=int((time.perf_counter() - started) * 1000))


def build_orchestrator(agents: dict, tool_owner: dict):
    """Returns (graph, context) where context is the orchestrator's own prompt sizes in tokens."""
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0, stream_usage=True)
    domain_list = "\n".join(
        f"- {name}: {desc} | tools: {', '.join(tool_owner[name]) or 'none yet'}"
        for name, desc in DOMAINS.items()
    )
    planner_prompt = load_prompt("planner").replace("{domains}", domain_list)
    synth_prompt = load_prompt("synthesizer")
    context = {"planner_prompt_tokens": count_tokens(planner_prompt), "synthesizer_prompt_tokens": count_tokens(synth_prompt)}

    def events(config: RunnableConfig, agent: str, parent: str | None = None) -> dict:
        c = config["configurable"]
        return {"callbacks": [AgentEvents(c["run_id"], agent, tool_owner.get(agent, {}), c["usage"],
                                          c.get("trace"), parent or c.get("root_span"))]}

    def span(config: RunnableConfig, kind: str, name: str, **attrs) -> dict:
        c = config["configurable"]
        return start_span(c.get("trace"), kind, name, c.get("root_span"), **attrs)

    async def planner(state: State, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        s = span(config, "planner", "planner")
        await emit(run_id, "node.start", node="orchestrator")
        request = state["query"]
        if state.get("history"):
            request = f"Conversation so far:\n{state['history']}\n\nNew request: {request}"
        try:
            plan = await llm.with_structured_output(Plan).ainvoke(
                [("system", planner_prompt), ("user", request)], config=events(config, "orchestrator", s["_id"])
            )
        except Exception as e:
            end_span(s, status="error", error=str(e))
            raise
        steps = [st.model_dump() for st in plan.steps if st.domain in agents]
        end_span(s, steps=[st["domain"] for st in steps], history_chars=len(state.get("history", "")))
        await emit(run_id, "plan", steps=steps)
        return {"steps": steps}

    def dispatch(state: State):
        if not state.get("steps"):
            return "synthesize"
        return [Send("domain", {"query": state["query"], **step}) for step in state["steps"]]

    async def domain(step: dict, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        name, task = step["domain"], step["task"]
        s = span(config, "agent", f"{name} agent", agent=name, task=task[:300])
        await emit(run_id, "domain.start", domain=name, task=task)
        try:
            now = datetime.now().strftime("%A, %Y-%m-%d %H:%M")
            out = await agents[name].ainvoke(
                {"messages": [("user", f"(Current date and time: {now})\n\n{task}")]},
                config={**events(config, name, s["_id"]), "recursion_limit": 25, "configurable": {"run_id": run_id}},
            )
            result, status = out["messages"][-1].content, "done"
            end_span(s, messages=len(out["messages"]))
        except Exception as e:
            result, status = f"Failed: {e}", "error"
            end_span(s, status="error", error=str(e))
        await emit(run_id, "domain.end", domain=name, status=status, result=result)
        return {"results": [{"domain": name, "task": task, "result": result}]}

    async def synthesize(state: State, config: RunnableConfig):
        run_id = config["configurable"]["run_id"]
        results = "\n\n".join(
            f"[{r['domain']}] task: {r['task']}\nresult: {r['result']}" for r in state.get("results", [])
        ) or "(no agent results)"
        earlier = f"Conversation so far:\n{state['history']}\n\n" if state.get("history") else ""
        messages = [("system", synth_prompt), ("user", f"{earlier}User request: {state['query']}\n\nAgent results:\n{results}")]
        s = span(config, "synthesizer", "synthesizer", results_chars=len(results))
        answer, first = "", None
        try:
            async for chunk in llm.astream(messages, config=events(config, "orchestrator", s["_id"])):
                if chunk.content:
                    if first is None:  # time to first word: how long you wait before the answer starts
                        first = int((datetime.now(timezone.utc) - s["start"]).total_seconds() * 1000)
                    answer += chunk.content
                    await emit(run_id, "token", text=chunk.content)
        except Exception as e:
            end_span(s, status="error", error=str(e))
            raise
        end_span(s, ttft_ms=first, answer_chars=len(answer))
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
    return graph.compile(), context
