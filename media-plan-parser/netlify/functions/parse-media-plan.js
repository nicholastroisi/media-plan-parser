// parse-media-plan.js
// Netlify serverless function. Does the part a browser ZAF app cannot:
//   1. Fetch the ticket's latest spreadsheet attachment from the Zendesk API (server-side, no CORS).
//   2. Parse it with SheetJS applying the agreed parsing contract.
//   3. Return clean JSON line items for the sidebar app to map into ticket fields.
//
// The browser only sends a ticketId. All Zendesk credentials live in Netlify env vars,
// so no secret is exposed client-side.
//
// Required Netlify environment variables:
//   ZENDESK_SUBDOMAIN     e.g. "vevoresearch"  (the part before .zendesk.com)
//   ZENDESK_EMAIL         an agent/admin email with API access
//   ZENDESK_API_TOKEN     a Zendesk API token (Admin Center > Apps and integrations > APIs > Zendesk API)
//   PARSER_SHARED_SECRET  any long random string; the sidebar app must send it in X-Parser-Secret

const XLSX = require('xlsx');

// ---------- column synonym dictionary (lower-case, trimmed) ----------
const SYN = {
  name:   ['line item name', 'content', 'name'],
  start:  ['start date'],
  end:    ['end date'],
  imps:   ['quantity', 'impressions', 'imps'],
  budget: ['budget', 'net cost'],
};
// Budget must NEVER come from these:
const BUDGET_FORBIDDEN = ['rate', 'net rate', 'rate type', 'cpm'];
const TERMINATORS = ['total', 'grand total', 'notes', 'terms and conditions'];

// ---------- value coercion helpers ----------
function cleanNumber(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === '' || s === '-') return null;
  s = s.replace(/[$,\s]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function pad(n) { return String(n).padStart(2, '0'); }

function isDateObj(v) {
  // robust across realms (instanceof Date can fail for lib-created dates)
  return v != null && (Object.prototype.toString.call(v) === '[object Date]'
    || typeof v.getUTCFullYear === 'function');
}

function dateToISO(d) {
  // d is a JS Date; use UTC parts to avoid TZ drift
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseDateString(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === '' || s === '-') return null;

  // yyyy-mm-dd (possibly with time)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;

  // m/d/yy or m/d/yyyy
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let yr = +m[3];
    if (yr < 100) yr += 2000;
    return `${yr}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  return null; // unrecognized -> let caller flag empty
}

// Handles a single cell that may hold a date, an Excel serial, or a RANGE
// like "12/5/26 - 12/11/26". Returns {start, end} where either may be null.
function extractDates(cell) {
  if (isDateObj(cell)) return { start: dateToISO(cell), end: null };
  if (typeof cell === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + cell * 86400000);
    return { start: dateToISO(d), end: null };
  }
  if (cell === null || cell === undefined) return { start: null, end: null };
  const s = String(cell).trim();
  // range split on hyphen or en-dash surrounded by spaces
  const parts = s.split(/\s+[-\u2013]\s+/);
  if (parts.length === 2) {
    return { start: parseDateString(parts[0]), end: parseDateString(parts[1]) };
  }
  return { start: parseDateString(s), end: null };
}

// ---------- header + column detection ----------
function findHeaderRow(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] || []).map(c => (c == null ? '' : String(c).toLowerCase().trim()));
    const hasStart = cells.some(c => c === 'start date');
    const hasEnd = cells.some(c => c === 'end date');
    if (hasStart && hasEnd) return i;
  }
  return -1;
}

function mapColumns(headerCells, warnings) {
  const norm = headerCells.map(c => (c == null ? '' : String(c).toLowerCase().trim()));
  const col = { name: -1, start: -1, end: -1, imps: -1, budget: -1 };

  for (const key of Object.keys(SYN)) {
    for (let i = 0; i < norm.length; i++) {
      if (SYN[key].includes(norm[i])) { col[key] = i; break; }
    }
  }
  // Guard: never let budget land on a rate column even if something odd matched
  if (col.budget !== -1 && BUDGET_FORBIDDEN.includes(norm[col.budget])) col.budget = -1;

  for (const key of Object.keys(col)) {
    if (col[key] === -1) warnings.push(`Column for "${key}" not found in header; that field left empty.`);
  }
  return col;
}

function isTerminator(rowFirstText) {
  const t = String(rowFirstText || '').toLowerCase().trim();
  return TERMINATORS.some(term => t.startsWith(term));
}

function firstText(row) {
  for (const c of row) if (c != null && String(c).trim() !== '') return String(c).trim();
  return '';
}

// Parse one worksheet -> {lineItems, totalSpend, headerRowIndex, warnings, columns}
function parseSheet(ws) {
  const warnings = [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const hIdx = findHeaderRow(rows);
  if (hIdx === -1) return { error: 'No header row (with Start Date and End Date) found.', warnings };

  const col = mapColumns(rows[hIdx], warnings);
  const lineItems = [];
  let totalSpend = null;

  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const ft = firstText(row);
    if (isTerminator(ft)) {
      // capture total spend from this row's budget column if present
      if (col.budget !== -1) totalSpend = cleanNumber(row[col.budget]);
      break;
    }
    // skip fully blank rows but keep scanning
    if (row.every(c => c == null || String(c).trim() === '')) continue;

    const name = col.name !== -1 && row[col.name] != null ? String(row[col.name]).trim() : null;

    // dates: prefer explicit start/end columns; if start col holds a range, split it
    let startISO = null, endISO = null;
    if (col.start !== -1) {
      const ex = extractDates(row[col.start]);
      startISO = ex.start; endISO = ex.end;
    }
    if (col.end !== -1) {
      const exEnd = extractDates(row[col.end]);
      if (exEnd.start) endISO = exEnd.start; // end column holds the end date
    }

    const budget = col.budget !== -1 ? cleanNumber(row[col.budget]) : null;
    const imps = col.imps !== -1 ? cleanNumber(row[col.imps]) : null;

    lineItems.push({ name, startDate: startISO, endDate: endISO, budget, imps });
  }

  return { lineItems, totalSpend, headerRowIndex: hIdx + 1, warnings, columns: col };
}

// ---------- Zendesk attachment retrieval ----------
function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return `Basic ${token}`;
}

async function findLatestSpreadsheet(ticketId) {
  const sub = process.env.ZENDESK_SUBDOMAIN;
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable in this runtime');
  let url = `https://${sub}.zendesk.com/api/v2/tickets/${ticketId}/comments.json?page[size]=100`;
  let match = null; // {url, name, created}
  let commentCount = 0, attachmentCount = 0;
  // walk comments (paginated); later comments are more recent
  while (url) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    console.log(`comments fetch -> status ${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zendesk comments fetch failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const c of data.comments || []) {
      commentCount++;
      for (const a of c.attachments || []) {
        attachmentCount++;
        console.log(`  attachment: ${a.file_name}`);
        if (/\.(xlsx|xls|csv)$/i.test(a.file_name || '')) {
          match = { url: a.content_url, name: a.file_name, created: c.created_at };
        }
      }
    }
    url = data.meta && data.meta.has_more ? data.links.next : null;
  }
  console.log(`scanned ${commentCount} comments, ${attachmentCount} attachments; spreadsheet match: ${match ? match.name : 'none'}`);
  return match;
}

async function downloadBuffer(contentUrl) {
  // content_url often redirects to signed storage; fetch follows redirects by default
  const res = await fetch(contentUrl, { headers: { Authorization: authHeader() } });
  console.log(`attachment download -> status ${res.status}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Attachment download failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  console.log(`downloaded ${ab.byteLength} bytes`);
  return Buffer.from(ab);
}

// ---------- handler ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Parser-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  // shared-secret check
  const sent = event.headers['x-parser-secret'] || event.headers['X-Parser-Secret'];
  if (!process.env.PARSER_SHARED_SECRET || sent !== process.env.PARSER_SHARED_SECRET)
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };

  try {
    const { ticketId } = JSON.parse(event.body || '{}');
    if (!ticketId) throw new Error('Missing ticketId');
    console.log(`=== parse request for ticket ${ticketId} ===`);

    // surface missing configuration clearly instead of failing deep in a fetch
    const missing = ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN']
      .filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

    const file = await findLatestSpreadsheet(ticketId);
    if (!file)
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: false, error: 'No media plan spreadsheet found on this ticket.' }) };

    const buf = await downloadBuffer(file.url);
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    console.log(`workbook opened; tabs: ${wb.SheetNames.join(', ')}`);

    // choose the tab with the highest spend
    const warnings = [];
    let best = null; // {name, parsed, spend}
    for (const sheetName of wb.SheetNames) {
      const parsed = parseSheet(wb.Sheets[sheetName]);
      if (parsed.error) continue;
      let spend = parsed.totalSpend;
      if (spend == null) {
        // fallback: dollar amount embedded in the tab name, e.g. "$500K" -> 500000
        const m = sheetName.match(/\$?\s*([\d.]+)\s*([kKmM])?/);
        if (m) {
          let n = parseFloat(m[1]);
          if (m[2] && m[2].toLowerCase() === 'k') n *= 1000;
          if (m[2] && m[2].toLowerCase() === 'm') n *= 1000000;
          spend = n;
          warnings.push(`Tab "${sheetName}": no Total row found; used tab name for spend ($${spend}).`);
        } else spend = 0;
      }
      if (!best || spend > best.spend) best = { name: sheetName, parsed, spend };
    }

    if (!best)
      return { statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: false, error: 'No parseable tab (no header row found in any tab).', fileName: file.name }) };

    console.log(`chosen tab "${best.name}", spend ${best.spend}, ${best.parsed.lineItems.length} line items`);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        ok: true,
        fileName: file.name,
        chosenTab: best.name,
        totalSpend: best.spend,
        headerRowIndex: best.parsed.headerRowIndex,
        count: best.parsed.lineItems.length,
        lineItems: best.parsed.lineItems,
        warnings: warnings.concat(best.parsed.warnings),
      }),
    };
  } catch (err) {
    // never return a blank error; log full detail to the function console
    const message = (err && (err.message || String(err))) || 'Unknown error';
    console.error('PARSE ERROR:', message);
    if (err && err.stack) console.error(err.stack);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: message }) };
  }
};
