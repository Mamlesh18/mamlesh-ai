"""Custom (non-MCP) tools, grouped by the domain agent that uses them.

To add a tool: write it with @tool in a file here, then add it to the right domain below.
"""
from tools.brain_tools import kb_add, kb_search
from tools.finance_tools import mf_details, mf_search, my_portfolio, stock_quote, stock_search
from tools.health_tools import (
    delete_health_entry, health_history, health_summary, log_health, log_weight, set_health_goal,
)

CUSTOM_TOOLS = {
    "brain": [kb_search, kb_add],
    "finance": [my_portfolio, mf_search, mf_details, stock_search, stock_quote],
    "healthcare": [log_weight, log_health, set_health_goal, health_summary, health_history, delete_health_entry],
}
