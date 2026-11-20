// Shared helpers for the person modules (10-39): name and handle variants, anchor checks,
// search-result parsers and keyword rules. Pure functions, no network, so tests can cover them.

import { normName, nameIn, stripTags } from "./core.mjs";

export { normName, nameIn, stripTags };

/** Common English nicknames, both ways. Used for name matching and handle variants. */
const NICK = {
  richard: ["rick", "rich", "dick"], robert: ["rob", "bob", "bobby"], william: ["will", "bill", "billy"],
  james: ["jim", "jimmy", "jamie"], john: ["jack", "johnny"], joseph: ["joe", "joey"], michael: ["mike", "mick"],
  thomas: ["tom", "tommy"], christopher: ["chris"], daniel: ["dan", "danny"], matthew: ["matt"], anthony: ["tony"],
  david: ["dave"], steven: ["steve"], stephen: ["steve"], andrew: ["andy", "drew"], edward: ["ed", "eddie", "ted"],
  gabriel: ["gabe"], benjamin: ["ben"], samuel: ["sam"], alexander: ["alex"], nicholas: ["nick"], jonathan: ["jon"],
  timothy: ["tim"], gregory: ["greg"], patrick: ["pat"], kenneth: ["ken"], ronald: ["ron"], donald: ["don"],
  charles: ["charlie", "chuck"], elizabeth: ["liz", "beth", "betsy"], katherine: ["kate", "katie", "kathy"],
  catherine: ["kate", "cathy"], jennifer: ["jen", "jenny"], margaret: ["maggie", "peggy", "meg"], rebecca: ["becky"],
  susan: ["sue"], deborah: ["deb", "debbie"], patricia: ["pat", "trish"], victoria: ["vicky", "tori"],
  christine: ["chris"], alexandra: ["alex"], samantha: ["sam"], kimberly: ["kim"], jessica: ["jess"],
};

export function nameParts(name) {
  const parts = normName(name).split(" ").filter((p) => p.length > 1 && !/^(jr|sr|ii|iii|iv|phd|md|mba)$/.test(p));
  return { first: parts[0] || "", last: parts.at(-1) || "", middle: parts.slice(1, -1) };
}

/** Names to try: the full name, aliases, and "nickname last". */
export function nameVariants(subject) {
  const out = new Set([subject.name, ...(subject.aliases || [])].filter(Boolean));
  const { first, last } = nameParts(subject.name);
  for (const n of NICK[first] || []) out.add(`${n} ${last}`);
  return [...out];
}

/** True when the text names the subject (full name, alias or nickname + surname). */
export function nameMatch(text, subject) {
  if (!text) return false;
  return nameVariants(subject).some((n) => nameIn(text, n));
}

/** Surname alone appears (weak signal, used for rare surnames in image search). */
export function lastIn(text, subject) {
  const { last } = nameParts(subject.name);
  return last.length > 2 && (" " + normName(text) + " ").includes(" " + last + " ");
}

const CO_SUFFIX = /\b(inc|incorporated|llc|llp|ltd|limited|corp|corporation|company|co|plc|gmbh|ag|sa|group|holdings|software|technologies|technology|industries|systems|labs|solutions|international)\b/g;
const COMMON = new Set("progress united general national american first global digital energy health capital pacific atlantic standard advanced applied modern summit pioneer delta alpha apex core prime vision".split(" "));

/** The strings that count as "this text names the company": full name, distinctive core, domain stem. */
export function companyKeys(subject) {
  const keys = new Set();
  if (subject.company) {
    const full = normName(subject.company);
    if (full) keys.add(full);
    const core = full.replace(CO_SUFFIX, " ").replace(/\s+/g, " ").trim();
    if (core && core !== full && (core.includes(" ") || (core.length >= 5 && !COMMON.has(core)))) keys.add(core);
    const squashed = core.replace(/ /g, "");
    if (squashed.length >= 6 && !COMMON.has(squashed)) keys.add(squashed);
  }
  if (subject.domain) {
    const d = subject.domain.toLowerCase();
    keys.add(d);
    const stem = d.split(".")[0];
    if (stem.length >= 6 && !COMMON.has(stem)) keys.add(stem);
  }
  return [...keys];
}

export function companyIn(text, subject) {
  if (!text) return false;
  const t = " " + normName(text) + " ";
  const raw = String(text).toLowerCase();
  return companyKeys(subject).some((k) => (k.includes(".") ? raw.includes(k) : t.includes(" " + k + " ")));
}

const STATES = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "district of columbia" };
export const stateName = (s) => STATES[String(s || "").toUpperCase()] || normName(s);

/** Places the subject is known to be tied to: --city/--state plus anything modules published. */
export function knownPlaces(subject, shared = {}) {
  const out = [];
  if (subject.city) out.push(normName(subject.city));
  if (subject.state) out.push(stateName(subject.state), String(subject.state).toLowerCase());
  // shared.places: strings or { place, from } (from = the URL that reported it)
  for (const p of shared.places || []) if (p) out.push(normName(typeof p === "string" ? p : p.place));
  return [...new Set(out.filter((p) => p.length >= 2))];
}

export function placeIn(text, subject, shared) {
  if (!text) return false;
  const t = " " + normName(text) + " ";
  return knownPlaces(subject, shared).some((p) => (p.length === 2 ? new RegExp(`\\b${p}\\b`, "i").test(String(text)) && /[A-Z]{2}/.test(String(text)) : t.includes(" " + p + " ")));
}

/** Handles derived from the name: first.last, firstlast, flast, firstl, first_last, plus nickname forms. */
export function derivedHandles(subject) {
  const { first, last } = nameParts(subject.name);
  if (!first || !last) return [];
  const f = first.replace(/ /g, ""), l = last.replace(/ /g, "");
  const out = [`${f}${l}`, `${f}.${l}`, `${f}_${l}`, `${f[0]}${l}`, `${f}${l[0]}`];
  for (const n of (NICK[f] || []).slice(0, 2)) out.push(`${n}${l}`);
  return [...new Set(out)];
}

/** Profile handle from a social URL, or null. */
export function handleFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\.|^mobile\./, "");
  const seg = u.pathname.split("/").filter(Boolean);
  const pick = (s) => (s && /^@?[A-Za-z0-9._-]{2,40}$/.test(s) ? s.replace(/^@/, "") : null);
  const SKIP = new Set(["p", "reel", "reels", "explore", "status", "hashtag", "search", "watch", "pages", "groups", "events", "posts", "pub", "dir", "company", "school", "in", "share", "intent", "home", "login", "signup", "about", "help", "privacy", "tos", "photo", "video", "channel", "c", "user", "people", "public", "story.php", "profile.php", "permalink.php"]);
  const first = seg[0];
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return first === "in" ? pick(seg[1]) : null;
  if (/\.substack\.com$/.test(host)) return host.split(".")[0];
  if (host === "youtube.com") return first?.startsWith("@") ? pick(first) : null;
  if (host === "medium.com") return first?.startsWith("@") ? pick(first) : null;
  if (/^(instagram\.com|x\.com|twitter\.com|github\.com|tiktok\.com|threads\.net|threads\.com|facebook\.com|pinterest\.com|linktr\.ee|soundcloud\.com|vimeo\.com|flickr\.com|dribbble\.com|about\.me)$/.test(host)) {
    if (!first || SKIP.has(first.toLowerCase())) return null;
    // a second path segment means a post, photo or repo, not the profile itself
    if (seg.length > 1 && !/^(followers|following|about|repositories|featured|videos|posts)$/.test(seg[1])) return null;
    return pick(first);
  }
  return null;
}

/** Which social platform a URL belongs to, or null. Profile URLs only. */
export function platformOf(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\.|^m\.|^mobile\.|^[a-z]{2}\./, "");
  } catch {
    return null;
  }
  const map = {
    "linkedin.com": "linkedin", "instagram.com": "instagram", "facebook.com": "facebook", "x.com": "x", "twitter.com": "x",
    "threads.net": "threads", "threads.com": "threads", "tiktok.com": "tiktok", "github.com": "github", "medium.com": "medium",
    "youtube.com": "youtube", "strava.com": "strava", "pinterest.com": "pinterest", "linktr.ee": "linktree", "bsky.app": "bluesky",
    "soundcloud.com": "soundcloud", "vimeo.com": "vimeo", "flickr.com": "flickr", "about.me": "aboutme", "reddit.com": "reddit",
  };
  if (/\.substack\.com$/.test(host)) return "substack";
  return map[host] || null;
}

// ---------------------------------------------------------------- search parsers

export function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
const clean = (s) => decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** DuckDuckGo html.duckduckgo.com/html results. */
export function parseDdgHtml(html) {
  const out = [];
  for (const blk of String(html || "").split(/class="result results_links/).slice(1)) {
    const a = blk.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const s = blk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    let url = decodeEntities(a[1]);
    const m = url.match(/uddg=([^&]+)/);
    if (m) url = decodeURIComponent(m[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js|ad_domain|ad_provider/.test(url)) continue;
    out.push({ title: clean(a[2]), url, snippet: clean(s?.[1]) });
  }
  return out;
}

/** True when DuckDuckGo served its bot check instead of results. */
export function ddgBlocked(res) {
  return res.status === 202 || res.status === 403 || res.status === 429 || /anomaly-modal|anomaly\.js|challenge-form/i.test(res.text || "");
}

/** Bing search with format=rss. */
export function parseBingRss(xml) {
  return [...String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
    title: clean((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1]),
    url: clean((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1]),
    snippet: clean((m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1]),
    date: clean((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1]) || null,
  })).filter((r) => r.url);
}

export function parseSearx(json) {
  return (json?.results || []).map((x) => ({ title: clean(x.title), url: x.url, snippet: clean(x.content), date: x.publishedDate || null })).filter((r) => r.url);
}

export function parseBrave(json) {
  return (json?.web?.results || []).map((x) => ({ title: clean(x.title), url: x.url, snippet: clean(x.description), date: x.page_age || null })).filter((r) => r.url);
}

/** Bing images/async: each tile carries m="{json}" with murl (image), purl (page), t (title). */
export function parseBingImages(html) {
  return [...String(html || "").matchAll(/class="iusc"[^>]*?\sm="([^"]+)"/g)]
    .map((m) => {
      try {
        const j = JSON.parse(decodeEntities(m[1]));
        return { image: j.murl, thumb: j.turl, page: j.purl, title: clean(j.t), desc: clean(j.desc) };
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.image);
}

/** Yandex reverse image (rpt=imageview): the data-state blob holds cbirSites and cbirTags. */
export function parseYandexReverse(html) {
  const states = [...String(html || "").matchAll(/data-state="([^"]*)"/g)]
    .map((m) => {
      try {
        return JSON.parse(decodeEntities(m[1]));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const s = states.find((x) => x.initialState?.cbirSites || x.initialState?.cbirTags);
  if (!s) return { ok: false, captcha: /showcaptcha|smartcaptcha|captcha/i.test(String(html || "").slice(0, 5000)), sites: [], tags: [] };
  const st = s.initialState;
  return {
    ok: true,
    tags: (st.cbirTags?.tags || []).map((t) => t.text),
    sites: (st.cbirSites?.sites || []).map((x) => ({ title: clean(x.title), page: x.url, domain: x.domain, image: x.originalImage?.url, snippet: clean(x.description) })),
  };
}

// ---------------------------------------------------------------- keyword rules

/** Hobby keyword rules: var, label, regex. Matched against bios and post text. */
export const HOBBIES = [
  ["hobby.endurance", "running", /\b(runner|running|marathon(?:er)?|half[- ]marathon|ultra(?:marathon|runner)?|5k|10k|trail run\w*|boston qualifier|bq)\b/i],
  ["hobby.endurance", "cycling", /\b(cyclist|cycling|bik(?:e|er|ing)|gravel|peloton|century ride|zwift)\b/i],
  ["hobby.endurance", "triathlon", /\b(triathl\w+|ironman|70\.3)\b/i],
  ["hobby.endurance", "swimming", /\b(swimmer|swimming|open water)\b/i],
  ["hobby.sports", "golf", /\b(golf(?:er|ing)?|handicap|18birdies)\b/i],
  ["hobby.sports", "baseball", /\b(baseball|little league|softball)\b/i],
  ["hobby.sports", "football", /\b(football coach|coach(?:ing)? football|flag football)\b/i],
  ["hobby.sports", "soccer", /\b(soccer)\b/i],
  ["hobby.sports", "basketball", /\b(basketball|hoops)\b/i],
  ["hobby.sports", "tennis", /\b(tennis|pickleball|padel)\b/i],
  ["hobby.sports", "skiing", /\b(ski(?:er|ing)?|snowboard\w*)\b/i],
  ["hobby.sports", "sailing", /\b(sail(?:or|ing)?|regatta|yacht\w*)\b/i],
  ["hobby.sports", "fishing", /\b(fishing|fisherman|angler|fly ?fish\w*)\b/i],
  ["hobby.sports", "hunting", /\b(hunt(?:er|ing)|bowhunt\w*|archery|bow ?sight|tree ?stand)\b/i],
  ["hobby.sports", "climbing", /\b(climb(?:er|ing)|bouldering|mountaineer\w*)\b/i],
  ["hobby.sports", "hiking", /\b(hik(?:er|ing)|backpack(?:er|ing)|alltrails)\b/i],
  ["hobby.sports", "chess", /\b(chess)\b/i],
  ["hobby.cooking", "cooking", /\b(cook(?:ing)?|chef|bak(?:er|ing)|bbq|barbecue|grill(?:ing)?|smoker|sourdough|foodie|recipes?)\b/i],
  ["hobby.cooking", "wine and beer", /\b(wine|sommelier|craft beer|homebrew\w*|whisk(?:e)?y|bourbon)\b/i],
  ["hobby.media", "music", /\b(musician|guitar\w*|drummer|pianist|piano|vinyl|band|dj|singer|songwriter)\b/i],
  ["hobby.media", "reading", /\b(reader|reading|books?|bookworm|goodreads|novel)\b/i],
  ["hobby.media", "film", /\b(film buff|movies|cinema|letterboxd)\b/i],
  ["hobby.media", "photography", /\b(photograph(?:er|y)|camera)\b/i],
  ["hobby.media", "gaming", /\b(gamer|gaming|video games?)\b/i],
  ["hobby.teams", "team fan", /\b(go (?:\w+ ){0,1}\w+!|die[- ]hard \w+ fan|season ticket|\w+ fan\b)/i],
];

export function hobbiesIn(text) {
  const out = [];
  for (const [v, label, re] of HOBBIES) {
    const m = String(text || "").match(re);
    if (m) out.push({ var: v, label, word: m[0] });
  }
  return out;
}

const STOP = new Set("the a an and or of to in on for with at by from is are was were be been it its this that these those i you he she we they my our your his her their me us them as not no but so if then than too very can will just about into over after more most new now out up all any one two get got have has had do does did what when where who how why which also via amp rt https http www com co today here there".split(" "));

/** Top words in a body of posts (simple counts, stopwords dropped). */
export function topTerms(texts, n = 12) {
  const c = new Map();
  for (const t of texts) for (const w of normName(t).split(" ")) if (w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)) c.set(w, (c.get(w) || 0) + 1);
  return [...c.entries()].filter(([, k]) => k > 1).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** "City, ST" or "City, State" from a free-text location. */
export function placeFrom(loc) {
  const s = String(loc || "").trim();
  if (!s || s.length > 80) return null;
  return s;
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Run async fn over items with at most `n` in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch (e) {
          out[k] = { error: String(e.message || e) };
        }
      }
    }),
  );
  return out;
}

/** Grade for a snippet-level finding: p when anchored by company or place, else w. */
export function snippetGrade(text, subject, shared) {
  const anchors = [];
  if (companyIn(text, subject)) anchors.push("company");
  if (placeIn(text, subject, shared)) anchors.push("place");
  return { grade: anchors.length ? "p" : "w", anchors };
}
