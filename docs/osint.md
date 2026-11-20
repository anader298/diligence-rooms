# Public-source research: what runs, what blocks, what helps

`npm run osint` is the scripted first pass of every room. This page records what was measured from one Mac on 19 and 20 November 2026, with Node's built-in fetch and no paid keys.

## Running it

```
npm run osint -- --name "Jane Doe" --company "Acme Corp" --domain acme.com \
  [--title "VP Operations"] [--city Austin --state TX] [--handles janedoe] [--photo <headshot url>] \
  [--aliases "Maiden Name,Middle Name"] [--ticker ACME] [--room <slug>] [--only sec,jobs] [--open]
```

Nicknames are handled: "Dan Holloway" also searches "Daniel Holloway", and back. A folder that already holds a different person is moved aside, never mixed. When a source blocks or rate-limits, the dossier says "blocked, not checked" and names the free key or retry that fixes it, rather than reporting "none".

`--email` (work email) feeds the Gravatar and GitHub-commit lookups; without it the common patterns on `--domain` are tried. `--country` picks the national registry when GLEIF has no record. The trade.gov screening list is cached in `~/.cache/diligence-rooms/` (about 10 MB, daily; `OSINT_CACHE_DIR` moves it).

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
| `USPTO_API_KEY` (data.uspto.gov) | Google Patents only (rate-limited); PatentsView moved into the USPTO Open Data Portal on 20 Mar 2026 | ODP patent applications by inventor, with the inventor's city |
| `COMPANIES_HOUSE_API_KEY` | UK companies not checked | UK company record and officers |
| `STACKEXCHANGE_KEY`, `GRAVATAR_API_KEY`, `LDA_API_KEY`, `OPENALEX_API_KEY` | shared anonymous limits (300 a day, 100 an hour, 15 a minute, a shared daily budget) | higher limits |
| `PODCASTINDEX_API_KEY` + `PODCASTINDEX_API_SECRET`, `GOOGLE_BOOKS_API_KEY` | iTunes podcasts and Open Library only | Podcast Index episodes by person; Google Books |

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

## Accuracy audit

An independent agent checked 168 of 273 rows from the three runs above against their live sources: 81% correct overall, 93% of rows graded verified exactly right, and all 31 money and number rows from SEC XBRL, Form 4, the proxy and Form 5500 exact. The wrong rows were concentrated in image look-alikes, Wikidata, estimates and identity scoring on namesakes; a second review on four new executives found the same plus nickname misses, unit errors in segment tables and an unflagged departure. All of those were fixed with tests (159 in the suite), and the re-runs showed no namesake graded "likely" and no wrong snapshot card.

## Accuracy pass 2: fitted weights and the two-signal rule

Thirteen subjects were run and every Verified and Partly row, plus every scored account, was checked by hand against its live source: 10 training subjects (8 real executives, 2 fictional controls) and 3 held-out executives used for nothing but measuring. The labels name real people, so they stay in the git-ignored `work/osint/labels*`.

| Slice | Verified rows correct, before | After | Verified or Partly, before | After |
|---|---|---|---|---|
| Training (10 subjects) | 303 / 325 (93.2%) | 162 / 163 (99.4%) | 408 / 441 (92.5%) | 406 / 413 (98.3%) |
| Held out (3 subjects), first measurement | 116 / 158 (73.4%) | 69 / 76 (90.8%) | 180 / 240 (75.0%) | 193 / 233 (82.8%) |
| Held out, after a second round of fixes found on it (no longer blind) | | 73 / 74 (98.6%) | | 181 / 213 (85.0%) |

What changed:

- **Verified needs two independent signals.** After every run the runner keeps a row Verified only when a second source family agrees (different registries or sites; two pages of one site are one family) or the row is a primary record keyed to the subject: EDGAR by CIK, Forms 3/4 by the owner's filer CIK, a full-list sanctions screen, the domain's own DNS, the job board the careers page links to, or a registry's own zero count. Every other Verified row shows as Partly, with `graded_from` and `grade_basis` on the row. That is why fewer rows are Verified: the rule moves rows, it does not drop them.
- **Identity weights are fitted.** `config/osint-weights.json` (version 2) holds the weights in bits, fitted by `scripts/osint/fit-weights.mjs` on 123 labelled candidate accounts (9 were the subject's) with leave-one-subject-out checking. Signals with no labelled cases (official link, headshot, place, title) keep their hand values until runs with them are labelled. An account is Verified only at p ≥ 0.99 with two anchors from two sources; the account page alone is one source, so a LinkedIn profile naming the employer is Partly. Every ledger row records the weights version.
- **False-positive patterns fixed:** other companies that share a word with the company (plan sponsors, award recipients, lobbying clients); a lobbying count that was the API's fuzzy total; Form 3s filed at another company; titles and bios left as current after a filing reports a change of seat; "left" when a succession filing only says the seat changed hands; holdings valued at an old price; percentage lines read as money; sub-metrics and targets read as company KPIs; part-time staff dropped from headcount; table-of-contents page numbers and cut-off 8-K text; parked domains; headlines about a person or a street that shares the company's name; a CEO "asking employees to quit" read as leaving.

Where it is still weak: Partly rows on a company whose name is a common word (one held-out company shares its name with several firms, and registry rows matched by name stay Partly but are often someone else's), a stale employer in a profile headline, and name-only accounts, which stay Weak.

## The agent layer on top

On the public-company EVP, a research agent starting from the scripted ledger (P4a step 0) took the dossier from 41 to 60 of 94 variables in about 10 minutes and 30 searches: a maiden name that opened her earlier record, a nonprofit board seat, five talks with captions, the revenue her unit owns, and her own words on priorities. Scripts take the registries; agents take what has to be read.

## Part 2 sources, measured (20 Nov 2026)

The default run is now 53 modules (31 fast, 5 sweep, 15 slow, 2 late) plus 5 opt-in heavy ones. A full pass on a public-company CEO took 54 s cold, and 49 s for his CFO with every heavy module on, inside the 60 s target; the slowest tail is crt.sh (23 s). Per module, each tested live on public executives and companies:

| Module | Source | Typical |
|---|---|---|
| `company-resolve` | SEC tickers, GLEIF, Wikidata search | 1.5–1.9 s |
| `registries` | GLEIF parents and subsidiaries | 1.7–2.8 s |
| `intl-registries` | France, Norway, Czech Republic (UK with a key) | 1.7–2.2 s |
| `sec-frames` | XBRL frames ranked within the SIC code | 7.7–8.4 s (EDGAR's SIC list is slow; marked "partial SIC list" when cut off at 6 s) |
| `brokercheck-iapd` | FINRA BrokerCheck, SEC IAPD | 0.4–0.9 s |
| `licenses` | NPI, NY attorney registry, Colorado, Texas | 0.4–0.8 s; the NY registry timed out once at 8 s |
| `bank-cu` | FDIC BankFind, NCUA (banks and credit unions only) | 1.6–2.1 s |
| `sanctions-csl` | trade.gov Consolidated Screening List, 26,297 entries on 12 lists | 8.4 s first download, 0.4–0.9 s warm |
| `lobbying-fara` | lda.gov lobbyists, FARA registrants | 0.8–4 s |
| `domain-intel` | RDAP | 0.7–1.3 s |
| `enforcement` (slow) | EPA ECHO | 1–2.5 s |
| `actor-search` | Mastodon search on three large instances | 0.7–1.1 s |
| `gravatar`, `github-email` | Gravatar v3 and GitHub commit search by work email | 0.4–1.5 s |
| `verified-links`, `linkpages` (slow) | Keybase proofs, Mastodon verified fields, GitHub social accounts; Linktree, `rel=me` | 0.1–0.8 s |
| `dev-communities`, `package-registries`, `hobby-apis` (slow) | Stack Exchange, HN; crates.io, RubyGems, PyPI; Discogs, Letterboxd, chess.com | 0.1–5 s (Discogs allows 25 calls a minute) |
| `wikipedia`, `scholarly`, `media-feeds` | Wikipedia summary and pageviews; ORCID, OpenAlex, Semantic Scholar, Crossref; iTunes podcasts | 0.5–1 s |
| `feeds`, `books` (slow) | blog, Medium, Substack, YouTube feeds; Open Library | 1–3 s |

Accounts found by these modules join the same candidate list as the username sweep and are scored by the identity module; Gravatar, Keybase and link-page proofs feed its existing "linked from an official page" signal. PyPI user pages and the USPTO ODP were not reachable without a browser or a key. Commit emails can be set by anyone, so a GitHub account found through a guessed address is used only when its profile name matches.

## The heavy lane (opt-in)

Five modules run only when asked, after the slow lane and before identity scoring. Each is a Python sidecar in `scripts/osint/py/` or a separate program, started lazily: nothing spawns unless there is input for it. A missing Python, library or binary never stalls the run: the module's status is `error` and its variables carry a "not run" miss with the install line, so coverage shows the gap rather than a false "none". `npm run doctor` lists each one as ready or missing.

| Flag | Module | What it adds | Needs | Measured (20 Nov 2026) |
|---|---|---|---|---|
| `--heavy headshot-match` | `headshot-match` | the official headshot (`--photo`, the company bio photo, else a profile photo) against every candidate avatar, pHash over a 9-scale × 25-offset crop search; ≤ 6 of 64 bits is the same photo, 7–10 possible. A match is passed to the identity score as a reused headshot (the existing signal), never as a face match | imagehash, Pillow | 19 avatars in 2.1 s |
| `--heavy article-extract` `--articles u1,u2` | `article-extract` | main text, byline, date and outlet of chosen articles (or the five best article rows that name the person), the sentences about them and the quotes attributed to them | trafilatura | 2 articles in 1.5 s |
| `--transcribe` (or `--heavy transcripts` for captions only) | `transcripts` | captions of the talks the talk modules found: length, where the company comes up (timestamps), top terms; with `--transcribe`, podcast audio through faster-whisper on CPU | youtube-transcript-api; faster-whisper for audio | 6 keynote and interview videos in 6.3 s; a 100 s episode in 20 s with `tiny.en` (first run includes the model download) |
| `--heavy doc-metadata` `--docs <dir>` | `doc-metadata` | author, last editor, company, software, dates and GPS in the room's corpus files (`rooms/<slug>/work/corpus` with `--room`) | `exiftool` (or `OSINT_EXIFTOOL`) | 3 PDFs in 0.8 s |
| `--heavy sec-proxy` | `sec-proxy` | the latest DEF 14A: every named executive's pay by component for three years, pay versus performance, CEO pay ratio, director pay, audit fees, the ballot | edgartools | 6.6 s warm, 37 s cold |

`--heavy all` turns on all five. Install with `pip install -r scripts/osint/py/requirements.txt` (a venv is fine; point `OSINT_PYTHON` at its python). faster-whisper had no Python 3.14 wheels on 20 Nov 2026 (onnxruntime); use 3.12 or 3.13 for `--transcribe` audio.

## Licences

Nothing from another project is copied into this repo. The sidecars import imagehash (BSD-2-Clause), Pillow (MIT-CMU), trafilatura (Apache-2.0), youtube-transcript-api (MIT), faster-whisper (MIT) and edgartools (MIT) as installed libraries, pinned in `scripts/osint/py/requirements.txt`. ExifTool (Perl Artistic / GPL) is only ever run as a separate program. Data terms travel with the rows that need them (`detail.terms`): FINRA BrokerCheck permitted uses, CC BY-SA attribution for Wikipedia and Stack Exchange, per-file licences for Wikimedia Commons, no solicitation for FEC data.

## Adding a source

A module is a file in `scripts/osint/modules/` that exports `{ id, label, lane, needs, env, budgetMs, run(ctx) }` (heavy modules add `flag` and `deps: { python: [...], bin: [...] }`, which `npm run doctor` reads). `ctx.status("blocked" | "partial" | "error", why)` marks a source that refused or a dependency that is missing; `ctx.rows` is the ledger so far and `ctx.opts` holds `--articles`, `--docs` and `--transcribe`. `ctx.http` spaces calls per host and caches; `ctx.add({ var, value, url, grade, tier, detail })` writes a ledger row; `ctx.miss(var, searched)` records a search that found nothing; `ctx.miss(var, what, { blocked: true })` records a source that could not be checked (a failed or refused call, a missing key), which the form shows as "couldn't check", never as "searched, nothing found". Every miss carries that flag, and the form reads the flag rather than the text. Variables and tabs are listed in `config/osint-variables.json`; add new ones there, never remove one.
