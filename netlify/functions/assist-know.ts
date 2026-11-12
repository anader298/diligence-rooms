// Companion: what it knows about this room, for the phone's "knows" line and the
// facts-file check on our side's numbers. No model call.
//   GET /<room>/api/know -> { title, asOf, pages, kinds, personas[], people[], savedFed[], numbers[] }
// Behind the room's password gate, like every /<room>/api/* path.
import type { Config, Context } from "@netlify/functions";
import { json, knows, loadCorpus } from "./_assist.ts";
import { numbersIn } from "../../templates/assist/core.js";

export default async (_req: Request, context: Context) => {
  try {
    const c = loadCorpus(context.params.room);
    const numbers = [...new Set(c.entries.flatMap((e) => numbersIn(e.text)))].slice(0, 2000);
    return json({ ...knows(c), numbers });
  } catch (e: any) {
    return json({ error: e.message }, 404);
  }
};

export const config: Config = { path: "/:room/api/know" };
