// Pictures: Bing image search for the name with the employer, Wikimedia Commons, then a Yandex
// reverse-image search on his headshot (--photo, or one a company or profile module published as
// shared.headshot). A picture is kept only when its title, caption or page names the subject AND
// names the company or words of the subject's title; strangers who look alike are never shown.

import { nameMatch, companyIn, parseBingImages, parseYandexReverse, hostOf, normName, isBlocked, blockedMiss } from "../person-lib.mjs";

const CAP = 12;
const JOB_NOISE = /(^|\.)(indeed|glassdoor|ziprecruiter|monster|simplyhired|careerbuilder|lever|greenhouse|workday|myworkdayjobs|builtin)\.|\/jobs?\/|\bjob(s| opening| posting)?\b|\bhiring\b|\bcareers?\b|\bsalary\b|\bnow hiring\b/i;
const GENERIC = new Set("vice president senior director manager head of and the chief officer executive general global lead principal associate assistant deputy group svp evp vp sr".split(" "));

/** Keep a picture only when it names the subject and (the company or the subject's title words). */
export function imageKeeps(t, subject, roleTitle = "") {
  const text = `${t.title || ""} ${t.desc || ""} ${(() => {
    try {
      return decodeURIComponent(t.page || "");
    } catch {
      return t.page || "";
    }
  })()}`;
  if (!nameMatch(text, subject)) return null;
  if (JOB_NOISE.test(`${hostOf(t.page)} ${t.page || ""} ${t.title || ""}`)) return null;
  const co = companyIn(text, subject);
  const words = normName([subject.title, roleTitle].filter(Boolean).join(" ")).split(" ").filter((w) => w.length > 3 && !GENERIC.has(w));
  const tt = " " + normName(text) + " ";
  const titled = words.some((w) => tt.includes(" " + w + " "));
  if (!co && !titled) return null;
  return [...["name"], ...(co ? ["company"] : []), ...(titled ? ["title"] : [])];
}

export default {
  id: "images",
  label: "Image search and reverse image search on the headshot",
  lane: "slow",
  needs: ["name"],
  budgetMs: 25000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    const q = `"${subject.name}"${subject.company ? ` ${subject.company}` : ""}`;
    const photo = subject.photo || shared.headshot || null;

    const [bing, commons, rev] = await Promise.all([
      http.get(`https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=0&count=35&setlang=en&mmasync=1`, { timeout: 9000 }),
      http.json(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`"${subject.name}" ${subject.company || ""}`.trim())}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json`, { timeout: 9000, headers: { "user-agent": "diligence-rooms/1.0 (public-source research script)" } }),
      photo ? http.get(`https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(photo)}`, { timeout: 15000 }) : null,
    ]);

    let n = 0;
    let dropped = 0;
    const seen = new Set();
    const tiles = bing.ok ? parseBingImages(bing.text) : [];
    for (const t of tiles) {
      if (n >= CAP) break;
      const anchors = imageKeeps(t, subject, shared.roleTitle);
      if (!anchors) {
        dropped++;
        continue;
      }
      if (seen.has(t.page)) continue;
      seen.add(t.page);
      ctx.add({ var: "pic.image_results", value: t.title || hostOf(t.page), url: t.page, image: t.image, grade: anchors.includes("company") ? "p" : "w", tier: "C", anchors, detail: { engine: "bing", thumb: t.thumb, desc: t.desc } });
      n++;
    }
    if (!bing.ok) {
      if (isBlocked(bing)) blockedMiss(ctx, "pic.image_results", "Bing images", bing, "retry in a few minutes");
      else ctx.miss("pic.image_results", `Bing images: HTTP ${bing.status || bing.error}`);
    } else if (!n) {
      // Bing sometimes answers a script with unrelated images (memes, stock art). If no tile even
      // carries the surname, the search was not really run: unknown, not none.
      const last = String(subject.name).trim().split(/\s+/).at(-1).toLowerCase();
      const onTopic = tiles.filter((t) => `${t.title} ${t.desc} ${t.page}`.toLowerCase().includes(last)).length;
      if (tiles.length && !onTopic) ctx.miss("pic.image_results", `Bing images: not checked: ${tiles.length} tiles, none even mentioning "${last}" (Bing served unrelated images to the script), unknown · fix: retry later or search images by hand`);
      else ctx.miss("pic.image_results", `Bing images: ${tiles.length} tiles for ${q}, none captioned with the name and ${subject.company || "the title"}`);
    }

    for (const p of Object.values(commons.data?.query?.pages || {})) {
      const ii = p.imageinfo?.[0];
      if (!ii || n >= CAP) continue;
      const anchors = imageKeeps({ title: p.title, page: ii.descriptionurl }, subject, shared.roleTitle);
      if (!anchors) continue;
      ctx.add({ var: "pic.image_results", value: `Wikimedia Commons: ${p.title.replace(/^File:/, "")}`, url: ii.descriptionurl, image: ii.thumburl || ii.url, grade: anchors.includes("company") ? "p" : "w", tier: "C", anchors, detail: { engine: "commons" } });
      n++;
    }

    if (!photo) {
      ctx.miss("pic.reverse", "no headshot to search with (pass --photo, or a company bio or verified profile must publish one)");
      return;
    }
    const parsed = parseYandexReverse(rev?.text);
    if (!rev?.ok || !parsed.ok) {
      if (!rev?.ok || parsed.captcha) blockedMiss(ctx, "pic.reverse", "Yandex reverse image", parsed.captcha ? { status: rev?.status || 200, error: "captcha" } : rev, "retry later, or run the photo through an image search by hand");
      else ctx.miss("pic.reverse", "Yandex reverse image: no result block in page");
      return;
    }
    // Only pages that reuse the headshot AND name the subject are kept: they anchor identity.
    // Look-alikes (strangers with a similar face) are counted, never listed.
    const hits = (shared.reverseHits = []);
    let lookalikes = 0;
    for (const s of parsed.sites.slice(0, 25)) {
      const text = `${s.title} ${s.snippet}`;
      const named = nameMatch(text, subject);
      const co = companyIn(text + " " + s.page, subject);
      if (!named) {
        lookalikes++;
        continue;
      }
      hits.push({ page: s.page, domain: s.domain, title: s.title, named, company: co });
      ctx.add({ var: "pic.reverse", value: `Reuses the headshot and names ${subject.name}: ${s.title || s.domain}`, url: s.page, image: s.image, grade: co ? "p" : "w", tier: "B", anchors: ["name", "image", ...(co ? ["company"] : [])], detail: { domain: s.domain, snippet: s.snippet, photo, engine: "yandex" } });
    }
    if (!hits.length) ctx.miss("pic.reverse", `Yandex reverse image: ${parsed.sites.length} page(s) with similar pictures, none naming ${subject.name} (${lookalikes} look-alikes not shown)`);
  },
};
