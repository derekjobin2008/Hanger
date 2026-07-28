# Hangar

A voice-first logbook copilot for general aviation mechanics. Speak what you did;
it comes back as a formatted maintenance record entry you can review, sign, and export.

The bet: Zymbly and friends are building for airlines and large MROs sitting on top of
ERP systems. The ~14,000 GA repair shops maintaining 140,000+ piston aircraft have no
ERP, no IT budget, and no tools — they have paper logs and spreadsheets. Same core job,
ignored segment.

## Run it

```sh
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional, but this is the whole product
npm start                             # http://localhost:3000
```

Without an API key the app still runs — it stores your words verbatim instead of
formatting them, so you can click through the flow. With a key, Claude turns spoken
shorthand into logbook prose and pulls out tail number, times, parts, and part numbers.

## The loop

1. **Hold the mic** and talk. Browser speech recognition fills the box live.
   (Chrome and Safari. No mic? Type it — same path.)
2. **Format entry.** Claude splits what you said into the fields 14 CFR 43.9 wants:
   description of work, date, tach/Hobbs, discrepancy, parts. Anything you didn't
   say out loud gets flagged rather than invented.
3. **Review and fix.** Every field is editable. The formatted block updates as you go.
4. **Sign & file.** Your name and certificate number are appended; entries are marked
   unsigned until you do. It won't let you sign without a certificate number.
5. **Search and export.** Full-text over tail number, work, and parts.
   `.txt` for the logbook, `.csv` for the shop's records.

Example — say this:

> "Owner reported rough idle on november seven seven two sierra papa, a Cessna 172S.
> Removed and cleaned all eight spark plugs, replaced number three bottom plug, part
> number REM37BY, gapped to point zero one eight. Ran up, mag drop within limits.
> Hobbs 1204.3"

and you get a filed entry with `N772SP`, `Cessna 172S`, Hobbs `1204.3`, the discrepancy
split from the corrective action, and `Spark plug, P/N REM37BY, Qty 1` in the parts list.

## Shape of it

| File | What it does |
| --- | --- |
| `server.js` | HTTP + SQLite (`node:sqlite`, no ORM), REST routes, CSV/txt export |
| `parse.js` | Transcript → fields via Claude structured outputs; renders the entry block |
| `public/` | Single page: speech capture, draft editor, logbook list |

Storage is a local `hangar.db` SQLite file. Node 22+ (uses the built-in SQLite module).
Mechanic name and certificate number live in `localStorage`, not the database.

## What this is not, yet

- **Not a compliance guarantee.** It formats what you tell it into the shape of a
  §43.9 entry. A human A&P still reads it and signs it. The signature is a name and a
  certificate number typed into a text field — it is not a legal digital signature.
- **No parts lookup or manual search.** Those are the other two-thirds of the pitch;
  this is the paperwork third.
- **Single user, no auth.** Anyone who can reach the port can read and delete entries.
  Fine on a laptop in a hangar, not fine on the open internet.
- **No aircraft records, no recurring-inspection tracking, no 337s.**
