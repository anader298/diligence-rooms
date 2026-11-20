# The form: bucket list (draft for review)

Every room fills the same buckets. The intake picks the packs: the two core packs always, one
pack per mode, one for the org type, and the practice pack only when asked for. Each bucket ends
in one state, computed by code from the ledgers: **Filled** (with its grade and source),
**Searched, nothing found**, **Couldn't check** (blocked, no key, no domain, not run) or **No tool
yet** (no module feeds it and nobody handed in an entry).

How to read the table: *Fed by* lists the ledger variables (from `config/osint-variables.json`) that
fill the bucket, an intake field, or "AI entry" for judgement slots. "no tool yet" means no script
feeds it today: an agent hands in an entry (`npm run entry`), and the hint says where to look.
*Req*: `yes` = the form check fails if nothing (not even a "none found") is handed in; `start` =
a Start here field, which must be filled before the room builds.

Regenerate this file after editing a pack: `npm run form -- --table`.

## core-company (51 buckets)

## core-company (51 buckets)

The company and the meeting. One set per room. Company rows come from every person's scripted pass plus work/osint/_company.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| The ask in one sentence | `start.ask` | one-card | Start here | fact | intake `goal` | start |
| Next meeting | `start.meeting` | one-card | Start here | fact | intake `meetingDate` |  |
| Who decides, and on what | `start.who_decides` | one-card | Start here | ai | AI entry citing ledger ids | start |
| The line | `start.line` | one-card | Start here | ai | AI entry citing ledger ids | start |
| Summary of the room | `start.summary` | one-card | Start here | ai | AI entry citing ledger ids | start |
| Numbers to hold | `start.numbers` | one-card | Start here | ai | AI entry citing ledger ids |  |
| Company | `co.name` | who-they-are | Identity | fact | intake `company` | yes |
| Website | `co.website` | who-they-are | Identity | fact | intake `domain` |  |
| Identifiers (CIK, LEI, Wikidata, registry) | `co.identifiers` | who-they-are | Identity | list | `co.identifiers` | yes |
| Parent and subsidiaries | `co.structure` | who-they-are | Identity | list | `co.structure` |  |
| National registry record | `co.registry` | who-they-are | Identity | fact | `co.registry` |  |
| Named growth priority | `co.growth_line` | who-they-are | Where they are going | fact | `co.growth_line` |  |
| M&A and partnerships | `co.ma` | who-they-are | Where they are going | list | `co.ma` (no module); **no tool yet** |  |
| Budget cycle | `co.budget_cycle` | who-they-are | Where they are going | fact | `co.budget_cycle` (no module); **no tool yet** |  |
| Competitors | `co.competitors` | who-they-are | Market | list | `co.competitors` (no module); **no tool yet** |  |
| What drives the company | `co.drivers` | who-they-are | AI judgement | ai | AI entry citing ledger ids | yes |
| Reported financials | `fin.reported` | public-financials | Company checklist | list | `co.facts` | yes |
| Last quarter | `fin.quarter` | public-financials | Company checklist | fact | `co.quarter` |  |
| ARR | `fin.arr` | public-financials | Company checklist | fact | `co.arr` |  |
| KPIs | `fin.kpis` | public-financials | Company checklist | list | `co.kpis` |  |
| Segments | `fin.segments` | public-financials | Company checklist | list | `co.segments` |  |
| Against peers | `fin.peers` | public-financials | Company checklist | list | `co.peers` |  |
| Cash and debt | `fin.cash` | public-financials | Company checklist | fact | `co.cash` |  |
| Funding | `fin.funding` | public-financials | Company checklist | list | entries only; **no tool yet** (look: Form D, press releases, the company's own announcements) |  |
| Revenue signals (private) | `fin.private_rev` | public-financials | Company checklist | list | `co.private_rev` (no module); **no tool yet** |  |
| Top holders | `money.owners` | money | Owners | list | `co.owners` |  |
| Insider filers | `money.insiders` | money | Owners | list | `co.insiders` (no module); **no tool yet** |  |
| Executive pay table | `money.exec_pay` | money | Owners | list | `co.exec_pay` |  |
| Customer concentration | `money.concentration` | money | Risk | fact | `co.concentration` (no module); **no tool yet** |  |
| Headcount check (benefit plans) | `money.headcount` | money | Risk | list | `co.benefit_plans` |  |
| Deal size (estimate) | `est.deal_size` | money | Estimates | fact | `est.deal_size`, `fit.deal_size` (no module) |  |
| Decision window (estimate) | `est.window` | money | Estimates | fact | `est.decision_window`, `fit.timing` (no module) |  |
| Growth of their area (estimate) | `est.growth` | money | Estimates | fact | `est.seg_growth` |  |
| Recent filings | `filings.recent` | filings-bank | Filings | list | `co.filings` |  |
| Litigation | `rules.litigation` | rules | Rules and record | list | `co.legal` |  |
| Environmental and safety enforcement | `rules.enforcement` | rules | Rules and record | list | `co.enforcement` |  |
| Government contracts and lobbying | `rules.gov` | rules | Rules and record | list | `co.gov`, `politics.company_pac` |  |
| Regulators and mandate | `rules.regulators` | rules | Rules and record | list | entries only; **no tool yet** (look: The regulator's own register; the company's licences page) |  |
| Customers, suppliers, advisors, lenders | `outside.partners` | partners | Outside view | list | entries only; **no tool yet** (look: Case studies, logo walls, filings (auditor, counsel), UCC secured parties) |  |
| Employee view | `outside.reviews` | reviews | Outside view | list | `co.reviews` (no module); **no tool yet** |  |
| Forum threads | `outside.forums` | forums | Outside view | list | entries only; **no tool yet** |  |
| Company news, last 90 days | `outside.news` | news | Outside view | list | `news.company` |  |
| Digital footprint | `outside.domains` | domain-and-tech | Domain and tech | list | `co.domains` |  |
| Tools they run (DNS, certificates) | `outside.stack` | domain-and-tech | Domain and tech | list | `fit.problem` |  |
| Open roles | `outside.hiring` | domain-and-tech | Domain and tech | list | `co.hiring` |  |
| Leadership team | `org.leadership` | org-chart | Organisation | list | `co.leadership` | yes |
| Exec changes, 24 months | `org.exec_changes` | org-chart | Organisation | list | `co.exec_changes` |  |
| Overlaps with our side | `people.overlaps` | people-map | Network | list | `net.overlaps` (no module); **no tool yet** |  |
| Warm paths in | `people.warm_paths` | people-map | Network | list | `net.warm_paths` (no module); **no tool yet** |  |
| Who signs (job posts, filings) | `people.signs` | people-map | Decision | fact | `fit.who_buys` (no module); **no tool yet** |  |
| Who decides, who influences | `people.who_decides` | people-map | AI judgement | ai | AI entry citing ledger ids |  |

## core-person (110 buckets)

Each person across the table, repeated per person. Repeated for every person in the intake. Page ids get the person suffix (socials -> socials-<person slug>).

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Other names and spellings | `names.aliases` | names | Names | list | `names.aliases` | yes |
| Handle pattern | `names.handles` | names | Names | fact | `social.handles` |  |
| Namesakes to exclude | `names.namesakes` | names | Names | list | entries only; **no tool yet** (look: Same name, different person: separate by city, employer, middle initial) |  |
| LinkedIn | `socials.linkedin` | socials | Accounts | fact | `social.accounts` (match `linkedin\.com`) |  |
| X | `socials.x` | socials | Accounts | fact | `social.accounts` (match `(^/[/.])(x/twitter)\.com`) |  |
| Instagram | `socials.instagram` | socials | Accounts | fact | `social.accounts` (match `instagram\.com`) |  |
| Facebook | `socials.facebook` | socials | Accounts | fact | `social.accounts` (match `facebook\.com`) |  |
| Threads | `socials.threads` | socials | Accounts | fact | `social.accounts` (match `threads\.(net/com)`) |  |
| Bluesky | `socials.bluesky` | socials | Accounts | fact | `social.accounts` (match `bsky\.(app/social)`) |  |
| TikTok | `socials.tiktok` | socials | Accounts | fact | `social.accounts` (match `tiktok\.com`) |  |
| YouTube | `socials.youtube` | socials | Accounts | fact | `social.accounts` (match `youtube\.com/youtu\.be`) |  |
| Reddit | `socials.reddit` | socials | Accounts | fact | `social.accounts` (match `reddit\.com`) |  |
| GitHub | `socials.github` | socials | Accounts | fact | `social.accounts` (match `github\.com`) |  |
| Substack | `socials.substack` | socials | Accounts | fact | `social.accounts` (match `substack\.com`) |  |
| Medium | `socials.medium` | socials | Accounts | fact | `social.accounts` (match `medium\.com`) |  |
| Personal site or link page | `socials.site` | socials | Accounts | fact | `social.linkpage` |  |
| Candidate accounts (scored) | `socials.candidates` | socials | Identity | list | `social.candidates` |  |
| Verified links and proofs | `socials.proofs` | socials | Identity | list | `social.proofs` |  |
| Most active platform | `socials.most_active` | socials | What they post | fact | `social.most_active` |  |
| Post themes, last 12 months | `socials.themes` | socials | What they post | fact | `social.themes` |  |
| Tone and manner | `socials.tone` | socials | What they post | fact | `social.tone` (no module); **no tool yet** |  |
| Most-liked posts | `socials.top_posts` | socials | What they post | list | `social.top_posts` |  |
| What they say about work | `socials.work_posts` | socials | What they post | list | `social.work_posts` |  |
| Developer community activity | `socials.dev` | socials | What they post | list | `social.dev_activity` |  |
| Avatar matches | `pics.avatars` | socials | Pictures | list | `pic.avatar_matches` |  |
| Event photos | `pics.events` | socials | Pictures | list | `pic.event_photos` (no module); **no tool yet** |  |
| Image search results | `pics.search` | socials | Pictures | list | `pic.image_results` |  |
| Reverse image search on the headshot | `pics.reverse` | socials | Pictures | list | `pic.reverse` |  |
| Home metro | `life.home` | interests | Home and places | fact | `place.home_metro` | yes |
| Second home (region) | `life.second_home` | interests | Home and places | fact | `place.second_home` (no module); **no tool yet** |  |
| Recurring trips | `life.travel` | interests | Home and places | list | `place.travel` (no module); **no tool yet** |  |
| Spouse or partner | `life.partner` | interests | Family | fact | `family.partner` |  |
| Children (a count, never names) | `life.kids` | interests | Family | fact | `family.kids` |  |
| Sports played or coached | `life.sports` | interests | Sports and outdoors | list | `hobby.sports` |  |
| Races and fitness | `life.endurance` | interests | Sports and outdoors | list | `hobby.endurance` |  |
| Teams they follow | `life.teams` | interests | Sports and outdoors | list | `hobby.teams` |  |
| Golf, sailing, hunting, fishing | `life.outdoors` | interests | Sports and outdoors | list | entries only; **no tool yet** (look: Club handicap pages, regatta results, tournament rosters) |  |
| Food and drink | `life.food` | interests | Tastes | list | `hobby.cooking` |  |
| Books, film, music | `life.media` | interests | Tastes | list | `hobby.media` |  |
| Games (chess and similar) | `life.games` | interests | Tastes | list | `hobby.games` |  |
| Cars and machines | `life.cars` | interests | Tastes | list | entries only; **no tool yet** (look: Posts, club rosters, track-day results) |  |
| Clubs (country, alumni, city) | `life.clubs` | interests | Circles | list | entries only; **no tool yet** (look: Club newsletters and rosters, alumni-club pages) |  |
| Galas and fundraisers | `life.galas` | interests | Circles | list | `cause.events` (no module); **no tool yet** |  |
| Faith or community groups (only if public) | `life.faith` | interests | Circles | list | entries only; **no tool yet** |  |
| How they spend weekends | `life.weekends` | interests | Circles | list | entries only; **no tool yet** (look: Podcast small talk, posts, interviews ("outside work, I ...")) |  |
| Partner's public accounts | `partner.accounts` | partner-socials | Partner | list | entries only; **no tool yet** (look: Public posts only; nothing on minors; never raised in the meeting) |  |
| Business partners and co-founders | `partner.business` | partner-socials | Partner | list | entries only; **no tool yet** |  |
| Most-tagged friends | `partner.circle` | partner-socials | Partner | list | `family.close_circle` |  |
| Title | `seat.title` | linkedin | The seat | fact | `role.title` | yes |
| In the seat since | `seat.start` | linkedin | The seat | fact | `role.start` |  |
| Reports to | `seat.reports_to` | linkedin | The seat | fact | `role.reports_to` |  |
| Direct reports | `seat.directs` | linkedin | The seat | list | `role.directs` |  |
| Team size | `seat.team_size` | linkedin | The seat | fact | `role.team_size` (no module), `est.team_size` |  |
| Revenue they own | `seat.revenue` | linkedin | The seat | fact | `role.revenue` (no module); **no tool yet** |  |
| Budget they control | `seat.budget` | linkedin | The seat | fact | `role.budget` (no module), `est.budget` |  |
| Their stated mandate | `seat.mandate` | linkedin | The seat | fact | `role.mandate` |  |
| Career timeline | `career.timeline` | linkedin | Career | list | `career.timeline` | yes |
| Signature wins | `career.wins` | linkedin | Career | list | `career.wins` |  |
| Wikipedia article | `career.wikipedia` | linkedin | Career | fact | `bio.wikipedia` |  |
| Certifications and volunteer roles | `career.certs` | linkedin | Career | list | entries only; **no tool yet** (look: LinkedIn under our own account or our export; never scraped) |  |
| Degrees and schools | `edu.degrees` | education | Education | list | `career.education` | yes |
| Honours, awards, scholarships | `edu.honours` | education | Education | list | entries only; **no tool yet** (look: Commencement programmes, honours lists, student press) |  |
| Clubs, societies, athletics | `edu.clubs` | education | Education | list | entries only; **no tool yet** (look: Athletics rosters, yearbooks, alumni magazines) |  |
| Bylines and posts | `writing.bylines` | writing | Writing | list | `voice.writing` |  |
| Books (as author) | `writing.books` | writing | Writing | list | `voice.books` |  |
| Publications and research | `writing.research` | writing | Writing | list | `career.publications` |  |
| Public code | `writing.code` | writing | Writing | list | `career.code` |  |
| Quotes in releases and calls | `words.quotes` | own-words | Own words | list | `voice.quotes` |  |
| Talks and podcasts | `words.talks` | own-words | Own words | list | `voice.talks` |  |
| Talk and interview transcripts | `words.transcripts` | own-words | Own words | list | `voice.transcripts` |  |
| Their words (top terms) | `words.terms` | own-words | Own words | fact | `voice.terms` (no module); **no tool yet** |  |
| What they are judged on | `words.priorities` | own-words | Own words | list | `voice.priorities` |  |
| Board seats (company and nonprofit) | `network.boards` | network | Network | list | `cause.boards` |  |
| Co-founders, co-investors, co-directors | `network.cofounders` | network | Network | list | entries only; **no tool yet** |  |
| Prior colleagues who overlapped | `network.colleagues` | network | Network | list | entries only; **no tool yet** |  |
| Links to the others in the room | `network.room_links` | network | Network | list | entries only; **no tool yet** |  |
| Company registries (officer roles) | `record.officer_roles` | public-record | Registries | list | entries only; **no tool yet** (look: OpenCorporates and state registries under every name) |  |
| Court cases | `record.courts` | public-record | Registries | list | `rec.courts` | yes |
| State and county courts | `record.state_courts` | public-record | Registries | list | entries only; **no tool yet** (look: State portals; separate namesakes) |  |
| Liens, judgments and UCC | `record.liens` | public-record | Registries | list | entries only; **no tool yet** |  |
| Patents (as inventor) | `record.patents` | public-record | Registries | list | `career.patents` |  |
| Trademarks | `record.trademarks` | public-record | Registries | list | entries only; **no tool yet** |  |
| Professional licences | `record.licences` | public-record | Registries | list | `career.licenses` |  |
| Regulatory disclosures (FINRA, SEC) | `record.disclosures` | public-record | Registries | list | `rec.disclosures` |  |
| Sanctions and exclusions | `record.sanctions` | public-record | Registries | list | `rec.sanctions`, `rec.sanctions_detail` | yes |
| Registered lobbyist or foreign agent | `record.lobbying` | public-record | Registries | list | `politics.person_lobbying` |  |
| Bio history (Wayback) | `record.bio_history` | public-record | History | list | `place.web_archive` |  |
| Document metadata | `record.doc_metadata` | public-record | History | list | `doc.metadata` |  |
| Shares held | `money.holdings` | financials | Money | fact | `money.holdings` |  |
| Insider trades | `money.trades` | financials | Money | list | `money.trades` |  |
| Pay (disclosed, or an estimate) | `money.pay` | financials | Money | fact | `money.comp`, `est.comp` |  |
| Political donations | `money.donations` | financials | Money | list | `politics.donations`, `cause.political` |  |
| Companies owned and fund roles | `money.companies` | financials | Money | list | entries only; **no tool yet** (look: Form D related persons, Form ADV, state registries) |  |
| 990s naming them | `money.nonprofit_990` | financials | Money | list | entries only; **no tool yet** (look: ProPublica Nonprofit Explorer, Part VII and Schedule J) |  |
| Articles that mention them | `news.mentions` | timeline | In the news | list | `news.articles` |  |
| Attention spikes | `news.attention` | timeline | In the news | list | `news.attention` |  |
| Article text (extracted) | `news.article_text` | timeline | In the news | list | `news.article_text` |  |
| Official headshot | `persona.headshot` | persona | Identity | fact | `pic.headshot` |  |
| Verdict: Proven, Mixed or Unproven | `persona.verdict` | persona | AI judgement | ai | AI entry citing ledger ids | yes |
| Claims against the record | `persona.claims` | persona | AI judgement | ai | AI entry citing ledger ids |  |
| What drives them: financial | `persona.drive_financial` | persona | AI judgement | ai | AI entry citing ledger ids | yes |
| What drives them: social | `persona.drive_social` | persona | AI judgement | ai | AI entry citing ledger ids | yes |
| What drives them: commercial | `persona.drive_commercial` | persona | AI judgement | ai | AI entry citing ledger ids | yes |
| What drives them: technical | `persona.drive_technical` | persona | AI judgement | ai | AI entry citing ledger ids | yes |
| How they judge | `persona.judges` | persona | AI judgement | ai | AI entry citing ledger ids |  |
| What they will probe | `persona.probe` | persona | AI judgement | ai | AI entry citing ledger ids |  |
| Red flags (what would lose them) | `persona.red_flags` | persona | AI judgement | ai | AI entry citing ledger ids |  |
| Rapport hooks | `persona.rapport` | persona | AI judgement | ai | AI entry citing ledger ids |  |
| Their circles: clubs, events, conferences | `relate.circles` | relate | Circles | list | entries only; **no tool yet** (look: Rosters, results pages, speaker lists) |  |
| Never raise | `relate.never` | relate | AI judgement | ai | AI entry citing ledger ids |  |

## extras/practice (2 buckets)

Practice (optional).

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| The questions they will most likely ask | `practice.top_questions` | answer-bank | AI judgement | ai | AI entry citing ledger ids |  |
| The question we fear most | `practice.feared` | push-back-gym | AI judgement | ai | AI entry citing ledger ids |  |

## modes/audit (9 buckets)

Audit.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Claims they make about themselves | `audit.claims` | claims-register | Claims | list | entries only; **no tool yet** (look: Their site, decks, press releases, filings) | yes |
| Litigation | `audit.litigation` | red-flags | Record | list | `co.legal` |  |
| Regulator actions | `audit.enforcement` | red-flags | Record | list | `co.enforcement` |  |
| Sanctions screen | `audit.sanctions` | red-flags | Record | list | `rec.sanctions_detail` |  |
| Liens and UCC | `audit.liens` | red-flags | Record | list | entries only; **no tool yet** |  |
| Key-person exits | `audit.exits` | red-flags | Record | list | `co.exec_changes` |  |
| Related parties | `audit.related` | red-flags | Record | list | entries only; **no tool yet** |  |
| Reconstructed financials | `audit.financials` | financial-reconstruction | Numbers | list | `co.facts`, `co.quarter` |  |
| Red-flag read | `audit.read` | red-flags | AI judgement | ai | AI entry citing ledger ids | yes |

## modes/deal (8 buckets)

Deal.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Their past deals | `deal.history` | their-deals | Deals | list | `co.ma` (no module); **no tool yet** | yes |
| Their deal pattern | `deal.pattern` | their-deals | AI judgement | ai | AI entry citing ledger ids |  |
| Who signs, the committee, documents | `deal.decision_path` | decision-path | Decision | list | entries only; **no tool yet** (look: Board minutes, filings naming approvers, press on past approvals) |  |
| Decision window (estimate) | `deal.window` | decision-path | Decision | fact | `est.decision_window` |  |
| Deal size (estimate) | `deal.size` | numbers | Numbers | fact | `est.deal_size`, `fit.deal_size` (no module) |  |
| Their mandate criteria | `deal.mandate` | mandate-fit | Fit | list | entries only; **no tool yet** |  |
| Alternatives, both sides | `deal.batna` | batna | AI judgement | ai | AI entry citing ledger ids |  |
| Likely objections | `deal.objections` | objections | AI judgement | ai | AI entry citing ledger ids |  |

## modes/interviewing (6 buckets)

Interviewing.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Rounds and format | `iv.process` | process-intel | Process | list | entries only; **no tool yet** (look: Glassdoor, PrepLounge, Fishbowl, Reddit; the recruiter guide) | yes |
| Candidate and employee reports | `iv.reports` | process-intel | Process | list | `co.reviews` (no module); **no tool yet** |  |
| Comparable postings | `iv.postings` | role-scan | Role | list | `co.hiring` |  |
| What the role needs | `iv.read` | role-scan | AI judgement | ai | AI entry citing ledger ids |  |
| Case and exercise types | `iv.cases` | case-shapes | Cases | list | entries only; **no tool yet** |  |
| What each interviewer judges | `iv.judges` | case-shapes | AI judgement | ai | AI entry citing ledger ids |  |

## modes/pitch (11 buckets)

Pitch.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Their problem we solve | `pitch.problem` | fit-map | Fit | list | `fit.problem` |  |
| Deal size (estimate) | `pitch.deal_size` | fit-map | Fit | fact | `fit.deal_size` (no module), `est.deal_size` |  |
| Fit: Strong, Partial or Gap | `pitch.fit` | fit-map | AI judgement | ai | AI entry citing ledger ids | yes |
| Who signs | `pitch.who_buys` | buying-path | Buying path | fact | `fit.who_buys` (no module); **no tool yet** |  |
| Timing | `pitch.timing` | buying-path | Buying path | fact | `fit.timing` (no module), `est.decision_window` |  |
| Budget cycle | `pitch.budget_cycle` | buying-path | Buying path | fact | `co.budget_cycle` (no module); **no tool yet** |  |
| Their stated priorities | `pitch.priorities` | their-priorities | Priorities | list | `co.growth_line` |  |
| Recent purchases | `pitch.purchases` | their-priorities | Priorities | list | entries only; **no tool yet** (look: Vendor case studies naming them, procurement notices, press) |  |
| Hiring as a buying signal | `pitch.hiring` | their-priorities | Priorities | list | `co.hiring` |  |
| Incumbent vendors and contract dates | `pitch.incumbents` | incumbents | Incumbents | list | entries only; **no tool yet** (look: Vendor logo walls, job posts naming tools, DNS records) |  |
| Buyer objections | `pitch.objections` | buyer-objections | AI judgement | ai | AI entry citing ledger ids |  |

## orgtypes/asset-owner (3 buckets)

Asset owner.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Mandate and screens | `ao.mandate` | mandate-and-screens | Mandate | list | entries only; **no tool yet** |  |
| Accountability reports | `ao.reports` | accountability-reports | Reports | list | `co.filings` |  |
| Proxy voting and advocacy | `ao.proxy` | proxy-and-advocacy | Advocacy | list | entries only; **no tool yet** |  |

## orgtypes/consultancy (3 buckets)

Consultancy.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Client cases | `cs.cases` | client-cases | Cases | list | entries only; **no tool yet** |  |
| Insights and papers | `cs.insights` | insights-index | Insights | list | `voice.writing` |  |
| Their method | `cs.method` | method | AI judgement | ai | AI entry citing ledger ids |  |

## orgtypes/energy (2 buckets)

Energy.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Assets | `en.assets` | assets | Assets | list | entries only; **no tool yet** |  |
| Regulatory filings and enforcement | `en.filings` | regulatory-filings | Filings | list | `co.filings`, `co.enforcement` |  |

## orgtypes/government (3 buckets)

Government.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Budget | `gov.budget` | budget | Budget | list | entries only; **no tool yet** |  |
| Procurement history | `gov.procurement` | procurement-history | Procurement | list | `co.gov` |  |
| Statute and authority | `gov.statute` | statute-and-authority | Authority | list | entries only; **no tool yet** |  |

## orgtypes/health-system (3 buckets)

Health system.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| CMS quality ratings | `hs.quality` | cms-and-quality | Quality | list | entries only; **no tool yet** |  |
| Community benefit (990 Schedule H) | `hs.community` | community-benefit | Community | list | `co.facts` |  |
| Service area | `hs.area` | service-area | Area | list | entries only; **no tool yet** |  |

## orgtypes/other (0 buckets)

Other.

No buckets yet: add lines to the JSON file.

## orgtypes/private-equity (5 buckets)

Private equity.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Funds and vintages | `pe.funds` | fund-history | Funds | list | entries only; **no tool yet** (look: Form D, Form ADV, LP reports from public pensions) | yes |
| Form D and ADV filings | `pe.filings` | fund-history | Funds | list | `co.filings` |  |
| Portfolio companies | `pe.portfolio` | portfolio | Portfolio | list | `co.structure` |  |
| Exits | `pe.exits` | exits | Exits | list | `co.ma` (no module); **no tool yet** |  |
| Their pattern | `pe.pattern` | exits | AI judgement | ai | AI entry citing ledger ids |  |

## orgtypes/public-company (6 buckets)

Public company.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Segment results | `pub.segments` | segments | Segments | list | `co.segments` | yes |
| Last quarter | `pub.quarter` | segments | Segments | fact | `co.quarter` |  |
| Against peers | `pub.peers` | segments | Segments | list | `co.peers` |  |
| What management says on calls | `pub.calls` | earnings-language | Calls | list | `voice.quotes`, `voice.priorities` |  |
| Risk factors and litigation | `pub.risks` | risk-factors | Risks | list | `co.legal` |  |
| Top holders | `pub.owners` | risk-factors | Risks | list | `co.owners` |  |

## orgtypes/startup (6 buckets)

Startup.

| Bucket | Id | Page | Group | Kind | Fed by | Req |
|---|---|---|---|---|---|---|
| Founders | `st.founders` | founders | Founders | list | `co.leadership` |  |
| Funding rounds | `st.rounds` | funding-rounds | Funding | list | entries only; **no tool yet** (look: Form D, press releases, investor portfolio pages) | yes |
| Investors | `st.investors` | funding-rounds | Funding | list | `co.owners` |  |
| Traction claims | `st.traction` | product-and-traction | Traction | list | `co.kpis`, `co.arr` |  |
| Hiring pace | `st.hiring` | product-and-traction | Traction | list | `co.hiring` |  |
| Web footprint | `st.footprint` | product-and-traction | Traction | list | `co.domains` |  |

