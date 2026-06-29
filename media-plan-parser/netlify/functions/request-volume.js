// request-volume.js
// Read-only leadership function: counts request VOLUME for the Vevo Insights line
// (served by the "Vevo Research" brand, plus the legacy "Vevo Insights" brand) and the
// "Vevo Measurement" brand, broken down by calendar quarter x office x role.
//
// Office and role come from the REQUESTER'S USER PROFILE FIELDS (not ticket tags),
// because Zendesk does not retroactively tag old tickets when a user's tags change.
// User field keys:  office = "office"  (Sales Region),  role = "role_level" (Role Level).
//
// Reuses env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN, PARSER_SHARED_SECRET
// Gated by X-Parser-Secret.

const BRAND_NAMES = ['Vevo Research', 'Vevo Insights', 'Vevo Measurement']; // Research (+ legacy Insights) = "Insights"; Measurement = "Measurement"
const QUARTERS_BACK = 6;            // how many recent calendar quarters to include
const OFFICE_FIELD = 'office';      // user_fields key for Sales Region
const ROLE_FIELD = 'role_level';    // user_fields key for Role Level
const VERTICAL_FIELD_ID = 41940061600532; // "Vertical" multi-select ticket custom field
const MAX_PAGES = 40;               // safety cap on incremental export pages (40k tickets)

// Fallback label maker for a vertical option tag if the field definition can't be read.
function prettifyTag(tag) {
  return String(tag).replace(/^vert_/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

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
  const out = []; let pages = 0; let capped = false; let deletedSkipped = 0;
  while (url) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`incremental tickets failed (${res.status}): ${b.slice(0,150)}`); }
    const data = await res.json();
    for (const t of data.tickets || []) {
      if (!wantedBrandIds.has(t.brand_id)) continue;
      if (t.status === 'deleted') { deletedSkipped++; continue; } // incremental export includes deleted tickets
      if (!t.requester_id || !t.created_at) continue;
      // Vertical: prefer the multi-select custom field value; fall back to vert_* tags.
      let verticals = [];
      const cf = (t.custom_fields || []).find((f) => String(f.id) === String(VERTICAL_FIELD_ID));
      if (cf && cf.value != null && cf.value !== '') {
        verticals = Array.isArray(cf.value) ? cf.value : [cf.value];
      } else if (Array.isArray(t.tags)) {
        verticals = t.tags.filter((tg) => /^vert_/.test(tg));
      }
      out.push({ brandId: t.brand_id, requesterId: t.requester_id, createdAt: t.created_at, verticals });
    }
    pages++;
    if (data.end_of_stream || !data.after_cursor) break;
    url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?cursor=${encodeURIComponent(data.after_cursor)}`;
  }
  console.log(`incremental: ${pages} page(s), ${out.length} tickets in wanted brands, ${deletedSkipped} deleted skipped${capped ? ' (CAPPED)' : ''}`);
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

// Map vertical multi-select option tags -> human labels (e.g. "vert_tech" -> "Tech")
async function resolveVerticalOptions(sub) {
  const map = {};
  try {
    const url = `https://${sub}.zendesk.com/api/v2/ticket_fields/${VERTICAL_FIELD_ID}.json`;
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { console.log(`vertical field fetch failed (${res.status}); will prettify tags`); return map; }
    const data = await res.json();
    const opts = (data.ticket_field && data.ticket_field.custom_field_options) || [];
    for (const o of opts) map[o.value] = o.name;
    console.log(`resolved ${Object.keys(map).length} vertical options`);
  } catch (e) { console.log('vertical options error:', e.message); }
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
    const vertMap = await resolveVerticalOptions(sub);

    // bucket: brand -> quarter -> office -> role -> count
    const cells = {};
    // parallel bucket for vertical: brand -> quarter -> vertical -> count
    // (Vertical is a multi-select, so one ticket can add to more than one vertical;
    //  vertical totals can therefore exceed the request count for a quarter.)
    const vcells = {};
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

      // vertical bucketing
      const verts = (t.verticals || []).map((tag) => vertMap[tag] || prettifyTag(tag)).filter(Boolean);
      if (verts.length === 0) {
        const vk = `${brand}|${qk}|Unspecified`;
        vcells[vk] = (vcells[vk] || 0) + 1;
      } else {
        for (const v of verts) {
          const vk = `${brand}|${qk}|${v}`;
          vcells[vk] = (vcells[vk] || 0) + 1;
        }
      }
    }
    const cellList = Object.entries(cells).map(([k, count]) => {
      const [brand, quarter, office, role] = k.split('|');
      return { brand, quarter, office, role, count };
    });
    const vcellList = Object.entries(vcells).map(([k, count]) => {
      const [brand, quarter, vertical] = k.split('|');
      return { brand, quarter, vertical, count };
    });

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true, generatedAt: new Date().toISOString(),
        brands: BRAND_NAMES, quarters,
        offices: [...new Set(cellList.map((c) => c.office))],
        roles: [...new Set(cellList.map((c) => c.role))],
        cells: cellList,
        verticals: [...new Set(vcellList.map((c) => c.vertical))],
        verticalCells: vcellList,
        ticketsCounted: counted, capped,
      }),
    };
  } catch (err) {
    const message = (err && (err.message || String(err))) || 'Unknown error';
    console.error('REQUEST-VOLUME ERROR:', message);
    if (err && err.stack) console.error(err.stack);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: message }) };
  }
};
