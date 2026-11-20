# The diligence room standard (v1.1)

A diligence room is a private website prepared for one counterparty and one conversation: an interview, a deal, an audit or a pitch. This standard fixes everything about a room except its inputs, so that one line typed in produces a room of the same depth every time:

```
/room <person(s)> | <their company> | <what we want> | mode: <interviewing | deal | audit | pitch> | date: <meeting date> | deadlines: <date title; ...>
```

Everything else is fixed: the page set, the marking language, the agent prompts (`pipeline/PROMPTS.md`), the quality gates and the renderer (`scripts/build.mjs`). Only three things vary: the inputs, the mode pack and the org-type pack.

The bar is the two reference rooms this standard was written from: a 47-page room for a consulting-firm interview process and a 38-page room for an asset owner. Both were built by hand; this standard is what they had in common, plus what was missing from each.

---

## 1. Why a standard

| Problem found in earlier rooms | Fix in this standard |
|---|---|
| Three different renderers (hand-built HTML, a markdown converter, a Python page list) | One engine: `room.json` plus `pages/*.html`, built by `scripts/build.mjs` (sec. 13) |
| Marking words drifted: Inference / [inferred] / assumed; HAVE / ADJACENT / NOT DONE next to Strong / Partial / Gap; two fill-in markers | One legend (sec. 9), enforced by lint |
| Research stopped at markdown notes; nothing turned notes into a room | Stage 6, Render |
| No bulk harvest of their own publications (a 356-paper index and a 70-case corpus were built ad hoc) | Stage 2, Harvest, done by script rather than by search |
| The search budget ran out mid-pass and the passes were never redone | A search budget per stage, curl for bulk pulls, a gap ledger, and an OSINT log so any pass can be re-run |
| The prep was built around one theme while their library was mostly about others | Stage 5 coverage matrix: our prep against their whole library |
| A deck was built for the wrong audience; audience analysis and the deck were never reconciled | The "who is actually in the room" rule; the one card is aimed at the person, not the topic |
| The same model graded its own drafts in character | An independent grader in every practice and accuracy pass |
| The live room fell behind its builder; a second round was never merged | A room is done only when the build is published to the private site and the as-of date matches |
| Interview-only logic; nothing for deals or audits | Mode packs (sec. 7) |
| People research was a persona and little else; the other side's view of us was never checked | The people and OSINT layer is core (sec. 3 to 5), and the mirror runs the same profile on our side |
| Per-room copy-pasted gates with hard-coded passwords | One HMAC gate, `ROOM_PASSWORD_<SLUG>` |

---

## 2. Inputs and our side

**The input line** names the person or people across the table, their company, and what we want from the conversation. Mode, date and deadlines are optional; intake infers the mode from the ask and asks for the meeting date and any deadlines only if it cannot find them.

**Meetings and deadlines** live in `room.json` (and `intake.json`) from the start, entered in the studio's Start flow or with `new-room --meeting/--deadline`:

```json
"meetings":  [{ "date": "2026-12-01", "time": "14:00", "title": "Round 2", "who": "Jane Doe, John Roe", "format": "video", "length": "60 min" }],
"deadlines": [{ "date": "2026-11-28", "title": "Send the case deck", "kind": "submission", "done": false }]
```

`kind` is one of `submission`, `decision`, `document`, `prep`, `follow-up`, `other`. The room index opens with a countdown to the next meeting and the open deadlines; the `process` page renders both lists at its top.

**Summary.** `room.json` `"summary"` is one paragraph: who we are meeting, what we want, the three things that matter most, and the main risk. It is rendered at the top of the room index and written last, with the one card (P9).

**Our side** is never typed in and never written into the repo. It is read from `config/our-side.json` (gitignored; copy `config/our-side.example.json`):

| Field | What it is |
|---|---|
| `name` | The person who will be in the room for our side |
| `organisation` | Their organisation, if any |
| `factsFile` | Path to the locked facts file. Every number, date or title about our side comes from this file and nowhere else |
| `overlapHooks[]` | Schools, employers, places and languages, for the people map's warm paths. The person pages never match anything to our side |
| `publicHandles[]` | Our own public accounts, for the mirror (sec. 5.4) |

**Tier.** Full unless the meeting is under 48 hours away, then light (sec. 11).

---

## 3. The page set: core (every room, every mode)

Page ids are fixed so prompts, lint and the helper always know where things are. Company-level pages live in `templates/skeleton/core/pages/`; per-person pages live in `templates/skeleton/core/person/` and are repeated once per person as `<id>-<person-slug>`.

**Groups.** The room index shows the sections in three big expandable groups, with Start here on top and the record behind them. Each section in `room.json` carries a `group`:

| Group | Title on the index | Sections |
|---|---|---|
| `start` | Start here (on top, open) | `start`: the one card, plain words, the process; the summary, countdown and deadlines sit above it |
| `person` | The people | one section per person, split into **Personal** (personal life and interests, socials, partner socials, names, education, financials, their circles) and **Professional** (persona with the verdict and what drives them, LinkedIn, writing, own words, network, public record, timeline); each person page carries `part`: `personal` or `professional` |
| `role` | The role, the deal, the specifics | `ask`, every mode pack (sec. 7), `meetings`, `drills` |
| `company` | The company | `them`, `outside`, `people` (org chart, people map), every org-type pack (sec. 8) |
| `behind` | Behind the room (at the bottom, collapsed) | `mirror`, `record` |

A section with no `group` is placed by its id (mode packs under `role`, org-type packs under `company`); a person page with no `part` by its page id. Every page stays; the groups only order the index.

**A. Start here**
- `one-card`: the ask in one sentence, the line, numbers to hold, questions to ask in order, terms in plain words, logistics, and every open `[FILL: …]` item. Written last.
- `plain-words`: the whole situation explained to a smart 12-year-old, plus 10 traps as "sounds right / say this instead".
- `process`: every step with dates (done / next / to come), who is in each meeting, format and length. Mirrors `room.json.process`; the build puts `room.json.meetings` and `deadlines` at the top of the page.

**B. Them: who they are, the money, the rules**
- `who-they-are`: 8 to 10 chapters ending in open questions, with a disambiguation line at the top ("Not X. Not Y."), and "What drives the company": financial, social, commercial and technical, each with evidence, grade and source.
- `money`: who owns them, who funds them, who lends to them, the fee or revenue trace, the liability side, and what the money most likely wants.
- `public-financials`: the company checklist first (revenue, funding, assets, debt, filings, credit, ownership: one row each, never omitted), then every other public number about them, by source (sec. 4.2), with the year and the filing.
- `rules`: the regulator, mandate, screens, exclusions and codes, plus the can / can't table (what they and the seat can and cannot agree to).
- `filings-bank`: every public instrument, graded, each with an "If they ask" line in our first person, and the top 15 ranked.
- `documents`: the indexed corpus of everything they publish, plus "phrases they reach for" with counts.
- `translation`: their term, its plain meaning, our closest true proof, their 3 to 5 nearest cases with a sentence to echo, and words to avoid.

**C. Them, from the outside**
- `partners`: customers, suppliers, co-investors, lenders, advisors, auditors, law firms, sponsors.
- `reviews`: employer and customer review sites, with patterns, counts and dated quotes.
- `forums`: what staff, candidates, customers and competitors say in forums.
- `news`: dated press coverage, their own releases separated from independent coverage.
- `domain-and-tech`: domains, WHOIS history, Wayback history of key pages, technology stack, and job posts read as a strategy signal.

**D. The people across the table**
- `org-chart`: every seat, name and tenure, and who held it before (the predecessor answer).
- `people-map`: who decides, who influences, what each cares about, how they connect to each other, warm paths and overlaps with our side.
- Per person (repeated for each person, `<id>-<person-slug>`, in this order; 14 pages):
  - `persona`: the 11 fixed sections, built cold (without reading our side), after an "inputs checked" checklist, plus a graded "How they think and behave" table: decision style, risk appetite, pace, what earns their trust, what irritates them, how they treat juniors and service staff, written and spoken habits, each with evidence. At the top: the headshot (official page, with source and date), the **verdict** on the scale Proven / Mixed / Unproven with one plain summary line, then **claims against the record** (claim, what the record shows, source, grade), then **what drives them**: financial, social, commercial and technical, each with evidence, grade and source.
  - `interests` ("Personal life and interests"): home and places, family (married, number of children; never children's names or schools), upbringing and life events, sports played and followed, outdoor (golf, hunting, fishing, running, sailing), cars and machines, food and drink, travel, music, books and podcasts, causes and charities, faith or community groups (only when they make it public), collecting and hobbies, family rhythm (no children named), clubs, and how they spend weekends; life photos with source and date. **Findings only**: the reader sees what was found (verified, partly, weak), each with its evidence, grade and signal strength. The checklist itself lives in the page's brief, and every row is logged, found or not, in the OSINT log's "Checks per person" table. Built cold.
  - `socials` (was `footprint`): every public account, with handle, link, followers, active since, last post, what they post, tone, and the basis on which identity was confirmed.
  - `partner-socials`: the spouse or partner, and business partners and co-founders: their public accounts and what they reveal about the person.
  - `linkedin`: the career timeline with dates, what they like and comment on, who they engage with, endorsements, groups, and recommendations given and received.
  - `education`: degrees, schools and years, honours, awards, dean's lists, scholarships, clubs, societies, fraternities or sororities, athletics, student leadership, alumni groups, theses.
  - `writing`: white papers, articles, op-eds, blog posts, theses, books and research, with patents cross-referenced.
  - `names`: alternative spellings, maiden and married names, nicknames, transliterations, prior legal names, reused usernames. Every name here is used to widen every other search.
  - `own-words`: timestamped transcripts of their podcasts, talks and panels, with through-lines and phrases to use back.
  - `network`: business partners, co-investors, board seats, prior colleagues, mutual connections with our side, and warm paths.
  - `public-record`: company registrations and officer roles, court cases, liens and UCC filings, political donations, patents and trademarks, licences, press, and the Wayback history of their bios.
  - `financials`: the person's financial footprint in public: companies they own or officer, fund roles, Form D, ADV and 990 filings naming them, real estate held by their companies (a residence only when it is a contact or business address of record, labelled as such), political donations, disclosed compensation.
  - `timeline`: everything above merged into one dated timeline.
  - `relate` ("Their circles"): the clubs, events, outings and conferences where they spend time, as findings (what, how often, evidence, grade, source); what they will test for; rules for using them; the never-raise list and traps. Built cold like every other person page: nothing on it is matched to our side.

  **Every per-person page is a checklist.** Each page opens with (or is built around) a table of class `checklist` whose rows are fixed by the skeleton. No row is ever deleted. Each row ends in exactly one state: found (the finding, its grade and source), weak (written, graded `weak`), or nothing (`None found`, graded `none`, plus what was searched: tool and exact query). Lint fails a filled page with a checklist row that carries no grade.

  **The reader sees findings only.** On person pages the build hides every checklist row graded only `none`; the row stays in the page file (lint still checks it) and the same check is logged in the OSINT log's "Checks per person" table (sec. 5.3). The personal life page goes further: its checklist is in the brief, not on the page, and only findings are written. Nothing about the people is matched to our side on any person page.

**E. The ask** (plus the mode pack, sec. 7)
- `duty-map`: each line of the ask (the posting, the mandate, the scope, the request) against our evidence, graded Strong / Partial / Gap, with the spoken bullet for each.

**F. Meetings**
- `companion`: how to use the live companion in this room's meetings: the setup checklist, the consent rule and who has agreed, and what it must never surface (sec. 15).
- `meeting-1`: the brief before the meeting and the debrief written within the hour after it. Copy to `meeting-<n>` for each later meeting or round.

**G. Vocabulary** (and the optional practice pack)
- `glossary`: 40+ terms for a full room: term, plain meaning, how they use it.
- Practice pack, off by default (`templates/skeleton/extras/practice`; studio "Practice pages", `new-room --practice`): `answer-bank` (about 20 questions, answered in the first person, graded by someone other than the writer), `practice-bank` (questions in each persona's voice, a few push-backs), `push-back-gym` (short), `mock-transcripts` (one short screen and 12 one-breath lines).

**H. Our side, as they will see it** (the mirror, sec. 5.4)
- `our-side`: what a cold search of our side returns, compared with the facts file, with conflicts and fixes.
- `mirror-footprint`: our public accounts as they appear to a stranger.
- `mirror-record`: our public record, network and merged timeline, and what they will most likely bring up.

**I. The record**
- `corrections-log`: date, was, now, why.
- `reconciliation`: after each meeting, every claim marked confirmed, corrected, new or still open.
- `sent`: everything we sent them and the claims to stay consistent with.
- `data-sources`: which data connectors ran (sec. 5.6), the credits each used, the fields each filled, and every conflict between providers.
- `osint-log`: every search run for this room (sec. 5.3).
- `sources`: the gap ledger (what we could not reach and why) and the full source list.

---

## 4. The people and OSINT layer

The other side researches us before every serious conversation: recruiters read our profiles and posts, investors pull our filings and court records, buyers check our references. A room does the same for them, from public material only, and does it more thoroughly. This layer is core in every mode.

### 4.1 Per person

**Names first.** Before any other search, build the names page: alternative spellings, maiden and married names, nicknames, transliterations, prior legal names, initials forms and reused usernames. Every later search is run under each name, and the page records which.

**Socials.** Check every platform and record the result, including "None found":

| Platform | Record |
|---|---|
| LinkedIn, X, Instagram, Facebook, Threads, Bluesky, TikTok, YouTube, Reddit, GitHub, Substack, Medium, personal site, others found by handle search | handle, link, followers, active since, last post, what they post, tone, identity basis, grade |

Identity is confirmed before anything from an account is used: same photo (reverse image search), same employer or city in the bio, cross-links between accounts, or the account linked from an official page. An account that cannot be tied to the person is graded `weak` and nothing from it is used as fact.

**Partner socials.** The spouse or partner and the business partners: their public accounts and what they reveal about the person (events, causes, family-business ties, how they describe the person's work). Public posts only, nothing on minors, no real-time location. Anything learned only here goes on the their-circles page's "never raise" list.

**Personal life and interests.** People do business with people they feel at ease with, and many test for a shared personal interest before they test the numbers: some do their real business on a golf course, at a shoot or over dinner. The personal life page records where they live and spend time (city, area, a second home), their family (married, number of children; never children's names or schools), their upbringing and life events, what the person plays and follows, what they eat and drink, the clubs, boards and causes they show in public, and how they spend weekends, from their own posts and photos, race and tournament results, club rosters, charity boards and podcast bios. Each row carries its evidence, a grade and a signal strength (strong, medium, light). Faith or community groups only when the person makes them public; family rhythm without naming children; restaurants as cuisines and types, never as a pattern of where they will be. The persona's "How they think and behave" table sits beside it: how they decide, how much risk they take, their pace, what earns their trust, what irritates them, how they treat juniors and service staff, and their written and spoken habits. Life photos (a race finish, a club event, a gala, a talk) are kept with their source and date; never a photo of a minor, a home, or anything that shows where they are now. The page shows findings only; the checks that found nothing are in the OSINT log.

**Verdict and what drives them.** The persona opens with a verdict on the person's own account of themselves: **Proven** (the record backs what they claim), **Mixed** (some claims hold, some do not or cannot be checked) or **Unproven** (the main claims have nothing public behind them), with one plain summary line and a "claims against the record" table: each claim from their bio, profile, talks or the company site, what the public record shows, the source and the grade. Then "what drives them" in four rows: financial (pay, equity, carry, an exit, debts), social (standing, boards, causes, reputation), commercial (targets, the deal they need, their customers) and technical (the systems, methods or platforms they champion), each with evidence, grade and source. Motives are `inference` unless the person said it themselves. The company gets the same four drivers on `who-they-are`. The headshot comes from an official page, with its source and date.

**Education.** Every degree with school and years; honours, awards, dean's lists, scholarships; clubs, societies, fraternities or sororities, athletics, student leadership and student press; alumni groups; theses. Sources: commencement programmes and honours lists (often PDF), student newspapers, athletics rosters, alumni magazines, thesis repositories.

**Writing.** White papers, articles, op-eds, blog posts and newsletters, books, research and conference papers, theses; patents cross-referenced from the public record. For each: date, outlet, co-authors, the argument in one line.

**LinkedIn deep read.** Built from what any member sees under the user's own account, the user's own LinkedIn data export or Sales Navigator export, and licensed providers (sec. 5.6); never from scraping LinkedIn or a third-party scraping API. Career timeline with month and year, gaps, title changes inside one employer, education, certifications, volunteer roles; the posts they write, like and comment on over the last 12 months (themes and counts); the people they engage with most; endorsements and who gave them; groups; recommendations given and received (who wrote them and what they praise).

**Own words.** Every podcast, talk, panel, webinar, earnings call, op-ed and quoted interview. Audio and video are transcribed with timestamps; names are corrected against the staff page.

**Network.** Business partners and co-founders; co-investors and co-directors; board seats (corporate, nonprofit, advisory); prior colleagues who overlapped with them; a spouse or partner's public professional posts and roles; mutual connections with our side; warm paths, each with the route and its strength.

**Financials.** The person's money in public: companies owned and officer roles, fund roles (GP, managing member, adviser), Form D related persons, Form ADV and BrokerCheck, 990s naming them (pay, board, related parties), real estate held by their companies (entity and parcel record only), political donations, disclosed compensation, liens and UCC filings as debtor.

**Public record.** Company registrations and officer or director roles (state registries, OpenCorporates, Companies House); court cases (CourtListener, PACER, state and county portals); liens, judgments and UCC filings; political donations (FEC, OpenSecrets, state databases); patents and trademarks (USPTO, Google Patents); professional licences and disciplinary records (bar, CPA, medical, FINRA BrokerCheck, SEC IAPD); press; the Wayback history of their bio pages.

**Timeline.** All of the above merged into one dated table, oldest first, each row sourced and graded.

### 4.2 Per company

- **Public financials**: the company checklist (revenue, funding, assets, debt, filings, credit, ownership), each row found, weak or None found with what was searched; then everything else. Sources: EDGAR (10-K, 10-Q, 8-K, S-1, proxy, 13F), Form D, Form ADV, 990s via ProPublica Nonprofit Explorer, state filings and annual reports, bond and municipal disclosures (EMMA), credit ratings and rating reports, government contracts (USAspending, SAM.gov, state procurement portals), grants.
- **Forums**: Reddit, Blind, Fishbowl, Wall Street Oasis, PrepLounge, industry forums and trade-association boards.
- **Reviews**: Glassdoor, Indeed, Comparably, Kununu, Trustpilot, G2, Google reviews, BBB.
- **Partners**: customers, suppliers, co-investors, lenders, advisors, auditors, law firms, sponsors. Sources include their case studies and logo walls, press releases, filings (auditor, counsel, lenders), UCC secured parties, and the partners' own sites.
- **Domain and technology**: WHOIS and its history, Wayback captures of the home, about, team and careers pages, the technology stack (BuiltWith-style lookups, page source), subdomains in certificate transparency logs (crt.sh), and job posts read as a strategy signal (what they hire for, where, how many, since when).
- **News**: dated coverage, their own releases kept apart from independent reporting.

### 4.3 Grades for people material

The same seven grades apply (sec. 9). A search-engine snippet that could not be opened is at most `partly`; a single unconfirmed source, or an account not yet tied to the person, is `weak`; a search that found nothing is `none`, with the search written down. A review or forum post is `verified` only as "this was posted", never as proof of what it claims. Anything about a person's motives, feelings or private life is `inference` and is written as "the <name> persona".

---

## 5. The OSINT method

### 5.1 Tools and how each is used

| Tool | Use it for | How |
|---|---|---|
| Google / Bing operators | Everything else; finds what the platforms' own search hides | See the dorks in 5.2. Run each on both engines; they index differently |
| Wayback Machine (web.archive.org) | Old bios, team pages, removed claims, title changes | `web.archive.org/web/*/example.com/team*` lists every capture; compare the earliest and latest. The CDX API (`/cdx/search/cdx?url=…&output=json`) lists captures by script |
| archive.today (archive.ph) | Pages Wayback missed; a frozen copy of anything that may change before the meeting | Search the domain; save a fresh capture of key pages and cite it |
| WhatsMyName, Sherlock | Handle reuse across hundreds of sites | Run the handle from the confirmed LinkedIn or X account; every hit must still pass identity confirmation (4.1) |
| Reverse image search (Google Lens, Bing, TinEye, Yandex) | Confirming that two accounts are the same person | Search the profile photo; matching photos across accounts are a confirmation signal, not proof alone |
| OpenCorporates, state registries, Companies House | Companies a person or firm is behind; officer roles; registered agents | Search by officer name and by company; note formation and dissolution dates |
| CourtListener / RECAP, PACER, state and county portals | Litigation as plaintiff or defendant | Search party name with and without middle initial; record the docket number, court, date, nature of suit and outcome |
| FEC, OpenSecrets, state campaign-finance databases | Political donations | Search by name plus city or employer to separate namesakes |
| EDGAR full-text search (efts.sec.gov) | Mentions of a person or firm inside any filing since 2001 | Quote the name; filter by form type (D, ADV, 10-K, DEF 14A, 8-K) |
| SEC IAPD, FINRA BrokerCheck | Registered advisers and representatives; disclosures | Search the person and the firm |
| ProPublica Nonprofit Explorer | 990s: revenue, pay of officers, board, grants, related parties | Search the organisation; read Part VII and Schedules L and R |
| LittleSis | Board interlocks, donors and power networks | Search the person and the organisation; follow the relationship graph |
| USPTO (patents and trademarks), Google Patents | Inventions and brands owned | Search inventor and owner names |
| USAspending, SAM.gov | Federal contracts and grants | Search the recipient; note the awarding agency and amounts |
| EMMA (MSRB) | Municipal bond disclosures | Search the issuer or the obligor |
| Crunchbase-style databases and press | Funding rounds, investors, acquisitions | Use the free tier and the press they cite; cite the press, not the aggregator, where possible |
| Licensed data (sec. 5.6) | Titles, career dates, firmographics, funding, job posts, from our licensed Apollo account | Run in stage 2b after the estimate; use `merged.json` as leads and confirm each at a public source |
| YouTube, podcast directories (Apple, Spotify, Listen Notes) | Talks and interviews | Search the name in quotes plus the company; transcribe with yt-dlp and faster-whisper (or the platform transcript) and keep timestamps |
| crt.sh, WHOIS history, BuiltWith-style lookups | Domains, subdomains, stack | Search the domain; note registration dates and new subdomains |
| Review and forum sites | Reviews, forums (4.2) | Use what is visible without signing in; where a site gates content, use what any member sees under a real account, or the search-engine snippet graded `partly` |

### 5.2 Dork patterns

Replace the placeholders; record every query run in the OSINT log.

```
"First Last" "Company"                              exact name with employer
"First Last" site:linkedin.com/in                   profile, including old employers in the snippet
"First Last" site:linkedin.com/posts                posts they wrote
"First Last" (podcast OR webinar OR panel OR keynote) own words
"First Last" filetype:pdf                           decks, papers, board minutes, speaker bios
"First Last" site:youtube.com                       talks
"First Last" (site:x.com OR site:twitter.com)       posts, replies
"First Last" site:reddit.com                        mentions; their own handle comes from 5.1
"Company" site:reddit.com (interview OR layoffs OR culture)
"Company" (site:glassdoor.com OR site:indeed.com) "First Last"   reviews naming a person or title
"Company" "case study" OR "client story" -site:company.com      partners as described by others
"Company" (lawsuit OR "v." OR complaint) -site:company.com
"@company.com" -site:company.com                    staff addresses quoted elsewhere, conference lists
site:company.com inurl:team OR inurl:about OR inurl:leadership
site:company.com filetype:pdf                       their own documents (feeds the corpus)
intitle:"index of" "Company"                        exposed document folders (read only what is publicly listed)
```

### 5.3 The OSINT log

Every search, lookup and fetch made for the room goes into `osint-log`: date, tool, exact query or URL, hits, what was kept, and which page it fed. The log makes the work reproducible and lets the whole pass be re-run before the next meeting, with new hits marked "new since <date>". A search with no hits is logged too; a negative finding is a finding.

The log also holds a "Checks per person" table: one row per checklist row run on a person page (`<tr class="ck" data-page="<page id>">`: person, page, row, result graded, what was searched), including every check that found nothing. That is where the reader-hidden rows live, and lint counts personal life completeness from it (sec. 11).

### 5.4 The mirror

The same profile (names, socials, interests, LinkedIn deep read, education, writing, own words, network, public record, financials, timeline) is run on our side by a separate agent that has not read the room, starting only from `config/our-side.json` name, organisation and `publicHandles[]`. The result is what the other side will find. It is then compared with the facts file (which of our interests they can see, and which we will have to raise ourselves): every conflict, stale profile line, old post or record that may come up gets a fix or a prepared answer.

### 5.5 Boundaries

Publicly available information only. No logging in to view non-public content (posts limited to connections or approved followers, closed groups, private profiles). No fake or pretext accounts. No connection or follow requests made to research someone. No breached or leaked data, credential dumps or paste-site leaks. Nothing on minors. No real-time location. Everything else that is public or licensed is in scope.

**Contact routes.** Keep every email, phone and address a provider or public source returns, labelled: kind work, personal or unknown, phone type (direct, office, mobile, home, other), and the source. In small and owner-run firms the founder's personal email, mobile or house is often the business contact of record, and the team shares one set of details. So a personal email, phone or address is not dropped: it is checked against the company's own records (its website, the state registry, SEC / Form ADV / Form D / 990 filings, UCC filings, the domain WHOIS) and, where it matches, marked "business of record" with the record named. A residential address appears on a page only when it is a contact or business address of record, and is labelled as such ("home address, also the registered office per the state registry"). Contact routes go in the "Contact routes" table (Value, Kind, Business of record?, Source, Grade) on the person's linkedin page and the company's who-they-are page, not scattered through prose.

No scraping of LinkedIn and no third-party LinkedIn scraping APIs (LinkedIn's terms ban it, and the courts have sided with LinkedIn on contract). LinkedIn content comes from what the user sees under their own account, the user's own data export or Sales Navigator export, or a licensed provider (sec. 5.6).

Note that LinkedIn shows profile views to the person viewed unless private mode is on; choose deliberately.

### 5.6 Data connectors (licensed data and own exports)

**The data behind a room: public sources and our licensed data (Apollo).** We run our own Apollo account; the client is never asked to connect an account, share a login or export anything. The adapters for other providers stay in the code for later and are off unless we enable them. `npm run enrich -- <slug>` (stage 2b) asks the enabled providers, using our keys in `.env`:

| Provider | Kind | Fills |
|---|---|---|
| Apollo.io | API key, or the Apollo MCP server in Claude Code (`apollo-mcp`) | titles and career history, seniority, departments, city, profile URLs, work and personal emails, phones (direct, office, mobile, home) and addresses, each labelled; company size, revenue, funding, technology, job postings, office address |
| ZoomInfo, Lusha, Cognism | API key | titles, history, education (ZoomInfo), seniority, departments, city, labelled emails, phones and addresses; firmographics and company address |
| Clay | table webhook, then the table's CSV export | whatever the table's columns enrich |
| Crunchbase, PitchBook | API key | funding rounds, investors, parent and subsidiaries, headcount; people's jobs and degrees |
| LinkedIn export, CSV | local files in `rooms/<slug>/work/imports/` | the user's own LinkedIn data (Connections.csv: current title and the date we connected), Sales Navigator lists, CRM or data-room exports |

Rules:
- **Estimate first.** Without `--yes` the stage prints a credit estimate per provider and stops. Nothing is called and nothing is spent until the user confirms. A run over `maxCredits` in `config/connectors.json` stops too.
- **Our account, not the client's.** Keys stay in `.env`; `config/connectors.json` (gitignored) lists the enabled providers in priority order. The studio shows which are configured, never the keys.
- **Leads, not facts.** `merged.json` is a lead list for the research stage. Every value is graded `partly` (sec. 9) and is confirmed at a public source before it is used as fact; the public source is what gets cited.
- **Conflicts are findings.** Different titles, dates, headcounts or revenues between providers go into `conflicts.json` and onto the `data-sources` page until a public source settles them.
- **Contacts are kept and labelled.** Every email, phone and address a provider returns is stored in `person.contacts[]` (`type` email / phone / address, `value`, `kind` work / personal / unknown, `phoneType` direct / office / mobile / home / other, `source`) and `company.addresses[]` (`value`, `role` registered / principal office / mailing / other, `source`). Nothing is dropped for being personal; the city field (`locationCity`) stays too.
- **Business of record.** The research stage saves the company's own contact records to `rooms/<slug>/work/business-records.json` (`[{record: "website" | "state registry" | "SEC" | "Form ADV" | "Form D" | "990" | "UCC" | "WHOIS", url, emails[], phones[], addresses[]}]`); the merge marks any contact that matches one `sameAsBusiness: true` with `businessRecords` naming it. Re-run `npm run enrich -- <slug> --yes` (local providers cost nothing) after saving the file.
- **Personal reveals.** `revealPersonal` in `config/connectors.json` (default `true`) turns on provider options that return personal emails and mobile or personal phones (Apollo `reveal_personal_emails`, and `reveal_phone_number` when `providers.apollo.webhookUrl` is set; Lusha phone reveal; ZoomInfo mobile and street). Their extra credits are in the estimate. Set it `false` to skip them.
- **Boundaries hold** (sec. 5.5): public or licensed sources only, nothing on minors, no real-time location, no breached or leaked data.

---

## 6. Section briefs

Every section in `room.json` may carry a brief, rendered as an "in one look" box:

```json
"brief": { "level": "Read first", "bullets": ["…", "…"], "hold": "The one thing to carry into the room." }
```

`level` is one of `Read first`, `Know it`, `Reference`, `Drill`. Two bullets, each under 25 words, plus one `hold` line.

---

## 7. Mode packs (section E, "The ask")

Pick one; combine for mixed meetings. Each pack adds pages and changes what the personas probe and what the practice bank drills. Files: `templates/skeleton/modes/<mode>/`.

### Interviewing
- `intake`: the posting line by line, the comp position, the process and rounds.
- `role-scan`: 8 to 17 comparable postings with term counts (must-have vs quirk).
- `technical-playbook`: the seat as a competent owner would describe it; the first 90 days.
- `case-shapes`: likely case and exercise types, mock cases in each interviewer's style.
- `process-intel`: candidate reports (Glassdoor, PrepLounge, Fishbowl, Reddit) tagged SNIPPET or VERIFIED, plus the recruiter guide and official sample cases.
- Rounds use the core `meeting-<n>` pages. Live helper: **off** (cards are prep, not live).

### Deal (buy, sell, raise, partner, sponsor, license)
- `their-deals`: every deal they have done, with size, structure, terms where public, who led it and how it ended. Their pattern in a table.
- `mandate-fit`: their criteria against our asset or offer, Strong / Partial / Gap per criterion.
- `term-map`: each term they will push on, our position, their likely position, the walk-away point and the trade we would accept.
- `batna`: our alternatives and theirs, and what each side loses if there is no deal.
- `decision-path`: who signs, the committee, timing, what has to be true for a yes, and the documents they will ask for.
- `objections`: their 25 most likely objections, each with the evidence and the answer.
- `numbers`: the model they will build of us; our numbers from the facts file only, every assumption flagged `[A]`.
- Live helper: **allowed** (the silent helper card format).

### Audit (diligence on a target, vendor or partner, or an internal review)
- `claims-register`: every claim they make about themselves, graded, with the document that would prove it.
- `request-list`: the document request list, ordered by risk and mapped to claims.
- `red-flags`: litigation, liens, UCC filings, regulator actions, key-person exits, review-site patterns, related parties, and the test to run on each.
- `controls-map`: process, owner, control, evidence expected, and the gap.
- `financial-reconstruction`: what the public record lets us rebuild (990s, EDGAR, state filings, permits), set against their story.
- `management-interview`: questions per person to test claims, with the answer that would worry us.
- Live helper: **allowed**, notes only.

### Pitch (sales, sponsorship, partnership)
- `their-priorities`: what they bought recently and why, their budget cycle, and who holds the budget.
- `incumbents`: who they buy from today, contract dates where public, and why they might switch.
- `fit-map`: their stated problem, our proof, and the case that matches it.
- `deck-brief`: the room, the audience, a 7-slide maximum, the number spine, and slide-by-slide questions per persona.
- `buyer-objections` and `buying-path`: as `objections` and `decision-path` in the deal pack, for a buyer.
- Live helper: **allowed**.

---

## 8. Org-type packs (added by detection at intake)

Intake classifies the counterparty; the matching pack adds the pages and sources specific to that kind of organisation. Files: `templates/skeleton/orgtypes/<type>/`.

| Type | Extra pages | Primary sources |
|---|---|---|
| `asset-owner` (foundation, endowment, pension, faith investor) | `mandate-and-screens`, `proxy-and-advocacy`, `accountability-reports` | 990s (ProPublica), IRS group rulings, annual reports, proxy filings (PX14A6G, 14a-8), pension board minutes, ESG and faith frameworks |
| `private-equity` (PE, VC, family office) | `portfolio`, `fund-history`, `exits` | Form D, Form ADV, LP disclosures (pension board minutes), portfolio sites, deal press |
| `public-company` | `segments`, `earnings-language`, `risk-factors` | EDGAR 10-K/10-Q, call transcripts, proxy |
| `consultancy` (services firm) | `client-cases`, `method`, `insights-index` | Sitemap crawl, white papers, webinars |
| `health-system` | `service-area`, `cms-and-quality`, `community-benefit` | CMS, 990 Schedule H, state certificate-of-need filings |
| `government` (agency, regulator) | `statute-and-authority`, `budget`, `procurement-history` | Statutes, budget books, USAspending, meeting minutes |
| `startup` | `founders`, `funding-rounds`, `product-and-traction` | Form D, funding press, the product itself, job posts |
| `energy` (energy and commodities) | `assets`, `regulatory-filings` | State commissions, EIA, FERC, permits |
| `other` | none | The core only |

---

## 9. Marking: one legend, enforced

**The form comes first.** Every room fills the same buckets (`config/form/`: core per person, core company, one pack per mode and org type, optional extras; the list is in `docs/form-buckets.md`). Facts are ledger rows (`rooms/<slug>/work/osint/*/ledger.jsonl`): the scripted pass writes them, agents hand in entries with `npm run entry`, and code grades every row with the two-source rule, so an agent cannot write Verified. Code computes each bucket's state (filled with grade and source, searched and empty, couldn't check, no tool yet) and renders it on its page and on the form page. AI judgement (persona verdict, drivers, summary, the line) is an entry that cites the ledger ids it rests on, labelled as AI judgement. Before the build, the form check (`npm run form -- <slug> --check`) fails a room with a required bucket left with no entry, an AI entry citing ids that do not exist, an empty Start here, or a selected pack with no file; `run-room` does not build it unless run with `--draft`. The grades below are the same for ledger rows and for anything written on pages.

**Fact grades** (the exact classes the build counts), in this order:

| Grade | Span | Shorthand | Means |
|---|---|---|---|
| verified | `<span class="grade verified">Verified</span>` | `{v}` | Read at the source during this build. |
| partly | `<span class="grade partly">Partly verified</span>` | `{p}` | Part of it confirmed at the source; the rest from a reliable secondary source. |
| weak | `<span class="grade weak">Weak</span>` | `{w}` | A single unconfirmed source, or the identity of the person or account not confirmed. Written down, never used as fact. |
| inference | `<span class="grade inference">Inference</span>` | `{i}` | Our reasoning, never phrased as fact. |
| none | `<span class="grade none">None found</span>` | `{n}` | Searched, nothing found. The line says what was searched (tool and exact query). A negative finding, not a fact; left out of the verified share. |
| not-public | `<span class="grade not-public">Not public</span>` | `{np}` | Exists but is not public (e.g. a private company's revenue). |
| unknown | `<span class="grade unknown">Unknown</span>` | `{u}` | Not searched yet, or could not be reached; the gap ledger says why. |

**Connector data** (sec. 5.6): a value from one licensed connector or import is `partly` (licensed, not yet confirmed at a public source). Two independent providers agreeing is still `partly`. It becomes `verified` only when the research stage reads it at a public source, and that source is cited. A provider is never the cited source of a verified line. Where providers disagree, the line says so and stays `partly` until a public source settles it.

Render expands the shorthands to the spans in both HTML and markdown pages. Weak information is always written, labelled weak; where there is none, the page says "None found" and what was searched. Nothing is left blank and no checklist row is omitted.

**Fit**: `Strong / Partial / Gap` only.

**Fill-ins**: `[FILL: …]` only, for what only our side can answer. Lint lists every one on the one card.

**Assumed numbers**: `[A]` after the figure: say it only as you would vouch for it.

**Sources**: `<a class="src" href="…">label</a>` on every factual line. No source means the line is graded `inference` or deleted.

**Headings**: bare `<h2>Title</h2>`, under 40 characters, so the jump bar does not truncate them.

**Page meta**: the build writes the as-of date and word count on every page. Each page opens with one `<p>` saying what was read to build it.

**Persona advice** is always written as "the <name> persona", never as the person.

---

## 10. Stages (the pipeline the prompts run)

| # | Stage | Who | Search budget | Output |
|---|---|---|---|---|
| 0 | **Intake**: parse the line (company, website domain, people, the ask), read `config/our-side.json`, detect org type, ask at most 3 questions only if missing (meeting date and deadlines, people, the ask); write `meetings[]` and `deadlines[]` into `room.json` and `intake.json` | orchestrator | 5 | `intake.json`, a new room from the skeleton |
| 1 | **Inventory**: what we already hold on them (prior rooms, notes, mail threads, the facts file) | 1 agent, offline | 0 | `INVENTORY.md` |
| 2 | **Harvest** (scripted): sitemap crawl and text extract; EDGAR, 990, Form D, ADV pulls; podcast and video transcripts; staff page and profile captures; Wayback captures of key pages | scripts plus 1 agent | 20 (curl is unlimited) | `corpus/` with an index and a term-count file |
| 2b | **Enrich** (licensed data and own exports): `npm run enrich -- <slug>` prints a credit estimate per provider and stops; with the user's yes, `--yes` fetches, normalises and merges with per-field provenance and lists conflicts (sec. 5.6) | script; the orchestrator asks for the yes | 0 (credits shown first) | `work/connectors/merged.json`, `conflicts.json`, `run.json` |
| 3 | **Research wave** (online): who they are; money and public financials; rules; outside view (partners, reviews, forums, news, domain and tech); org chart and people map; mode intel | 3 agents at a time | about 50 each | graded notes |
| 3a | **Scripted OSINT pass** (no AI): every module per person, with the company and its domain; the ledgers | script | 0 | `work/osint/<person>/` |
| 3b | **People OSINT** (online, cold): work the person's unfilled buckets and hand in entries; names first, then socials, personal life and interests, partner socials, LinkedIn deep read, education, writing, network, public record, financials, timeline and their circles, every checklist row run and logged in the OSINT log, one agent per person | 1 per person | about 50 each | notes per person, OSINT log rows |
| 3c | **Personas** (cold): the verdict and claims against the record, what drives them, the 11 sections, "How they think and behave" and own words, from 3b and the transcripts | 1 per person | about 15 each | `PERSONA - name.md`, `OWN WORDS - name.md` |
| 3d | **Mirror** (online, blind to the room): the 3b profile run on our side | 1 agent | about 30 | `MIRROR.md` |
| 4 | **Synthesis** (offline): translation, mode pack pages, banks, glossary, our-side comparison | 4 to 6 agents | 0 | notes |
| 5 | **Verification**: (a) re-fetch every source and recompute every figure; (b) coverage matrix of our prep against their library; (c) independent grader on the banks; (d) facts-file reconciliation; (e) re-run the OSINT log and mark new hits | 3 agents, different briefs | 40 | `ACCURACY REVIEW.md`, `GAP REVIEW.md`, fixes applied |
| 5b | **AI slots** (offline): judgement entries (persona verdict and drivers, company drivers, Start here) that cite ledger ids; persona slots cold | 1 per person plus 1 | 0 | ledger entries |
| 5c | **Form check** (code): required buckets, cites, Start here, packs; a failure stops the build unless `--draft` | script | 0 | `work/form.json` |
| 6 | **Render**: notes into `rooms/<slug>/room.json` and `pages/*.html` (narrative only; the build renders the form's buckets); lint; build; local preview | 1 agent plus build | 0 | the room |
| 7 | **One card and summary last**: written after everything else, aimed at the specific person in the room; the summary paragraph goes into `room.json` | orchestrator | 0 | `one-card`, `room.json.summary` |
| 8 | **Loop**: after each meeting, debrief within the hour, then reconciliation, the corrections log, a new meeting section, and an OSINT re-run before the next meeting | the person who was in the room gives notes | 20 | updated room |

`run-room` runs these in a fixed order for both engines, one fresh engine call per stage: scripted pass, stages 1 to 5, AI slots, form check, then lint and build.

**The only tasks for our side's person:**
1. Answer at most 3 intake questions (including the meeting date and deadlines, if missing).
2. Fill the `[FILL: …]` items.
3. Run the spoken drills.
4. Give debrief notes.
5. Say "publish".

---

## 11. Tiers and depth targets

**Light** (1 day, 10 to 14 pages plus the person pages): one-card, who-they-are, money, rules, people-map, per person persona + interests + names + socials + public-record + financials (the other person pages kept, each checklist row at least "Unknown: not searched in light tier"), duty-map plus 2 mode pages, osint-log, our-side (answer-bank only with the practice pack).
**Full** (1 to 3 days, 40+ pages): everything in the core, the mode pack and the org-type pack.

A room fails lint if it is under these targets, unless the gap ledger on `sources` explains why:

| Item | Full | Light |
|---|---|---|
| Pages | 40+ | 10+ |
| Meetings and deadlines in room.json | next meeting set; every known deadline | next meeting set |
| Summary paragraph in room.json | yes | yes |
| Sources cited | 150+ | 40+ |
| Share of fact lines graded verified or partly | 70%+ | 60%+ |
| Their documents indexed | all reachable | top 25 |
| Glossary terms | 40+ | 20+ |
| Form check | passes: required buckets answered, AI entries cite real ledger rows, Start here filled | passes |
| Filings bank instruments | 25+ (where they file) | 10+ |
| Persona per named person | 1, all 11 sections, 5+ own quotes, 10+ questions | 1 |
| Verdict and drivers per persona | the verdict (Proven / Mixed / Unproven), 3+ claims against the record, all four drivers graded | the verdict, 1+ claim, four drivers |
| Checklist rows per person page | every row filled: found, weak or None found with the search | every row: at least unknown |
| Personal life per person | at least 8 personal life rows checked (counted from the OSINT log's checks plus the findings on the page), the page showing findings only, each with evidence and signal strength | at least 8 rows checked |
| Socials per person | every platform in 4.1 checked and logged, found or not | LinkedIn, X, personal site, YouTube |
| Names per person | every kind checked; every name re-run through the other searches | official name plus one variant |
| Education, writing, financials per person | every row checked | financials checked |
| Public record per person | every registry in 4.1, each logged with its result | registries, courts, donations |
| Timeline per person | 15+ dated rows | 8+ |
| Own-words transcripts | all audio and video found | the best one |
| Review sites checked | 5+ | 3+ |
| Forums checked | 4+ | 2+ |
| Partners listed | 15+ | 5+ |
| OSINT log rows | 150+ | 40+ |
| Mirror | full profile on our side | socials and record |
| Answer bank (practice pack only) | 20+ | 10+ |
| Mock transcripts (practice pack only) | 1 | 0 |
| Open questions per "Them" page | 5+ | 3+ |

---

## 12. Verification and the debrief loop

- **Accuracy**: a separate agent re-fetches every source link and recomputes every number; each line is confirmed, wrong (with the correct value and source) or unreachable. It applies no fixes.
- **Coverage**: a matrix of their whole library (topics by share) against our pages, so the prep is not built around one theme while they talk about others.
- **Grading**: the banks are graded against each persona's "How they judge" and real published examples, never by the agent that wrote them.
- **Facts**: every line about our side is checked against the facts file.
- **OSINT re-run**: before each meeting the OSINT log is re-run; new hits are marked and folded in.
- **Corrections**: every change is logged on `corrections-log` (date, was, now, why).
- **Debrief**: within the hour of each meeting: what they asked, what landed, what did not, new facts. Then `reconciliation` (confirmed / corrected / new / still open), corrections across the room, a new `meeting-<n>` section, personas and the one card re-aimed, and a rebuild.

A room is done only when the build is published to the private site and its as-of date matches the notes.

---

## 13. Engine

One renderer: `room.json` plus `pages/*.html`, built by `scripts/build.mjs`, behind the HMAC gate (`ROOM_PASSWORD_<SLUG>`). Live rooms are kept in a private fork.

`room.json` core fields: `slug`, `title`, `subtitle`, `summary` (one paragraph, sec. 2), `asOf`, `accent`, `counterparty`, `people[]` (`name`, `title`, `slug`), `modes[]`, `orgType`, `ourSide`, `notice`, `footer`, `meetings[]` (`date`, `time`, `title`, `who`, `format`, `length`), `deadlines[]` (`date`, `title`, `kind`, `done`), `heroes[]`, `process[]`, `sections[]` (each with a `group`, sec. 3, and an optional `brief`, sec. 6; person pages carry a `part`). A section marked `"perPerson": true` is repeated once per person, with `__PERSON__`, `__PERSON_SLUG__` and `__COMPANY__` filled in.

Skeleton layout:

```
templates/skeleton/
  core/room.json                 base room.json with the core sections
  core/pages/<id>.html           company-level core pages
  core/person/<id>.html          per-person pages; room id is <id>-<person-slug>
  modes/<mode>/pack.json         interviewing, deal, audit, pitch
  modes/<mode>/pages/<id>.html
  orgtypes/<type>/pack.json      asset-owner, private-equity, public-company, consultancy,
  orgtypes/<type>/pages/<id>.html  health-system, government, startup, energy, other
```

The Enrich stage is `scripts/enrich.mjs`, with one adapter per provider in `scripts/connectors/<id>.mjs` (`id`, `name`, `kind` api / file / mcp, `envKeys[]`, `fields[]`, `docsUrl`, `estimateCredits(intake, opts)`, `fetchPerson`, `fetchCompany`) and one normalised schema (`scripts/connectors/schema.mjs`: contacts kept and labelled, company addresses with a role); `merge.mjs` marks contacts that match `work/business-records.json` as business of record. The person pages linkedin, education, network and financials and the company pages public-financials, people-map and org-chart carry a "Connector findings" checklist (Field, Value, Provider, Grade); the person linkedin page and the company who-they-are page carry a "Contact routes" table (Value, Kind, Business of record?, Source, Grade).

Lint (`npm run lint`) enforces sec. 9 and sec. 11, including ungraded checklist rows, personal life completeness counted against the OSINT log (not the visible rows), and the verdict, a graded claim and the four drivers on every filled persona; markdown pages are converted at build time and the shorthands `{v}` `{p}` `{w}` `{i}` `{n}` `{np}` `{u}` expanded. A room.json or pack that still names the old `footprint-<person>` id is composed from `socials`. Still to build: optional page types for a codebase floorplan and a short course.

---

## 14. Defaults

- The input line names the other side; our side always comes from `config/our-side.json`.
- Live helper (the companion, sec. 15): off for interviews, allowed for deals, audits (notes only) and pitches. Never records without everyone's consent.
- Contact scrub: contact details only in the "Contact routes" tables, each labelled with its kind, source and whether it is the business contact of record; nothing on minors, no real-time location; the comp ask and anything from `config/` stay out of rooms that may be shared beyond our side.
- A room is never published or deployed without an explicit "publish".

---

## 15. The companion (live helper)

`/<slug>/assist.html`, behind the room gate, with its functions at `/<slug>/api/*` (the gate covers them). Built for every room by the build; it reads only that room (`netlify/functions/corpus/<slug>.json`, with the people, meetings and summary).

| Lane | Model (env) | Job | Output |
|---|---|---|---|
| Transcription | `ASSIST_STT_MODEL` (Gemini) | 8-second audio chunks to text; the phone's own speech recognition if the server fails | raw segments |
| Fast | `ASSIST_FAST_MODEL`, default `claude-opus-5-5`, effort low | Clean the rolling transcript, guess the speaker, detect questions and push-backs | a quick card within seconds: the question, one line to open with, 2 or 3 facts each with its page |
| Deep | `ASSIST_DEEP_MODEL`, default `claude-fable-5-2`, effort medium | For each detected question, or on Think: read the whole room (a cached system prompt) | streamed: best answer in our words, evidence from the room, what this persona is testing, a question to ask back, the risk to avoid |

The page: quick cards on top with pin (hold the card, new ones wait) and next; the deep answer below; a typed question box (quick card or Think); a silent mode (no vibration, no motion, dimmed); the session (transcript, cards, deep answers) saved on the device only, exported as markdown into the meeting page's debrief (P10). Both lanes opt in to server-side refusal fallbacks (`ASSIST_REFUSAL_FALLBACK=off` drops them).

**Consent.** The microphone stays off until the user confirms that everyone in the conversation has agreed to be recorded and transcribed. Two-party (all-party) consent states, and many countries, require it; the strictest rule of any participant's location applies. Without consent the companion runs on typed questions only. The `companion` page records, per meeting, where the other side is and whether consent was given.

