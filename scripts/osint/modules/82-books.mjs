// books (slow lane: Open Library takes 2-18 s a call): books the person wrote. Open Library author
// search, then the matched author's record (bio, VIAF/Wikidata/Goodreads ids) and works. Google
// Books (inauthor:) adds publishers and descriptions with GOOGLE_BOOKS_API_KEY (its anonymous quota
// answers 429). An author whose subjects or bio name the company is graded p; the name alone w.

import { nameMatch, companyIn, isBlocked, blockedMiss } from "../person-lib.mjs";

const OL = "https://openlibrary.org";

/** Open Library authors that match the name, most works first. */
export function olAuthors(json, subject) {
  return (json?.docs || []).filter((d) => nameMatch(d.name, subject) || (d.alternate_names || []).some((n) => nameMatch(n, subject))).map((d) => ({ key: d.key, name: d.name, works: d.work_count || 0, topWork: d.top_work || null, subjects: d.top_subjects || [], born: d.birth_date || null })).sort((a, b) => b.works - a.works);
}

/** Google Books volumes by the subject. */
export function googleVolumes(json, subject) {
  return (json?.items || []).map((v) => v.volumeInfo || {}).filter((v) => (v.authors || []).some((a) => nameMatch(a, subject))).map((v) => ({ title: [v.title, v.subtitle].filter(Boolean).join(": "), published: v.publishedDate || null, publisher: v.publisher || null, url: v.infoLink || v.canonicalVolumeLink || null, company: companyIn(`${v.description || ""} ${v.title || ""}`, subject) }));
}

export default {
  id: "books",
  /** The ledger variables this module fills (config/form buckets read them to say "no tool yet"). */
  vars: ["voice.books"],
  label: "Books as author (Open Library; Google Books with key)",
  lane: "slow",
  needs: ["name"],
  env: ["GOOGLE_BOOKS_API_KEY"],
  budgetMs: 30000,
  async run(ctx) {
    const { subject, http, env } = ctx;
    const gb = env.GOOGLE_BOOKS_API_KEY ? http.json(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`inauthor:"${subject.name}"`)}&maxResults=20&key=${env.GOOGLE_BOOKS_API_KEY}`, { timeout: 8000 }) : null;
    const s = await http.json(`${OL}/search/authors.json?q=${encodeURIComponent(subject.name)}`, { timeout: 20000 });
    let n = 0;
    if (!s.ok) blockedMiss(ctx, "voice.books", "Open Library", s, "retry later (Open Library is slow, 2-18 s a call)", { partial: true });
    const a = s.ok ? olAuthors(s.data, subject)[0] : null;
    if (a) {
      const [rec, works] = await Promise.all([http.json(`${OL}/authors/${a.key}.json`, { timeout: 15000 }), http.json(`${OL}/authors/${a.key}/works.json?limit=15`, { timeout: 15000 })]);
      const bio = typeof rec.data?.bio === "string" ? rec.data.bio : rec.data?.bio?.value || "";
      const anchored = companyIn(`${a.subjects.join(" ")} ${bio}`, subject);
      const grade = anchored ? "p" : "w";
      const url = `${OL}/authors/${a.key}`;
      const list = (works.data?.entries || []).map((w) => ({ title: w.title, key: w.key, first: w.first_publish_date || null, subjects: (w.subjects || []).slice(0, 5) }));
      ctx.add({ var: "voice.books", value: `Open Library: ${a.name}, ${a.works} work(s)${a.topWork ? `, best known "${a.topWork}"` : ""}${a.subjects.length ? `; subjects ${a.subjects.slice(0, 6).join(", ")}` : ""}${anchored ? "" : " (name match only — could be a namesake)"}`, url, grade, tier: "A", anchors: ["name", ...(anchored ? ["company"] : [])], detail: { ...a, bio: bio.slice(0, 500) || null, remote_ids: rec.data?.remote_ids || null, works: list } });
      for (const w of list.slice(0, 8)) ctx.add({ var: "voice.books", value: `"${w.title}"${w.first ? ` (${w.first})` : ""}`, url: `${OL}${w.key}`, grade, tier: "A", date: w.first, anchors: ["name", ...(anchored ? ["company"] : [])], detail: w });
      n++;
    }
    let gbOk = false;
    if (gb) {
      const g = await gb;
      gbOk = g.ok;
      if (g.ok) {
        const vols = googleVolumes(g.data, subject);
        for (const v of vols.slice(0, 8)) {
          n++;
          ctx.add({ var: "voice.books", value: `Google Books: "${v.title}"${v.publisher ? `, ${v.publisher}` : ""}${v.published ? ` (${v.published})` : ""}`, url: v.url, grade: v.company ? "p" : "w", tier: "A", date: v.published, anchors: ["name", ...(v.company ? ["company"] : [])], detail: v });
        }
      } else if (isBlocked(g)) blockedMiss(ctx, "voice.books", "Google Books", g, "check GOOGLE_BOOKS_API_KEY or retry later", { partial: true });
    }
    if (!n) ctx.miss("voice.books", `no author named ${subject.name} on Open Library${gb ? " or Google Books" : " (Google Books not checked: set GOOGLE_BOOKS_API_KEY)"}${s.ok ? "" : "; Open Library did not answer"}`, { blocked: !s.ok && !gbOk });
  },
};
