// Companion: save one fed item back to the room as rooms/<room>/work/fed/<date>-<title>.md,
// so the next build puts it in the room's knowledge for good.
//
// Off unless ASSIST_FEED_SAVE=on. It writes to the repository folder, so it only works
// where the functions run next to the repo (netlify dev, or a local run); a deployed
// site's file system is read-only and the phone is told to export instead.
// rooms/*/work/ is git-ignored: saved items stay on the machine that saved them.
// Behind the room's password gate, like every /<room>/api/* path.
import type { Config, Context } from "@netlify/functions";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { json } from "./_assist.ts";

export function fedFileName(title: string, at = new Date()) {
  const slug = String(title || "note").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "note";
  return `${at.toISOString().slice(0, 10)}-${slug}.md`;
}

export function fedMarkdown(item: { title: string; text: string; kind?: string; at?: string }) {
  return `# ${item.title}\n\nFed to the companion${item.at ? ` on ${item.at.slice(0, 16).replace("T", " ")}` : ""} (${item.kind || "note"}). Grade: fed (our own note, not checked).\n\n${item.text.trim()}\n`;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if ((process.env.ASSIST_FEED_SAVE || "off") !== "on") return json({ error: "Saving to the room is off (ASSIST_FEED_SAVE). The item stays in this session; export it for the debrief." }, 403);
  const room = context.params.room;
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(room || "")) return json({ error: "bad room" }, 400);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad JSON" }, 400); }
  const text = String(body?.text || "").trim().slice(0, 20000);
  const title = String(body?.title || "note").slice(0, 80);
  if (!text) return json({ error: "nothing to save" }, 400);
  const roomDir = join(process.env.ASSIST_REPO_DIR || process.cwd(), "rooms", room);
  if (!existsSync(join(roomDir, "room.json"))) return json({ error: "this room's folder is not here; saving works only next to the repo (netlify dev)" }, 501);
  try {
    const dir = join(roomDir, "work", "fed");
    mkdirSync(dir, { recursive: true });
    const name = fedFileName(title);
    writeFileSync(join(dir, name), fedMarkdown({ title, text, kind: String(body?.kind || "note"), at: String(body?.at || new Date().toISOString()) }));
    return json({ saved: `rooms/${room}/work/fed/${name}`, note: "In the knowledge after the next build." });
  } catch (e: any) {
    return json({ error: "could not save here (read-only host?): " + String(e?.message || e).slice(0, 160) }, 501);
  }
};

export const config: Config = { path: "/:room/api/feed" };
