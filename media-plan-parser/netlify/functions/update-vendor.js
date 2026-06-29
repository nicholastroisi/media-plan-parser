// update-vendor.js
// Write-function: saves the measurement team's CONFIRMED vendor selection back to the
// Zendesk ticket's "Confirmed Measurement Vendors" multi-select field (id 50558994017684).
//
// This is the only function that WRITES to Zendesk. Because it modifies tickets, the
// dashboard that calls it must sit behind real access protection (Netlify site password) —
// the shared secret alone is not sufficient for a write capability.
//
// Request (POST JSON):  { "ticketId": 469, "vendors": ["nielsen","disqo"] }
//   vendors = array of the CONFIRMED field's option tags (bare: disqo|nielsen|ispot|adelaide|other)
// Reuses env vars: ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, ZENDESK_API_TOKEN, PARSER_SHARED_SECRET

const CONFIRMED_FIELD_ID = 50558994017684;
const VALID_TAGS = ['disqo', 'nielsen', 'ispot', 'adelaide', 'other'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Parser-Secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function authHeader() {
  const token = Buffer
    .from(`${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`)
    .toString('base64');
  return `Basic ${token}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ ok: false, error: 'POST only' }) };

  const sent = event.headers['x-parser-secret'] || event.headers['X-Parser-Secret'];
  if (!process.env.PARSER_SHARED_SECRET || sent !== process.env.PARSER_SHARED_SECRET)
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };

  try {
    const missing = ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN']
      .filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

    const { ticketId, vendors } = JSON.parse(event.body || '{}');
    if (!ticketId) throw new Error('Missing ticketId');
    if (!Array.isArray(vendors)) throw new Error('vendors must be an array of tags');

    // validate every tag against the known option set (reject anything unexpected)
    const bad = vendors.filter((t) => !VALID_TAGS.includes(t));
    if (bad.length) throw new Error(`Invalid vendor tag(s): ${bad.join(', ')}`);

    console.log(`=== set confirmed vendors on ticket ${ticketId}: [${vendors.join(', ')}] ===`);

    const sub = process.env.ZENDESK_SUBDOMAIN;
    const url = `https://${sub}.zendesk.com/api/v2/tickets/${ticketId}.json`;
    const payload = { ticket: { custom_fields: [{ id: CONFIRMED_FIELD_ID, value: vendors }] } };

    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`ticket update -> status ${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zendesk update failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    // read back what Zendesk stored, so the dashboard can confirm
    const saved = (data.ticket.custom_fields || []).find((f) => f.id === CONFIRMED_FIELD_ID);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, ticketId, saved: saved ? saved.value : vendors }),
    };
  } catch (err) {
    const message = (err && (err.message || String(err))) || 'Unknown error';
    console.error('UPDATE-VENDOR ERROR:', message);
    if (err && err.stack) console.error(err.stack);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: message }) };
  }
};
