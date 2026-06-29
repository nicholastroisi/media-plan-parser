// request-volume.js  (v3 — classify strictly by FORM, with full diagnostics)
// Read-only leadership function: counts request VOLUME by calendar quarter x office x role.
//
// CLASSIFICATION (the only thing that decides Insights vs Measurement):
//   - Form "US Insights Request"      -> Vevo Insights
//   - Form "US Measurement Request"   -> Vevo Measurement
//   - Form "UK & AUS Research Request"-> ignored (not US)
//   Brand is NOT used: Insights tickets are stamped brand "Vevo Research" and
//   Measurement tickets "Vevo Measurement", so brand is unreliable. The FORM is
//   stamped consistently on every ticket, so we key on that.
//
// Form names are matched case-insensitively against BOTH the form's internal `name`
// and its `display_name` (those can differ in Zendesk). If an exact match isn't found,
// we fall back to a substring match (insight / measurement), excluding UK/AUS.
//
// OFFICE/ROLE come from the TICKET'S TAGS (e.g. "east_coast",
// "account_service_representative"), falling back to the requester's user-profile
// fields (office / role_level) only when a ticket has no matching office/role tag.
//
// This build logs heavy DIAGNOSTICS to the Netlify function log so we can see exactly
// which forms exist, how each was classified, how many tickets landed in each bucket,
// and how often office/role tags were present. Output schema is unchanged, so
// leadership-volume.html needs no edits.
//
// Env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN, PARSER_SHARED_SECRET
// Gated by X-Parser-Secret.

const LABELS = ['Vevo Insights', 'Vevo Measurement']; // for the dashboard legend
const QUARTERS_BACK = 6;
const MAX_PAGES = 40; // safety cap on incremental export pages (~40k tickets)

// Tag vocabularies — mirror OFFICE_ORDER / ROLE_ORDER in leadership-volume.html.
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

// Decide the label for a form from its name / display_name. Returns a label string,
// 'IGNORED' (recognized but not US), or null (unrecognized).
function classifyForm(name, displayName) {
  const cands = [name, displayName].filter(Boolean).map((s) => String(s).trim().toLowerCase());
  for (const c of cands) {
    if (c === 'us insights request') return 'Vevo Insights';
    if (c === 'us measurement request') return 'Vevo Measurement';
    if (c === 'uk & aus research request') return 'IGNORED';
  }
  // Fallback: substring, but never count UK/AUS as US.
  for (const c of cands) {
    if (/\buk\b|\baus\b|australia|international/.test(c)) return 'IGNORED';
    if (c.includes('insight')) return 'Vevo Insights';
    if (c.includes('measurement')) return 'Vevo Measurement';
  }
  return null;
}

// Resolve which form IDs map to which label, and LOG every form we find.
async function resolveFormIds(sub) {
  const url = `https://${sub}.zendesk.com/api/v2/ticket_forms.json`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`ticket_forms fetch failed (${res.status})`);
  const data = await res.json();
  const map = {}; // formId -> label ('Vevo Insights' | 'Vevo Measurement')
  console.log(`--- FORMS FOUND (${(data.ticket_forms || []).length}) ---`);
  for (const f of data.ticket_forms || []) {
    const label = classifyForm(f.name, f.display_name);
    console.log(`FORM id=${f.id} active=${f.active} name="${f.name}" display_name="${f.display_name}" -> ${label || 'UNRECOGNIZED'}`);
    if (label === 'Vevo Insights' || label === 'Vevo Measurement') map[f.id] = label;
  }
  const labelsMatched = [...new Set(Object.values(map))];
  console.log(`--- FORMS MATCHED: ${labelsMatched.join(', ') || '(none)'} ---`);
  return map;
}

// Incremental export (cursor) — pages of up to 1000, no 1000-result search cap
async function fetchTicketsSince(sub, startTimeUnix, wantedFormIds) {
  let url = `https://${sub}.zendesk.com/api/v2/incremental/tickets/cursor.json?start_time=${startTimeUnix}`;
  const out = []; let pages = 0; let scanned = 0; let capped = false;
  while (url) {
    if (pages >= MAX_PAGES) { capped = true; break; }
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) { const b = await res.text().catch(() => ''); throw new Error(`incremental tickets failed (${res.status}): ${b.slice(0, 150)}`); }
    const data = await res.json();
    for (const t of data.tickets || []) {
      scanned++;
      if (t.status === 'deleted') continue;             // Zendesk streams deleted/scrubbed tickets; drop them
      if (!wantedFormIds.has(t.ticket_form_id)) continue; // classify by FORM
      if (!t.created_at) continue;
      out.push({
        id: t.id,
        subject: t.subject || t.raw_subject || '',
        status: t.status || '',
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
  console.log(`incremental: ${pages} page(s), ${scanned} tickets scanned, ${out.length} matched a wanted form${capped ? ' (CAPPED)' : ''}`);
  return { tickets: out, capped };
}

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
  console.log(`fallback profiles resolved: ${Object.keys(map).length}`);
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
    if (!wantedFormIds.size) throw new Error('No US Insights / US Measurement form matched. See FORMS FOUND log lines above.');

    const { tickets, capped } = await fetchTicketsSince(sub, startTimeUnix, wantedFormIds);

    // DIAGNOSTIC: list every Measurement-form ticket so we can see what they actually are.
    // (Dumps ID, created-quarter, status, tags, and subject for each one.)
    const measTickets = tickets.filter((t) => formMap[t.formId] === 'Vevo Measurement');
    const measByQuarter = {};
    for (const t of measTickets) {
      const qk = quarterKey(new Date(t.createdAt));
      measByQuarter[qk] = (measByQuarter[qk] || 0) + 1;
    }
    console.log(`--- MEASUREMENT-FORM TICKETS: ${measTickets.length} total ---`);
    console.log(`MEAS by quarter: ${JSON.stringify(measByQuarter)}`);
    for (const t of measTickets) {
      const qk = quarterKey(new Date(t.createdAt));
      const subj = String(t.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 70);
      console.log(`MEAS id=${t.id} q=${qk} status=${t.status} tags=[${t.tags.join(',')}] subject="${subj}"`);
    }
    console.log(`--- END MEASUREMENT DUMP ---`);

    // Pass 1: office/role from tags; collect requesters that need a profile fallback.
    const needFallback = [];
    for (const t of tickets) {
      t.officeTag = firstTag(t.tags, OFFICE_TAGS);
      t.roleTag = firstTag(t.tags, ROLE_TAGS);
      if ((!t.officeTag || !t.roleTag) && t.requesterId) needFallback.push(t.requesterId);
    }
    const userMap = needFallback.length ? await resolveUsers(sub, needFallback) : {};

    // Pass 2: bucket label -> quarter -> office -> role -> count, gathering diagnostics.
    const cells = {};
    let counted = 0;
    const diag = {}; // label -> {tot, officeTag, roleTag, officeAny, roleAny}
    const bump = (lbl) => (diag[lbl] || (diag[lbl] = { tot: 0, officeTag: 0, roleTag: 0, officeAny: 0, roleAny: 0 }));
    for (const t of tickets) {
      const qk = quarterKey(new Date(t.createdAt));
      if (!quarterSet.has(qk)) continue; // outside display window
      const label = formMap[t.formId];
      const u = userMap[t.requesterId] || {};
      const office = t.officeTag || u.office || 'unspecified';
      const role = t.roleTag || u.role || 'unspecified';

      const d = bump(label);
      d.tot++;
      if (t.officeTag) d.officeTag++;
      if (t.roleTag) d.roleTag++;
      if (office !== 'unspecified') d.officeAny++;
      if (role !== 'unspecified') d.roleAny++;

      const key = `${label}|${qk}|${office}|${role}`;
      cells[key] = (cells[key] || 0) + 1;
      counted++;
    }

    // Diagnostics: per-label counts and tag coverage (in display window).
    for (const lbl of Object.keys(diag)) {
      const d = diag[lbl];
      console.log(`BUCKET "${lbl}": ${d.tot} tickets in window | office from tag ${d.officeTag}/${d.tot}, any ${d.officeAny}/${d.tot} | role from tag ${d.roleTag}/${d.tot}, any ${d.roleAny}/${d.tot}`);
    }
    console.log(`TOTAL counted in window: ${counted}`);

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
