"""Finance tools (read-only, free, no API key).

Mutual funds: mfapi.in (official AMFI NAV data for Indian mutual funds)
Stocks:       Yahoo Finance public endpoints (NSE: RELIANCE.NS, BSE: RELIANCE.BO, US: AAPL)
"""
import json
from datetime import datetime

import httpx
from langchain_core.tools import tool

MF_API = "https://api.mfapi.in/mf"
YAHOO = "https://query1.finance.yahoo.com"
HEADERS = {"User-Agent": "Mozilla/5.0"}


async def _get(url: str, **params):
    async with httpx.AsyncClient(timeout=20, headers=HEADERS) as client:
        r = await client.get(url, params=params or None)
        r.raise_for_status()
        return r.json()


def _nav_on_or_before(history: list[dict], days_ago: int):
    """history is newest first: [{"date": "05-11-2026", "nav": "123.4"}, ...]"""
    latest = datetime.strptime(history[0]["date"], "%d-%m-%Y")
    for row in history:
        if (latest - datetime.strptime(row["date"], "%d-%m-%Y")).days >= days_ago:
            return float(row["nav"])
    return None


@tool
async def my_portfolio(section: str = "summary") -> str:
    """Mamlesh's own consolidated portfolio from the latest uploaded CAS statement (CDSL/NSDL/CAMS): demat stocks,
    ETFs, mutual fund folios with invested amount, value and gain, monthly value history and transactions.
    section: 'summary' (totals + allocation), 'mutual_funds', 'stocks' (demat holdings), 'history', 'transactions' or 'all'."""
    from services.statements import get_statement

    s = await get_statement()
    if not s:
        return "No statement uploaded yet. Mamlesh can upload a CAS PDF in the Finance agent panel."
    head = {"statement": f"{s['source']} CAS for {s['period_from']} to {s['period_to']}", "values_as_on": s["period_to"],
            "uploaded_at": s["uploaded_at"]}
    parts = {
        "summary": {"total_value": s["total_value"], "asset_allocation": s["asset_allocation"], "accounts": s["accounts"],
                    "mutual_fund_totals": s["mf_summary"]},
        "mutual_funds": {"folios": s["mf_folios"], "totals": s["mf_summary"]},
        "stocks": {"demat_holdings": s["demat_holdings"]},
        "history": {"monthly_values": s["monthly_values"]},
        "transactions": {"transactions": s["transactions"]},
    }
    body = {k: v for p in parts.values() for k, v in p.items()} if section == "all" else parts.get(section, parts["summary"])
    if s.get("warnings"):
        head["extraction_warnings"] = s["warnings"]
    return json.dumps({**head, **body}, default=str)


@tool
async def mf_search(query: str) -> str:
    """Search Indian mutual funds by name. Returns scheme codes to use with mf_details."""
    results = await _get(f"{MF_API}/search", q=query)
    if not results:
        return "No mutual funds found."
    return "\n".join(f"{r['schemeCode']}: {r['schemeName']}" for r in results[:15])


@tool
async def mf_details(scheme_code: int) -> str:
    """Latest NAV, category and returns (1M, 6M, 1Y, 3Y and 5Y CAGR) for a mutual fund scheme code."""
    data = await _get(f"{MF_API}/{scheme_code}")
    meta, history = data.get("meta", {}), data.get("data", [])
    if not history:
        return "No NAV data for this scheme code."
    nav = float(history[0]["nav"])
    out = {
        "scheme": meta.get("scheme_name"),
        "fund_house": meta.get("fund_house"),
        "category": meta.get("scheme_category"),
        "nav": nav,
        "nav_date": history[0]["date"],
    }
    for label, days, years in [("1M", 30, 0), ("6M", 182, 0), ("1Y", 365, 1), ("3Y", 3 * 365, 3), ("5Y", 5 * 365, 5)]:
        old = _nav_on_or_before(history, days)
        if old:
            change = (nav / old) ** (1 / years) - 1 if years > 1 else nav / old - 1
            out[f"return_{label}{'_cagr' if years > 1 else ''}_%"] = round(change * 100, 2)
    return json.dumps(out)


@tool
async def stock_search(query: str) -> str:
    """Find stock ticker symbols by company name (e.g. 'tata motors'). NSE symbols end in .NS, BSE in .BO."""
    data = await _get(f"{YAHOO.replace('query1', 'query2')}/v1/finance/search", q=query, quotesCount=8, newsCount=0)
    quotes = [q for q in data.get("quotes", []) if q.get("symbol")]
    if not quotes:
        return "No symbols found."
    return "\n".join(f"{q['symbol']} | {q.get('shortname') or q.get('longname', '')} | {q.get('exchDisp', q.get('exchange', ''))}" for q in quotes)


@tool
async def stock_quote(symbol: str, period: str = "1mo") -> str:
    """Current price and recent performance of a stock. symbol like RELIANCE.NS, TCS.BO or AAPL.
    period: 5d, 1mo, 3mo, 6mo, 1y, 5y."""
    data = await _get(f"{YAHOO}/v8/finance/chart/{symbol}", range=period, interval="1d")
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        return f"No data for {symbol}."
    meta = result["meta"]
    closes = [c for c in result["indicators"]["quote"][0].get("close", []) if c is not None]
    price = meta.get("regularMarketPrice")
    out = {
        "symbol": meta.get("symbol"),
        "exchange": meta.get("fullExchangeName"),
        "currency": meta.get("currency"),
        "price": price,
        "day_high": meta.get("regularMarketDayHigh"),
        "day_low": meta.get("regularMarketDayLow"),
        "52w_high": meta.get("fiftyTwoWeekHigh"),
        "52w_low": meta.get("fiftyTwoWeekLow"),
    }
    if closes and price:
        out[f"change_over_{period}_%"] = round((price / closes[0] - 1) * 100, 2)
        out[f"{period}_high"], out[f"{period}_low"] = round(max(closes), 2), round(min(closes), 2)
    return json.dumps(out)
