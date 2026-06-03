# Media Plan Parser — external parser setup

This is the server-side half of the Media Plan Parser. It exists because a browser-based Zendesk
sidebar app cannot fetch attachment bytes (ZAF `client.request` doesn't support binary downloads,
and a direct browser fetch to the attachment URL is blocked by CORS). This function runs on a
server, where neither limit applies: it fetches the ticket's latest spreadsheet from the Zendesk
API, parses it, and returns clean JSON line items. The sidebar app then maps those into ticket
fields.

## What's in here

- `netlify/functions/parse-media-plan.js` — the function (fetch + parse + return JSON)
- `package.json` — declares the one dependency (SheetJS / `xlsx`)
- `netlify.toml` — Netlify build config
- `public/index.html` — placeholder landing page

## How the two halves talk

```
Agent clicks "Parse media plan" in the sidebar app
        │  (ZAF: gets ticket.id, POSTs it through the proxy with a secret header)
        ▼
Netlify function  parse-media-plan
        │  authenticates to Zendesk API with its own env credentials
        │  finds the latest .xlsx/.xls/.csv attachment on the ticket
        │  downloads it (server-side — no CORS), parses with SheetJS
        │  picks the highest-spend tab, applies the column/row rules
        ▼
Returns JSON: { ok, chosenTab, totalSpend, count, lineItems:[{name,startDate,endDate,budget,imps}], warnings }
        │
        ▼
Sidebar app maps lineItems -> the 325 ticket field IDs, fills 1..N, clears N+1..65, never auto-saves
```

## Deploy steps

1. **Put these files in a GitHub repo** (or drag-and-drop deploy — but a repo is easier to update).

2. **Create a Netlify site** from the repo. Netlify auto-detects `netlify.toml`, installs `xlsx`,
   and publishes the function at:
   ```
   https://YOUR-SITE.netlify.app/.netlify/functions/parse-media-plan
   ```

3. **Set the environment variables** in Netlify (Site settings → Environment variables):

   | Variable | What it is |
   |---|---|
   | `ZENDESK_SUBDOMAIN` | the part before `.zendesk.com` (e.g. `vevoresearch`) |
   | `ZENDESK_EMAIL` | an agent/admin email with API access |
   | `ZENDESK_API_TOKEN` | a Zendesk API token (Admin Center → Apps and integrations → APIs → Zendesk API → add token) |
   | `PARSER_SHARED_SECRET` | any long random string; the sidebar app sends it back in the `X-Parser-Secret` header |

   The Zendesk credentials live ONLY here, server-side. The browser never sees them — it only ever
   sends a ticket id.

4. **Wire up the sidebar app** using the companion note (`APP_BUILDER_frontend_role.md`):
   - Point the app's request at your `https://YOUR-SITE.netlify.app/.netlify/functions/parse-media-plan`.
   - Add a SECURE app setting `parser_secret` (value = the same `PARSER_SHARED_SECRET`) so it's
     injected server-side by the proxy and never appears in client code.

## Test it

- Open a ticket that has a media plan attached and is in the "Media Plan Shared" status.
- Click "Parse media plan".
- Confirm the results panel shows the highest-spend tab, the right line-item count, dates split
  correctly, Budget (not Rate) in the budget fields, and Quantity in the impressions fields.
- Confirm the ticket is NOT saved automatically — values are staged for review.

## Notes & limits

- The function returns HTTP 200 even for "expected" failures (no attachment, parse error), with
  `ok:false` and a message, so the app can show a clean message instead of a network error.
- It reads up to the first `Total` / `Grand Total` / `Notes` / `Terms and Conditions` row, which
  ends the line-item block.
- Column matching uses synonyms: name ← Line Item Name / Content / Name; impressions ← Quantity /
  Impressions / Imps; budget ← Budget / Net Cost (never Rate / Net Rate / CPM). If a future plan
  uses a different header, add it to the `SYN` dictionary at the top of the function.
- Tab choice = highest total spend (from each tab's Total row; falls back to the dollar amount in
  the tab name if a tab has no Total).
