"""Transcripts for talks and interviews.

stdin:  {"videos": [{"id": "<youtube video id>"}], "audio": [{"url": "<mp3/m4a url>"}],
         "whisper": false, "whisper_model": "base.en", "max_audio_seconds": 3600, "user_agent": "..."}
stdout: {"videos": [{"id": ..., "language": ..., "generated": bool, "segments": [[start, text], ...], "error": null}],
         "audio": [{"url": ..., "segments": [...], "error": null}]}
        or {"missing": [...]} with exit code 3.

YouTube captions come from youtube-transcript-api (MIT); audio is transcribed only with
"whisper": true (the --transcribe flag), by faster-whisper (MIT) on CPU (int8). Both are
installed libraries, not vendored. Whisper output is a lead: quotes are re-checked against the
audio timestamp before use.
"""
import json
import os
import sys
import tempfile
import urllib.request

req = json.loads(sys.stdin.read() or "{}")
want_whisper = bool(req.get("whisper")) and bool(req.get("audio"))
missing = []
try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    if req.get("videos"):
        missing.append("youtube_transcript_api")
if want_whisper:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        missing.append("faster_whisper")
if missing:
    print(json.dumps({"missing": missing}))
    sys.exit(3)


def captions(video_id):
    r = {"id": video_id, "language": None, "generated": None, "segments": [], "error": None}
    try:
        api = YouTubeTranscriptApi()
        if hasattr(api, "fetch"):  # 1.x
            t = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
            r["language"] = getattr(t, "language_code", None)
            r["generated"] = getattr(t, "is_generated", None)
            r["segments"] = [[round(s.start, 1), s.text] for s in t]
        else:  # 0.6.x
            t = YouTubeTranscriptApi.get_transcript(video_id, languages=["en", "en-US", "en-GB"])
            r["segments"] = [[round(s["start"], 1), s["text"]] for s in t]
    except Exception as e:
        r["error"] = (type(e).__name__ + ": " + str(e).strip().split("\n")[0])[:240]
    return r


def whisper(items):
    out = []
    model = WhisperModel(req.get("whisper_model") or "base.en", device="cpu", compute_type="int8")
    limit = float(req.get("max_audio_seconds") or 3600)
    for a in items[:2]:
        r = {"url": a.get("url"), "segments": [], "error": None}
        path = None
        try:
            q = urllib.request.Request(a["url"], headers={"User-Agent": req.get("user_agent") or "Mozilla/5.0"})
            fd, path = tempfile.mkstemp(suffix=".audio")
            with urllib.request.urlopen(q, timeout=60) as resp, os.fdopen(fd, "wb") as f:
                f.write(resp.read(400_000_000))
            segs, _info = model.transcribe(path, vad_filter=True, beam_size=1)
            for s in segs:
                if s.start > limit:
                    break
                r["segments"].append([round(s.start, 1), s.text.strip()])
        except Exception as e:
            r["error"] = str(e)[:240]
        finally:
            if path and os.path.exists(path):
                os.remove(path)
        out.append(r)
    return out


def main():
    vids = [captions(v["id"]) for v in req.get("videos", [])[:8]] if req.get("videos") else []
    aud = whisper(req["audio"]) if want_whisper else []
    print(json.dumps({"videos": vids, "audio": aud}))


if __name__ == "__main__":
    main()
