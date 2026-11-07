"""Consolidated Account Statement (CAS) import: PDF -> key facts -> MongoDB.

Works with CDSL / NSDL / CAMS / KFintech consolidated statements (demat holdings + mutual fund folios).
Each upload REPLACES the stored statement (MongoDB collection "finance", document "cas").

Privacy: the PDF itself is never stored. PAN, email, phone and address are removed from the text
before it is sent to the LLM for extraction, and are not saved.

Import a PDF from the command line:
    python -m services.statements import cams/Mutual-Funds.pdf [password]
"""
import io
import re
from datetime import datetime, timezone

from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field
from pypdf import PdfReader

from services import db as database
from utils.env import OPENAI_MODEL
from utils.logger import get_logger

log = get_logger(__name__)


# ---------- what we extract ----------

class Allocation(BaseModel):
    asset_class: str
    value: float
    percent: float


class MonthValue(BaseModel):
    month: str = Field(description="YYYY-MM")
    value: float


class Account(BaseModel):
    type: str = Field(description="e.g. 'CDSL Demat', 'NSDL Demat', 'Mutual Fund Folios'")
    name: str = Field(description="Broker / depository participant name, or 'Mutual Fund Folios'")
    holdings_count: int
    value: float


class DematHolding(BaseModel):
    isin: str
    name: str = Field(description="The security name exactly as printed, in full (all its lines joined), "
                                  "e.g. 'HDFC AMC LTD#HDFC MF-HDFC NIFTY 50 INDEX FUND-DIRECT-GROWTH'")
    kind: str = Field(description="'equity', 'etf' or 'mutual_fund'")
    quantity: float
    price: float
    value: float
    broker: str = Field(description="Depository participant holding it, e.g. 'Upstox'")


class MFFolio(BaseModel):
    scheme: str = Field(description="Scheme name without the leading scheme code")
    amc: str
    isin: str
    folio: str
    plan: str = Field(description="'regular' or 'direct'")
    units: float
    nav: float
    invested: float = Field(description="Cumulative amount invested")
    value: float = Field(description="Current valuation")
    gain: float = Field(description="Unrealised profit/loss in rupees")
    gain_percent: float
    expense_ratio: float | None = None


class Transaction(BaseModel):
    date: str = Field(description="YYYY-MM-DD")
    name: str = Field(description="Scheme or security")
    description: str = Field(description="e.g. 'SIP Purchase', 'Purchase', 'Redemption'")
    amount: float
    units: float | None = None
    nav: float | None = None


class CASStatement(BaseModel):
    source: str = Field(description="Who issued it, e.g. 'CDSL', 'NSDL', 'CAMS', 'KFintech'")
    period_from: str = Field(description="YYYY-MM-DD")
    period_to: str = Field(description="YYYY-MM-DD")
    total_value: float = Field(description="Total portfolio value across everything")
    asset_allocation: list[Allocation]
    monthly_values: list[MonthValue] = Field(description="Month-by-month portfolio valuation history, oldest first")
    accounts: list[Account] = Field(description="Every demat account and the MF folios line from the summary, including zero-value ones")
    demat_holdings: list[DematHolding] = Field(description="Every security in the demat holding statements")
    mf_folios: list[MFFolio] = Field(description="Every mutual fund scheme in the 'units held' table")
    transactions: list[Transaction] = Field(description="Transactions during the statement period")


# ---------- PDF -> clean text ----------

def pdf_text(data: bytes, password: str = "") -> str:
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted and not reader.decrypt(password or ""):
        raise ValueError("This PDF is password protected. Enter its password (for CAS it is usually your PAN).")
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def clean(text: str) -> str:
    """Remove Hindi duplicates, repeated page headers, boilerplate pages and personal identifiers."""
    for marker in ("NOTES TO CAS", "Load Structures", "ABOUT CDSL", "About NSDL"):
        text = text.split(marker)[0] if marker in text and text.index(marker) > len(text) * 0.5 else text
    text = re.sub(r"[^\x00-\x7F₹]+", " ", text)                                # Devanagari etc.
    text = re.sub(r"\b[A-Z]{5}\d{4}[A-Z]\b", "<PAN>", text)                     # PAN
    text = re.sub(r"[\w.+-]+@[\w-]+\.[\w.]+", "<EMAIL>", text)                  # email
    text = re.sub(r"(Mobile No\s*:?\s*)\S+", r"\1<PHONE>", text)                 # phone
    text = re.sub(r"PINCODE\s*:?\s*\d{6}", "PINCODE: <PIN>", text)
    skip = ("Central Depository Services", "A Wing, 25th Floor", "Lower Parel", "CONSOLIDATED ACCOUNT STATEMENT",
            "FORM AND INVESTMENTS", "Summary of", "Investments      Account", "Account Details CDSL", "CDSL DEMAT",
            "NSDL Demat", "NSDL DEMAT", "MF DetailsMF", "(CAS)", "NPS")
    lines = [ln.strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln and len(ln) > 1 and not ln.startswith(skip)]
    return "\n".join(_drop_addresses(lines))


def _drop_addresses(lines: list[str]) -> list[str]:
    """Remove postal address blocks: a line with a 6-digit pincode, the lines above it back to the
    investor's name line (or up to 8 lines), and a trailing 'STATE / INDIA' line."""
    pincode = re.compile(r"(?<![\d.,/])\d{6}(?![\d.,])")
    drop = set()
    for i, ln in enumerate(lines):
        if pincode.search(ln) and not re.search(r"\d\.\d", ln) and "CIN" not in ln and "Mumbai" not in ln:
            drop.add(i)
            j = i - 1
            while j >= 0 and i - j <= 8 and not lines[j].startswith((".", "CAS ID", "Statement")) and "PAN" not in lines[j]:
                drop.add(j)
                j -= 1
            for k in (i + 1, i + 2):  # e.g. "TAMIL NADU INDIA"
                if k < len(lines) and re.fullmatch(r"[A-Z .]+", lines[k]) and len(lines[k]) < 40:
                    drop.add(k)
    return [ln for i, ln in enumerate(lines) if i not in drop]


# ---------- extract + check + save ----------

PROMPT = """Extract the key facts from this Indian consolidated account statement (CAS) into the schema.
- Numbers use Indian formatting (1,14,019.45 = 114019.45). Return plain numbers.
- Include EVERY demat holding and EVERY mutual fund folio row; do not skip small ones.
- Use the statement's own values; do not calculate or invent any. Use null when a value is not shown.
- Dates as YYYY-MM-DD, months as YYYY-MM.
- transactions: every dated row in every "STATEMENT OF TRANSACTIONS" section (SIP purchase, purchase,
  redemption, switch, dividend...). Skip "Opening Balance" / "Closing Balance" rows.
  Columns are: Date | Description | Amount | NAV | Price | Units | Stamp duty. The description often ends with a
  long order/reference number (8+ digits, e.g. "Online 1234567890"): that is part of the description, NOT the amount.
  Example: "SIP Purchase ... Online 1234567890 2500.0 125.5 125.5 19.92 .13" -> amount 2500.0, nav 125.5, units 19.92.
- demat_holdings kind: 'etf' when the name says ETF or BeES, 'mutual_fund' for other fund units, else 'equity'."""


def _short_name(name: str) -> str:
    """'HDFC AMC LTD#HDFC MF-HDFC NIFTY 50 INDEX FUND-DIRECT-GROWTH' -> 'HDFC NIFTY 50 INDEX FUND-DIRECT-GROWTH'"""
    original = name
    parts = [p.strip() for p in name.split("#") if p.strip()]
    # After '#' comes either the real fund name, or just a share description ("NEW EQUITY SHARES FACE VALUE...")
    name = parts[0] if len(parts) > 1 and re.match(r"(?:NEW\s+)?EQUITY SHARES", parts[-1], re.I) else parts[-1]
    # "NIPPON LIFE INDIA AM LTD NIPPON INDIA ETF GOLD BEES" -> "NIPPON INDIA ETF GOLD BEES" (AMC prefix without '#')
    name = re.sub(r"^.*?\b(?:AMC?|ASSET MANAGEMENT(?: CO(?:MPANY)?)?)\s+(?:PVT\.?\s+)?(?:LTD|LIMITED)\.?\s+(?=\S)", "", name, flags=re.I)
    name = re.sub(r"^[A-Z0-9 &.]+ MF-\s*", "", name)
    name = re.sub(r"[\s\-]*(?:NEW\s+)?EQUITY SHARES.*$", "", name, flags=re.I)
    name = re.sub(r"\s+LIMITED$", "", name, flags=re.I)
    return name.strip(" -") or original


def check(s: CASStatement) -> list[str]:
    """Compare the extracted rows with the statement's own totals, to catch extraction mistakes."""
    warnings = []
    def close(a, b):
        return abs(a - b) <= max(2.0, abs(b) * 0.005)
    mf_total = sum(f.value for f in s.mf_folios)
    mf_account = sum(a.value for a in s.accounts if "fund" in a.type.lower() and "demat" not in a.type.lower())
    if mf_account and not close(mf_total, mf_account):
        warnings.append(f"MF folios add up to {mf_total:,.2f} but the summary says {mf_account:,.2f}")
    demat_total = sum(h.value for h in s.demat_holdings)
    demat_account = sum(a.value for a in s.accounts if "demat" in a.type.lower())
    if demat_account and not close(demat_total, demat_account):
        warnings.append(f"Demat holdings add up to {demat_total:,.2f} but the summary says {demat_account:,.2f}")
    if not close(mf_total + demat_total, s.total_value):
        warnings.append(f"Holdings add up to {mf_total + demat_total:,.2f} but the total is {s.total_value:,.2f}")
    # A huge gain usually means the statement's "amount invested" for that folio is incomplete
    # (older purchases or switch-ins not counted), not a real return.
    for f in s.mf_folios:
        if f.gain_percent and f.gain_percent > 200:
            warnings.append(f"{f.scheme[:40]}: {f.gain_percent:,.0f}% gain is based on the statement's invested amount "
                            f"({f.invested:,.0f}), which is probably incomplete - treat this return as unreliable")
    # A transaction's amount must be about units x NAV (plus a little stamp duty). If not, trust units x NAV.
    for t in s.transactions:
        if t.units and t.nav:
            expected = abs(t.units * t.nav)
            if expected and abs(abs(t.amount) - expected) > expected * 0.03:
                warnings.append(f"Transaction {t.date} {t.name[:30]}: amount {t.amount:,.2f} looked wrong, "
                                f"corrected to units x NAV = {expected:,.2f}")
                t.amount = round(expected, 2)
    return warnings


async def import_statement(data: bytes, filename: str, password: str = "") -> dict:
    text = clean(pdf_text(data, password))
    if "ISIN" not in text:
        raise ValueError("This doesn't look like a consolidated account statement (no ISINs found).")
    llm = ChatOpenAI(model=OPENAI_MODEL, temperature=0)
    statement: CASStatement = await llm.with_structured_output(CASStatement).ainvoke(
        [("system", PROMPT), ("user", text)])

    for h in statement.demat_holdings:
        h.name = _short_name(h.name)
    warnings = check(statement)  # also corrects transaction amounts, so run it before saving
    doc = statement.model_dump()
    invested = sum(f.invested for f in statement.mf_folios)
    mf_value = sum(f.value for f in statement.mf_folios)
    doc.update({
        "_id": "cas",
        "file": filename,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "warnings": warnings,
        "mf_summary": {"invested": round(invested, 2), "value": round(mf_value, 2),
                       "gain": round(mf_value - invested, 2),
                       "gain_percent": round((mf_value / invested - 1) * 100, 2) if invested else None},
    })
    if database.db is not None:
        await database.db.finance.replace_one({"_id": "cas"}, doc, upsert=True)  # replaces the old statement
    log.info("CAS imported: %s, total %.2f, %d MF folios, %d demat holdings, warnings: %s", filename,
             statement.total_value, len(statement.mf_folios), len(statement.demat_holdings), doc["warnings"] or "none")
    return doc


async def get_statement() -> dict | None:
    if database.db is None:
        return None
    return await database.db.finance.find_one({"_id": "cas"})


if __name__ == "__main__":
    import asyncio
    import sys
    from pathlib import Path

    async def _main(path: str, password: str):
        await database.connect()
        doc = await import_statement(Path(path).read_bytes(), Path(path).name, password)
        print(f"Imported {path}: total {doc['total_value']:,.2f} | {len(doc['mf_folios'])} MF folios | "
              f"{len(doc['demat_holdings'])} demat holdings | warnings: {doc['warnings'] or 'none'}")

    if len(sys.argv) >= 3 and sys.argv[1] == "import":
        asyncio.run(_main(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ""))
    else:
        print(__doc__)
