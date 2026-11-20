# The form

Every room fills the same buckets. They are defined as data in `config/form/`, and the intake
(modes, org type, practice, people) picks which packs apply. Code computes each bucket's state from
the research ledgers. AI never writes a bucket's state. The full list is in
[form-buckets.md](form-buckets.md).

- **Ledgers**: `rooms/<slug>/work/osint/<person>/ledger.jsonl` comes from the scripted pass plus
  entries. `rooms/<slug>/work/osint/_company/ledger.jsonl` holds entries on company buckets. A row is
  cited as `<ledger>/L-0001`.
- **States**:
  - Filled: shows the best grade and its source.
  - Searched, nothing found.
  - Couldn't check: blocked, no key, no domain, or not run.
  - No tool yet: no module feeds the bucket and nobody handed in an entry.
- **Entries**: `npm run entry -- <slug> --bucket <id> [--person <slug>] --value ... --url ...`. You
  can also pass `--none "<what was searched>"`, or for an AI slot `--cites L-0003,...`. Code grades
  every entry with the two-source rule, so an agent cannot write Verified.
- **Check**: `npm run form -- <slug> --check`. `run-room` runs it before the build and stops there
  if it fails. Add `--draft` to build anyway.
- **Look**: `npm run form -- <slug>` shows every bucket with its state. The built room has an "On
  the form" block on each page and a "The form" page.

## Add a bucket

Add one line to a pack in `config/form/`:

```json
{"id": "life.sailing", "label": "Sailing and regattas", "page": "interests", "group": "Sports and outdoors", "kind": "list", "vars": ["hobby.sailing"], "hint": "Regatta results, yacht club rosters"}
```

- `id`: unique across all packs.
- `page`: the page id without the person suffix.
- `kind`: `fact`, `list` or `ai`.
- `vars`: the ledger variables that fill it (optional). Leave it out and the bucket shows "no tool
  yet" until an agent hands in an entry.
- Optional fields:
  - `match`: a regex on the row's url and value, so one var can feed several buckets (e.g. one
    bucket per social platform).
  - `intake`: an intake field, e.g. `"goal"`.
  - `required`: `true` means the form check fails until the bucket has a state from a tool or an entry.
  - `start`: `true` makes it a Start here field, which must be filled.
  - `scope`: `person` or `company`, to override the pack's scope.
- Run `npm run form -- --packs` (schema check) and `npm run form -- --table > ...` to refresh the doc.

## Add a pack (a new use case)

Add a file. For example, a CEO-to-CEO mode is `config/form/modes/ceo-to-ceo.json`:

```json
{ "id": "modes/ceo-to-ceo", "label": "CEO to CEO", "scope": "company", "buckets": [ ... ] }
```

A room picks it up when its intake lists that mode. An org type is `orgtypes/<type>.json`, and an
opt-in extra is `extras/<name>.json`. The packs for page templates live separately, in
`templates/skeleton/modes|orgtypes|extras/<name>/pack.json`.

- A pack can point at a page the room does not have. That is a lint warning, and its buckets
  still show on the form page.
- A mode with no pack file fails the form check, by name.

## Add a tool

Write a module in `scripts/osint/modules/` the usual way and declare what it fills:

```js
export default { id: "regattas", label: "Regatta results", vars: ["hobby.sailing"], lane: "sweep", needs: ["name"], async run(ctx) { ... } };
```

That is all. The buckets that list those vars now show:

- "searched, nothing found" when the module ran with no hits (`ctx.miss(var, what)`),
- "couldn't check" when it was blocked or skipped, or when its call failed: record that with
  `ctx.miss(var, what, { blocked: true })` (or `ctx.status("blocked", why)`), never as a plain miss,
- the rows when it found something.

A row whose var no bucket lists shows under **Other findings** on the form page until a bucket is added.
