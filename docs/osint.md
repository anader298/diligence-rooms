# Public-source research: what runs, what blocks, what helps

`npm run osint` is the scripted first pass of every room. This page records what was measured from one Mac on 19 and 20 November 2026, with Node's built-in fetch and no paid keys.

## Running it

```
npm run osint -- --name "Jane Doe" --company "Acme Corp" --domain acme.com \
  [--title "VP Operations"] [--city Austin --state TX] [--handles janedoe] [--photo <headshot url>] \
  [--room <slug>] [--only sec,jobs] [--open]
```

Output goes to `work/osint/<name>/` (or `rooms/<slug>/work/osint/<person>/` with `--room`). `npm run run-room` and the studio's Run button do this for every person in the room before the research agents start. Responses are cached for 24 hours in the output folder, so a re-run is fast and gentle on the sources. `OSINT_VERBOSE=1` prints every call with its status and time.

## Free keys that make more of it work

| Key | Without it | With it |
|---|---|---|
| `FEC_API_KEY` (api.data.gov) | the shared `DEMO_KEY` runs out after a few calls; donations then read "not checked" | 1,000 calls an hour |
| `BRAVE_API_KEY` | web search uses DuckDuckGo (throttles after about 13 calls), public SearXNG and Bing | about 1,000 searches a month free, no throttling |
| `COURTLISTENER_TOKEN` | court records are not checked | federal and state opinions and dockets by party name |
| `OPENSANCTIONS_API_KEY` | OFAC and HHS-OIG lists only | sanctions and politically exposed people worldwide |
| `GITHUB_TOKEN` | 60 GitHub calls an hour | 5,000 |
| `SEC_USER_AGENT` | a generic contact | your name and email, as the SEC asks |
| `PATENTSVIEW_API_KEY` | Google Patents (rate-limited) | USPTO data by inventor |

## Search and image sources, measured

| Source | Kind | Keyless | Typical | Verdict |
|---|---|---|---|---|
| Google web, Images, Lens | all | no: an "enable JavaScript" page on the first call; the search API is closed to new customers | | not used by scripts; the research agents' own search covers it |
| DuckDuckGo html | snippets | yes | 0.6 s | primary; one call per 3 s; backs off on HTTP 202 |
| Bing images | images | yes | 0.2–0.5 s | used |
| Bing web / RSS | snippets | yes | 0.15 s | fallback; ignores `site:` and quotes |
| Yandex reverse image | reverse | yes | 2.5–3 s | used for the headshot |
| Public SearXNG (JSON) | snippets | 3 of 38 instances | 0.5 s | fallback |
| Brave HTML, Startpage, Mojeek, Yandex web | snippets | no: captcha or 429 on the first calls | | not used; Brave's API is |
| Instagram, Threads, Facebook | profile | a page for any name, no profile data to a normal browser | | a hit counts only when the page's name matches; the agents read captions through search previews |
| TikTok, Pinterest, Strava, GitHub, Bluesky | profile | yes | 0.3–1.4 s | used |

## Tested on three real people

| Subject | Findings | Variables | Time | Strong | Empty |
|---|---|---|---|---|---|
| EVP and GM at a listed software company | 141 | 41 of 94 | 32 s | pay from the proxy, title and trades from Form 4, revenue, ARR, segments, litigation, leadership, education, 27 open roles | hobbies, family, causes (no public social life) |
| VP Operations at a private manufacturer | 62 | 27 | 46 s | leadership bio, patents, 13 open roles, benefit-plan headcount, SaaS stack | personal side |
| Recruiter at a private software company | 70 | 26 | 30 s | job board (24 roles), profiles found by the sweep and scored | company financials (private) |

The scripted pass is strongest on company, role, pay and records, where registries exist. The personal side depends on whether the person posts publicly; the research agents then read search previews and pages the scripts cannot. The dossier lists every miss with what was searched, so a blank is never mistaken for a "no".

## Adding a source

A module is a file in `scripts/osint/modules/` that exports `{ id, label, lane, needs, env, run(ctx) }`. `ctx.http` spaces calls per host and caches; `ctx.add({ var, value, url, grade, tier, detail })` writes a ledger row; `ctx.miss(var, searched)` records a search that found nothing. Variables and tabs are listed in `config/osint-variables.json`; add new ones there, never remove one.
