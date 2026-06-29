// request-volume.js
// Read-only leadership function: counts request VOLUME for the Vevo Insights and
// Vevo Measurement brands, broken down by calendar quarter x office x role.
//
// Office and role come from the REQUESTER'S USER PROFILE FIELDS (not ticket tags),
// because Zendesk does not retroactively tag old tickets when a user's tags change.
// User field keys:  office = "office"  (Sales Region),  role = "role_level" (Role Level).
//
// Reuses env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN, PARSER_SHARED_SECRET
// Gated by X-Parser-Secret.

const BRAND_NAMES = ['Vevo Insights', 'Vevo Measurement']; // only these two are counted
const QUARTERS_BACK = 6;            // how many recent calendar quarters to include
const OFFICE_FIELD = 'office';      // user_fields key for Sales Region
const ROLE_FIELD = 'role_level';    // user_fields key for Role Level
const MAX_PAGES = 40;               // safety cap on incremental export pages (40k tickets)

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
  const earliest = startOfQuarter(y, q + 1 > 3 ? 0 : q + 1); // start of the oldest quarter included
  // recompute earliest cleanly from the first key
  const [fy, fq] = keys[0].split('-Q').map(Number);
  return { keys, startTimeUnix: Math.floor(startOfQuarter(fy, fq - 1).getTime() / 1000) };
}

async function resolveBrandIds(sub) {
  const map = {}; // id -> label  (only for wanted brands)
  let url = `https://${sub}.zendesk.com/api/v2/brands.json`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`brands fetch failed (${res.status})`);
  const data = await res.json();
  for (const b of data.brands || []) if (BRAND_NAMES.includes(b.name)) map[b.id] = b.name;
  const missing = BRAND_NAMES.filter((n) => !Object.values(map).includes(n));
  if (missing.length) console.log(`WARN: brand(s) not found: ${missing.join(', ')}`);
  return map;
}

// Incremental export (cursor) — pages of up to 1000, no 1000-result search cap
async function fetchTicketsSince(sub, startTimeUnix, wantedBrandIds) {
  let url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?start_time=${startTimeUnix}`;
  const out = []; let pages = 0; let capped = false;
  while (url) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`incremental tickets failed (${res.status}): ${b.slice(0,150)}`); }
    const data = await res.json();
    for (const t of data.tickets || []) {
      if (!wantedBrandIds.has(t.brand_id)) continue;
      if (!t.requester_id || !t.created_at) continue;
      out.push({ brandId: t.brand_id, requesterId: t.requester_id, createdAt: t.created_at });
    }
    pages++;
    if (data.end_of_stream || !data.after_cursor) break;
    url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(data.after_cursor)}`;
  }
  console.log(`incremental: ${pages} page(s), ${out.length} tickets in wanted brands${capped ? ' (CAPPED)' : ''}`);
  return { tickets: out, capped };
}

// Batch-resolve requester office+role from user profile fields
async function resolveUsers(sub, ids) {
  const map = {};
  const unique = [...new Set(ids)];
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
  console.log(`resolved ${Object.keys(map).length} requesters`);
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

    const brandMap = await resolveBrandIds(sub);
    const wantedBrandIds = new Set(Object.keys(brandMap).map(Number));
    if (!wantedBrandIds.size) throw new Error('Neither target brand was found in this Zendesk account.');

    const { tickets, capped } = await fetchTicketsSince(sub, startTimeUnix, wantedBrandIds);
    const userMap = await resolveUsers(sub, tickets.map((t) => t.requesterId));

    // bucket: brand -> quarter -> office -> role -> count
    const cells = {};
    let counted = 0;
    for (const t of tickets) {
      const qk = quarterKey(new Date(t.createdAt));
      if (!quarterSet.has(qk)) continue;            // outside display window
      const brand = brandMap[t.brandId];
      const u = userMap[t.requesterId] || {};
      const office = u.office || 'unspecified';
      const role = u.role || 'unspecified';
      const key = `${brand}|${qk}|${office}|${role}`;
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
        brands: BRAND_NAMES, quarters,
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
