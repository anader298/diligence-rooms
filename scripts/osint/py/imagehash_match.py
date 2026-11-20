"""Headshot-to-avatar matching with a multi-crop perceptual hash search.

stdin:  {"reference": "<url or path>", "candidates": [{"id": "...", "url": "<url or path>"}, ...],
         "user_agent": "...", "timeout": 8}
stdout: {"reference": {"ok": true, "w": 400, "h": 500},
         "results": [{"id": "...", "phash": 4, "dhash": 7, "crop": [scale, dx, dy], "error": null}, ...]}
        or {"missing": ["imagehash", "PIL"]} with exit code 3.

Method (docs: diligence-rooms-osint-integration.md section 3.4): platforms crop avatars to a square
or a circle, so a plain pHash misses them. The reference headshot is hashed at 9 scales (1.0 to
0.5) x 25 offsets, each crop matched to the candidate's aspect ratio, and the minimum distance is
kept. dHash is logged alongside for the benchmark. No face embeddings, ever.

Uses imagehash (BSD-2-Clause) and Pillow (MIT-CMU) as installed libraries; nothing is vendored.
"""
import io
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

missing = []
try:
    import imagehash  # noqa: F401
except ImportError:
    missing.append("imagehash")
try:
    from PIL import Image  # noqa: F401
except ImportError:
    missing.append("PIL")
if missing:
    print(json.dumps({"missing": missing}))
    sys.exit(3)

import imagehash  # noqa: E402
from PIL import Image  # noqa: E402

SCALES = [1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.65, 0.6, 0.5]
OFFSETS = [i / 4 for i in range(5)]  # 0, .25, .5, .75, 1 of the free room, both axes: 25 offsets


def load(src, ua, timeout):
    if src.startswith("http://") or src.startswith("https://"):
        req = urllib.request.Request(src, headers={"User-Agent": ua, "Accept": "image/*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read(8_000_000)
        img = Image.open(io.BytesIO(data))
    else:
        img = Image.open(src)
    img.load()
    return img.convert("RGB")


def crops(img, aspect):
    """Crops of img with the candidate's aspect ratio (w/h), at each scale and offset."""
    w, h = img.size
    if w / h > aspect:
        base_h, base_w = h, h * aspect
    else:
        base_w, base_h = w, w / aspect
    seen = set()
    for s in SCALES:
        cw, ch = base_w * s, base_h * s
        for ox in OFFSETS:
            for oy in OFFSETS:
                x0 = round((w - cw) * ox)
                y0 = round((h - ch) * oy)
                box = (x0, y0, round(x0 + cw), round(y0 + ch))
                if box in seen or box[2] - box[0] < 16 or box[3] - box[1] < 16:
                    continue
                seen.add(box)
                yield (s, ox, oy), img.crop(box)


def main():
    req = json.loads(sys.stdin.read() or "{}")
    ua = req.get("user_agent") or "Mozilla/5.0"
    timeout = float(req.get("timeout") or 8)
    try:
        ref = load(req["reference"], ua, timeout)
    except Exception as e:  # unreadable reference: nothing to compare
        print(json.dumps({"reference": {"ok": False, "error": str(e)[:200]}, "results": []}))
        return
    cands = req.get("candidates", [])[:40]

    def fetch(c):
        try:
            return load(c["url"], ua, timeout), None
        except Exception as e:
            return None, str(e)[:200]

    # downloads in parallel (I/O bound); hashing stays in this thread
    with ThreadPoolExecutor(max_workers=12) as ex:
        loaded = list(ex.map(fetch, cands))
    cache = {}
    results = []
    for c, (cand, err) in zip(cands, loaded):
        out = {"id": c.get("id"), "url": c.get("url"), "phash": None, "dhash": None, "crop": None, "error": err}
        if cand is None:
            results.append(out)
            continue
        try:
            cw, ch = cand.size
            aspect = round(cw / ch, 2) if ch else 1.0
            cp = imagehash.phash(cand)
            cd = imagehash.dhash(cand)
            if aspect not in cache:
                cache[aspect] = [(k, imagehash.phash(im), imagehash.dhash(im)) for k, im in crops(ref, aspect)]
            best = None
            for k, rp, rd in cache[aspect]:
                d = rp - cp
                if best is None or d < best[0]:
                    best = (d, rd - cd, k)
            if best:
                out["phash"], out["dhash"], out["crop"] = int(best[0]), int(best[1]), list(best[2])
        except Exception as e:
            out["error"] = str(e)[:200]
        results.append(out)
    w, h = ref.size
    print(json.dumps({"reference": {"ok": True, "w": w, "h": h}, "results": results}))


if __name__ == "__main__":
    main()
