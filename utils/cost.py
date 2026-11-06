"""Token counting and cost. Prices are USD per 1 million tokens (OpenAI list prices, update if they change)."""
import json

import tiktoken
from langchain_core.utils.function_calling import convert_to_openai_tool

PRICES = {
    "gpt-4.1": {"input": 2.00, "cached": 0.50, "output": 8.00},
    "gpt-4.1-mini": {"input": 0.40, "cached": 0.10, "output": 1.60},
    "gpt-4.1-nano": {"input": 0.10, "cached": 0.025, "output": 0.40},
}

_encoding = tiktoken.get_encoding("o200k_base")  # the tokenizer used by gpt-4.1 models


def llm_cost(model: str, input_tokens: int, cached_tokens: int, output_tokens: int) -> float:
    p = PRICES.get(model, PRICES["gpt-4.1-mini"])
    fresh = input_tokens - cached_tokens
    return (fresh * p["input"] + cached_tokens * p["cached"] + output_tokens * p["output"]) / 1_000_000


def count_tokens(text: str) -> int:
    return len(_encoding.encode(text))


def context_size(system_prompt: str, tools: list) -> dict:
    """How many tokens an agent sends on EVERY call before any conversation: its prompt + all tool definitions."""
    tool_tokens = sum(count_tokens(json.dumps(convert_to_openai_tool(t))) for t in tools)
    prompt_tokens = count_tokens(system_prompt)
    return {"prompt_tokens": prompt_tokens, "tool_tokens": tool_tokens, "total": prompt_tokens + tool_tokens, "tools": len(tools)}
