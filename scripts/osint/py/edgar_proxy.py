"""Executive pay from the latest proxy statement (DEF 14A), read by edgartools.

stdin:  {"cik": 789019 | null, "ticker": "MSFT" | null, "identity": "Name email@example.com"}
stdout: {"filing": {...}, "pvp": {...}, "sct": [...], "pay_ratio": {...}, "directors": [...],
         "audit_fees": {...}, "owners": [...], "proposals": [...]}
        or {"missing": ["edgar"]} with exit code 3, or {"error": "..."}.

edgartools (MIT) is used as an installed, pinned library (scripts/osint/py/requirements.txt); its
DEF 14A table parsing is the reason this is a sidecar and not Node. SEC fair access: edgartools
sends the identity given here as its User-Agent and stays under 10 requests a second.
"""
import json
import math
import sys

try:
    import edgar  # noqa: F401
except ImportError:
    print(json.dumps({"missing": ["edgar"]}))
    sys.exit(3)

from edgar import Company, set_identity  # noqa: E402


def num(v):
    try:
        if v is None:
            return None
        f = float(v)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def records(df, cols=None, limit=60):
    try:
        if df is None or len(df) == 0:
            return []
        rows = df.head(limit).to_dict(orient="records")
    except Exception:
        return []
    out = []
    for r in rows:
        clean = {}
        for k, v in r.items():
            if cols and k not in cols:
                continue
            if isinstance(v, float) and math.isnan(v):
                v = None
            elif hasattr(v, "item"):
                v = v.item()
            elif v is not None and not isinstance(v, (int, float, str, bool)):
                v = str(v)
            clean[k] = v
        out.append(clean)
    return out


def safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def main():
    req = json.loads(sys.stdin.read() or "{}")
    set_identity(req.get("identity") or "diligence-rooms research contact@example.com")
    key = req.get("cik") or req.get("ticker")
    if not key:
        print(json.dumps({"error": "no CIK or ticker"}))
        return
    try:
        filings = Company(key).get_filings(form="DEF 14A")
        f = filings.latest() if filings is not None and len(filings) else None
    except Exception as e:
        print(json.dumps({"error": f"filing lookup: {str(e)[:200]}"}))
        return
    if f is None:
        print(json.dumps({"filing": None}))
        return
    p = f.obj()
    ratio = safe(lambda: p.ceo_pay_ratio)
    fees = safe(lambda: p.audit_fees)
    out = {
        "filing": {"form": f.form, "date": str(f.filing_date), "accession": f.accession_no, "url": safe(lambda: f.document.url) or safe(lambda: f.homepage_url), "company": safe(lambda: p.company_name)},
        "pvp": {
            "peo_name": safe(lambda: p.peo_name),
            "peo_total_comp": num(safe(lambda: p.peo_total_comp)),
            "peo_actually_paid_comp": num(safe(lambda: p.peo_actually_paid_comp)),
            "neo_avg_total_comp": num(safe(lambda: p.neo_avg_total_comp)),
            "neo_avg_actually_paid_comp": num(safe(lambda: p.neo_avg_actually_paid_comp)),
            "tsr": num(safe(lambda: p.total_shareholder_return)),
            "peer_tsr": num(safe(lambda: p.peer_group_tsr)),
            "net_income": num(safe(lambda: p.net_income)),
            "selected_measure": safe(lambda: p.company_selected_measure),
            "selected_measure_value": num(safe(lambda: p.company_selected_measure_value)),
            "measures": safe(lambda: list(p.performance_measures), []),
            "fiscal_year_end": safe(lambda: p.fiscal_year_end),
        },
        "sct": records(safe(lambda: p.summary_compensation_table)),
        "pay_ratio": {"ceo": num(getattr(ratio, "ceo_compensation", None)), "median": num(getattr(ratio, "median_employee_compensation", None)), "ratio": num(getattr(ratio, "ratio", None))} if ratio else None,
        "directors": records(safe(lambda: p.director_compensation_table), limit=30),
        "audit_fees": {k: num(v) if not isinstance(v, str) else v for k, v in vars(fees).items()} if fees is not None and hasattr(fees, "__dict__") else None,
        "owners": records(safe(lambda: p.beneficial_ownership), limit=40),
        "proposals": [str(getattr(v, "description", v))[:200] for v in (safe(lambda: p.voting_proposals, []) or [])][:15],
    }
    print(json.dumps(out, default=str))


if __name__ == "__main__":
    main()
