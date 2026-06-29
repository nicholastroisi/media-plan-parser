// request-volume.js  (v2 — classify by FORM, read office/role from TICKET TAGS)
// Read-only leadership function: counts request VOLUME for the Vevo Insights and
// Vevo Measurement request types, broken down by calendar quarter x office x role.
//
// WHAT CHANGED vs v1 (and why):
//   1) CLASSIFICATION is now by TICKET FORM, not Brand. The account uses a single
//      umbrella brand ("Vevo Research") on most tickets, so brand_id does not track
//      the real Insights/Measurement split. The Form does ("US Insights Request" /
//      "US Measurement Request"), so we resolve those two form IDs by name at runtime.
//   2) OFFICE/ROLE are now read from the TICKET'S TAGS (e.g. "east_coast",
//      "account_service_representative"), which are stamped at submission and present
//      on the ticket itself. We fall back to the requester's user-profile fields
//      (office / role_level) only when a ticket has no matching office/role tag.
//
// Output schema is IDENTICAL to v1, so leadership-volume.html needs no changes.
// Reuses env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN, PARSER_SHARED_SECRET
// Gated by X-Parser-Secret.

// Map exact Zendesk form NAMES -> the label the dashboard expects.
// (The dashboard buckets a label as "insights" if it contains "insight", else "measurement".)
const FORM_LABEL = {
  'US Insights Request': 'Vevo Insights',
  'US Measurement Request': 'Vevo Measurement',
};
const LABELS = Object.values(FORM_LABEL); // ['Vevo Insights','Vevo Measurement']

const QUARTERS_BACK = 6;            // how many recent calendar quarters to include
const MAX_PAGES = 40;               // safety cap on incremental export pages (40k tickets)

// Tag vocabularies — these mirror OFFICE_ORDER / ROLE_ORDER in leadership-volume.html.
// We scan each ticket's tags for the first match in each list.
const OFFICE_TAGS = ['east_coast', 'west_coast', 'midwest', 'international'];
const ROLE_TAGS = [
  'senior_vice_president', 'vice_president', 'director', 'regional_manager',
  'campaign_manager', 'account_manager', 'account_executive',
  'account_service_representative', 'marketing_team', 'agency_partnerships',
  'ppi_team', 'sales-intern', 'remote',
];

// User-field keys used ONLY as a fallback when a ticket has no office/role tag.
const OFFICE_FIELD = 'office';
const ROLE_FIELD = 'role_level';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Parser-Secret',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return `Basic ${token}`;
}

// ---- quarter helpers (calendar) ----
function quarterKey(d) { return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`; }
function startOfQuarter(year, qIndex) { return new Date(Date.UTC(year, qIndex * 3, 1)); }
function buildQuarterWindow(back) {
  const now = new Date();
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3); // 0-3
  const keys = [];
  for (let i = 0; i < back; i++) { keys.unshift(`${y}-Q${q + 1}`); q--; if (q < 0) { q = 3; y--; } }
  const [fy, fq] = keys[0].split('-Q').map(Number);
  return { keys, startTimeUnix: Math.floor(startOfQuarter(fy, fq - 1).getTime() / 1000) };
}

// Resolve the two request-type FORM ids by name (symmetric with v1's brand resolver).
async function resolveFormIds(sub) {
  const map = {}; // formId -> label
  const url = `https://${sub}.zendesk.com/api/v2/ticket_forms.json`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`ticket_forms fetch failed (${res.status})`);
  const data = await res.json();
  const matchedNames = [];
  for (const f of data.ticket_forms || []) {
    if (FORM_LABEL[f.name]) { map[f.id] = FORM_LABEL[f.name]; matchedNames.push(f.name); }
  }
  const missing = Object.keys(FORM_LABEL).filter((n) => !matchedNames.includes(n));
  if (missing.length) console.log(`WARN: form name(s) not found exactly: ${missing.join(', ')}`);
  return map;
}

// Incremental export (cursor) — pages of up to 1000, no 1000-result search cap
async function fetchTicketsSince(sub, startTimeUnix, wantedFormIds) {
  let url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?start_time=${startTimeUnix}`;
  const out = []; let pages = 0; let capped = false;
  while (url) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`incremental tickets failed (${res.status}): ${b.slice(0, 150)}`); }
    const data = await res.json();
    for (const t of data.tickets || []) {
      if (!wantedFormIds.has(t.ticket_form_id)) continue;   // <-- classify by FORM now
      if (!t.created_at) continue;
      out.push({
        formId: t.ticket_form_id,
        requesterId: t.requester_id || null,
        createdAt: t.created_at,
        tags: Array.isArray(t.tags) ? t.tags : [],
      });
    }
    pages++;
    if (data.end_of_stream || !data.after_cursor) break;
    url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(data.after_cursor)}`;
  }
  console.log(`incremental: ${pages} page(s), ${out.length} tickets in wanted forms${capped ? ' (CAPPED)' : ''}`);
  return { tickets: out, capped };
}

// First tag (in vocab order) that appears on the ticket, else null.
function firstTag(tags, vocab) { for (const v of vocab) if (tags.includes(v)) return v; return null; }

// Batch-resolve requester office+role from user profile fields (FALLBACK only)
async function resolveUsers(sub, ids) {
  const map = {};
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const url = `https://${sub}.zendesk.com/api/v2/users/show_many.json?ids=${chunk.join(',')}`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { console.log(`show_many failed (${res.status}) for a chunk; continuing`); continue; }
    const data = await res.json();
    for (const u of data.users || []) {
      const uf = u.user_fields || {};
      map[u.id] = { office: uf[OFFICE_FIELD] || null, role: uf[ROLE_FIELD] || null };
    }
  }
  console.log(`fallback resolved ${Object.keys(map).length} requester profiles`);
  return map;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  const sent = event.headers['x-parser-secret'] || event.headers['X-Parser-Secret'];
  if (!process.env.PARSER_SHARED_SECRET || sent !== process.env.PARSER_SHARED_SECRET)
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };

  try {
    const missing = ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN'].filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
    const sub = process.env.ZENDESK_SUBDOMAIN;

    const { keys: quarters, startTimeUnix } = buildQuarterWindow(QUARTERS_BACK);
    const quarterSet = new Set(quarters);

    const formMap = await resolveFormIds(sub);
    const wantedFormIds = new Set(Object.keys(formMap).map(Number));
    if (!wantedFormIds.size) throw new Error('Neither request form was found by name in this Zendesk account.');

    const { tickets, capped } = await fetchTicketsSince(sub, startTimeUnix, wantedFormIds);

    // Pass 1: office/role from tags; collect requesters that still need a fallback lookup.
    const needFallback = [];
    for (const t of tickets) {
      t.office = firstTag(t.tags, OFFICE_TAGS);
      t.role = firstTag(t.tags, ROLE_TAGS);
      if ((!t.office || !t.role) && t.requesterId) needFallback.push(t.requesterId);
    }
    const userMap = needFallback.length ? await resolveUsers(sub, needFallback) : {};

    // Pass 2: bucket brand(label) -> quarter -> office -> role -> count
    const cells = {};
    let counted = 0;
    for (const t of tickets) {
      const qk = quarterKey(new Date(t.createdAt));
      if (!quarterSet.has(qk)) continue;            // outside display window
      const label = formMap[t.formId];
      const u = userMap[t.requesterId] || {};
      const office = t.office || u.office || 'unspecified';
      const role = t.role || u.role || 'unspecified';
      const key = `${label}|${qk}|${office}|${role}`;
      cells[key] = (cells[key] || 0) + 1;
      counted++;
    }
    const cellList = Object.entries(cells).map(([k, count]) => {
      const [brand, quarter, office, role] = k.split('|');
      return { brand, quarter, office, role, count };
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, generatedAt: new Date().toISOString(),
        brands: LABELS, quarters,
        offices: [...new Set(cellList.map((c) => c.office))],
        roles: [...new Set(cellList.map((c) => c.role))],
        cells: cellList, ticketsCounted: counted, capped,
      }),
    };
  } catch (err) {
    const message = (err && (err.message || String(err))) || 'Unknown error';
    console.error('REQUEST-VOLUME ERROR:', message);
    if (err && err.stack) console.error(err.stack);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: message }) };
  }
};
