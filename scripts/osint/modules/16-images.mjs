// Pictures: Bing image search and Wikimedia Commons for the name, then a Yandex reverse-image
// search on his headshot (--photo, or one a company or profile module published as
// shared.headshot). Pages that reuse the headshot and carry his name are identity anchors.

import { nameMatch, lastIn, companyIn, parseBingImages, parseYandexReverse, hostOf } from "../person-lib.mjs";

export default {
  id: "images",
  label: "Image search and reverse image search on the headshot",
  lane: "slow",
  needs: ["name"],
  budgetMs: 25000,
  async run(ctx) {
    const { subject, http, shared } = ctx;
    // Bing images drifts off-topic when the company is added; the name alone, then filtered, works.
    const q = `"${subject.name}"`;
    const photo = subject.photo || shared.headshot || null;

    const [bing, commons, rev] = await Promise.all([
      http.get(`https://www.bing.com/images/async?q=${encodeURIComponent(q)}&first=0&count=35&setlang=en&mmasync=1`, { timeout: 9000 }),
      http.json(`https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`"${subject.name}"`)}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json`, { timeout: 9000, headers: { "user-agent": "diligence-rooms/1.0 (public-source research script)" } }),
      photo ? http.get(`https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(photo)}`, { timeout: 15000 }) : null,
    ]);

    // Bing ignores the quotes, so keep only tiles whose title, caption or page names him.
    let n = 0;
    const tiles = bing.ok ? parseBingImages(bing.text) : [];
    for (const t of tiles) {
      const text = `${t.title} ${t.desc} ${decodeURIComponent(t.page || "")}`;
      const named = nameMatch(text, subject);
      const surnameCo = lastIn(text, subject) && companyIn(text, subject);
      if (!named && !surnameCo) continue;
      const anchors = [...(named ? ["name"] : []), ...(companyIn(text, subject) ? ["company"] : [])];
      ctx.add({ var: "pic.image_results", value: t.title || hostOf(t.page), url: t.page, image: t.image, grade: anchors.length > 1 ? "p" : "w", tier: "C", anchors, detail: { engine: "bing", thumb: t.thumb, desc: t.desc } });
      if (++n >= 12) break;
    }
    if (!bing.ok) ctx.miss("pic.image_results", `Bing images: HTTP ${bing.status || bing.error}`);
    else if (!n) ctx.miss("pic.image_results", `Bing images: ${tiles.length} tiles for ${q}, none captioned with the name`);

    for (const p of Object.values(commons.data?.query?.pages || {})) {
      const ii = p.imageinfo?.[0];
      if (!ii || !nameMatch(p.title, subject)) continue;
      ctx.add({ var: "pic.image_results", value: `Wikimedia Commons: ${p.title.replace(/^File:/, "")}`, url: ii.descriptionurl, image: ii.thumburl || ii.url, grade: "w", tier: "C", anchors: ["name"], detail: { engine: "commons" } });
    }

    if (!photo) {
      ctx.miss("pic.reverse", "no headshot to search with (pass --photo, or a company bio or confirmed profile must publish one)");
      return;
    }
    const parsed = parseYandexReverse(rev?.text);
    if (!rev?.ok || !parsed.ok) {
      ctx.miss("pic.reverse", `Yandex reverse image: ${rev?.ok ? (parsed.captcha ? "captcha" : "no result block in page") : `HTTP ${rev?.status || rev?.error}`}`);
      return;
    }
    const hits = (shared.reverseHits = []);
    for (const s of parsed.sites.slice(0, 25)) {
      const text = `${s.title} ${s.snippet}`;
      const named = nameMatch(text, subject);
      const co = companyIn(text + " " + s.page, subject);
      hits.push({ page: s.page, domain: s.domain, title: s.title, named, company: co });
      if (!named && !co && hits.filter((h) => !h.named && !h.company).length > 5) continue; // look-alikes: keep a few
      ctx.add({ var: "pic.reverse", value: `${named ? "Names the subject: " : co ? "Company page: " : "Look-alike or reuse (unverified): "}${s.title || s.domain}`, url: s.page, image: s.image, grade: named ? "p" : "w", tier: "B", anchors: [...(named ? ["name", "image"] : []), ...(co ? ["company"] : [])], detail: { domain: s.domain, snippet: s.snippet, photo, engine: "yandex" } });
    }
    if (parsed.tags.length) ctx.add({ var: "pic.reverse", value: `Yandex reads the photo as: ${parsed.tags.slice(0, 6).join(", ")}`, url: `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(photo)}`, grade: "i", tier: "D", detail: { tags: parsed.tags, photo, from: shared.headshotFrom || (subject.photo ? "--photo" : "company") } });
    if (!parsed.sites.length) ctx.miss("pic.reverse", "Yandex reverse image: no other pages reuse the headshot");
  },
};
