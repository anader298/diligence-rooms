"""Main-text extraction for article pages with trafilatura.

stdin:  {"docs": [{"url": "...", "html": "<html>..."}, ...]}
stdout: {"results": [{"url": "...", "title": ..., "author": ..., "date": ..., "sitename": ...,
                      "text": "...", "error": null}, ...]}
        or {"missing": ["trafilatura"]} with exit code 3.

The pages are fetched by the Node runner (its cache, per-host spacing and time budget); this
sidecar only parses. trafilatura (Apache-2.0) is used as an installed library, not vendored.
"""
import json
import sys

try:
    import trafilatura
except ImportError:
    print(json.dumps({"missing": ["trafilatura"]}))
    sys.exit(3)


def main():
    req = json.loads(sys.stdin.read() or "{}")
    out = []
    for d in req.get("docs", [])[:20]:
        r = {"url": d.get("url"), "title": None, "author": None, "date": None, "sitename": None, "text": None, "error": None}
        try:
            raw = trafilatura.extract(
                d.get("html") or "",
                url=d.get("url"),
                output_format="json",
                with_metadata=True,
                include_comments=False,
                include_tables=False,
                favor_precision=True,
            )
            if raw:
                j = json.loads(raw)
                r.update({k: j.get(k) for k in ("title", "author", "date", "sitename")})
                r["text"] = (j.get("text") or "")[:60000]
            else:
                r["error"] = "no main text found"
        except Exception as e:
            r["error"] = str(e)[:200]
        out.append(r)
    print(json.dumps({"results": out}))


if __name__ == "__main__":
    main()
