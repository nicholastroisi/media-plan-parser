// campaign-dashboard.js
// Read-only Netlify function for the Campaign Timeline dashboard.
// Returns every active campaign ticket (a specific ticket form) with its sponsorship
// line items and a derived flight span (earliest start -> latest end). The dashboard
// frontend renders the nested timeline from this JSON. This function never writes anything.
//
// Required Netlify environment variables (reuses the ones the parser already set, plus one):
//   ZENDESK_SUBDOMAIN
//   ZENDESK_EMAIL
//   ZENDESK_API_TOKEN
//   PARSER_SHARED_SECRET   (same shared secret; sent back in X-Parser-Secret)
//   CAMPAIGN_FORM_ID       (the ticket form id that identifies campaign tickets)

// slot -> the five custom field IDs for that sponsorship line item
const FIELD_MAP = {
  1: { name:49827095285012, start:49827560945556, end:49827595376788, budget:49828302368788, imps:49827713955092 },
  2: { name:49827080937492, start:49827552524948, end:49827587903508, budget:49828290987156, imps:49827715954452 },
  3: { name:49827109479444, start:49827524175636, end:49827575229844, budget:49828307571220, imps:49827710208020 },
  4: { name:49827257789844, start:49827525324308, end:49827614633620, budget:49828278382996, imps:49827733122452 },
  5: { name:49827237647380, start:49827565515028, end:49827616104980, budget:49828294194196, imps:49827778420628 },
  6: { name:49827277701268, start:49827557676052, end:49827620780180, budget:49828325788948, imps:49827796173716 },
  7: { name:49833577712404, start:49837229408148, end:49838058409876, budget:49836784578324, imps:49836030514452 },
  8: { name:49833563020820, start:49837246518676, end:49838070832020, budget:49836814675220, imps:49836076920596 },
  9: { name:49833547812116, start:49837256202388, end:49838071564436, budget:49836800232980, imps:49836078892948 },
  10: { name:49833565662484, start:49837256992020, end:49838080661780, budget:49836837875220, imps:49836062838548 },
  11: { name:49833633638676, start:49837308246292, end:49838073647636, budget:49836838742804, imps:49836065419156 },
  12: { name:49833706205588, start:49837269363476, end:49838096126228, budget:49836839597076, imps:49836112141460 },
  13: { name:49834719629076, start:49839447102100, end:49838083394964, budget:49836810862740, imps:49836099027348 },
  14: { name:49834752206228, start:49837311918612, end:49838090990228, budget:49839389549204, imps:49836135039380 },
  15: { name:49834769364116, start:49837312950420, end:49838085144724, budget:49836826898196, imps:49836124263060 },
  16: { name:49834755069076, start:49837304661268, end:49838108634772, budget:49836827701780, imps:49836158726804 },
  17: { name:49834755868820, start:49837305938580, end:49838109623188, budget:49836863919252, imps:49836130935572 },
  18: { name:49834757007380, start:49837350754196, end:49838101094548, budget:49836891204372, imps:49836172129940 },
  19: { name:49834793050388, start:49837319983892, end:49838102047508, budget:49836877537556, imps:49836162746260 },
  20: { name:49834810442516, start:49837345096724, end:49838115022612, budget:49836861045012, imps:49836200401556 },
  21: { name:49834795498900, start:49837360934292, end:49838146775700, budget:49836862156308, imps:49836211091732 },
  22: { name:49834827869076, start:49837331236372, end:49838116935572, budget:49836915562132, imps:49836236586772 },
  23: { name:49835212552212, start:49837357216404, end:49838142793620, budget:49836932119188, imps:49836237872788 },
  24: { name:49835228736788, start:49837376172692, end:49838156516756, budget:49836924689940, imps:49836229323540 },
  25: { name:49835202574612, start:49837392400660, end:49838163891476, budget:49836918651796, imps:49836244524820 },
  26: { name:49835200085908, start:49837400515220, end:49838150675476, budget:49836919412500, imps:49836232464148 },
  27: { name:49835407178516, start:49837401381524, end:49838151418004, budget:49836912876820, imps:49836246972308 },
  28: { name:49835434554004, start:49837373193236, end:49838159819284, budget:49836947333396, imps:49836285080596 },
  29: { name:49835402604436, start:49837374034580, end:49838196612884, budget:49836972005268, imps:49836286102292 },
  30: { name:49835453811860, start:49837405397908, end:49838171268116, budget:49836973385876, imps:49836280091668 },
  31: { name:49835438558356, start:49837441997076, end:49838186332436, budget:49836951149844, imps:49836312306196 },
  32: { name:49835425035412, start:49837399221268, end:49838259813268, budget:49836990933140, imps:49836299630356 },
  33: { name:49835464198676, start:49838277505300, end:49838199187988, budget:49836952991380, imps:49836302881812 },
  34: { name:49835441034516, start:49837418451220, end:49838322662036, budget:49836981909140, imps:49836335639316 },
  35: { name:49835427119380, start:49837436934036, end:49838299052692, budget:49836968531988, imps:49836321373716 },
  36: { name:49835442569492, start:49837461119508, end:49838324463764, budget:49836998674836, imps:49836368996116 },
  37: { name:49835535830932, start:49837447731988, end:49838325180436, budget:49836979553940, imps:49836329662484 },
  38: { name:49835467613716, start:49837454662932, end:49838311371412, budget:49837009009940, imps:49836343107988 },
  39: { name:49835468622612, start:49837432877204, end:49838367472532, budget:49836985341332, imps:49836340189460 },
  40: { name:49835481333780, start:49837467626772, end:49838338838676, budget:49837016554388, imps:49836345126804 },
  41: { name:49835511016852, start:49837485538068, end:49838362087700, budget:49837033614484, imps:49836357523220 },
  42: { name:49835521892500, start:49837500421524, end:49838362882836, budget:49837013249428, imps:49836363083924 },
  43: { name:49835542977812, start:49837478046996, end:49838414707348, budget:49837036483220, imps:49836387776148 },
  44: { name:49835591611412, start:49837504363540, end:49838440931476, budget:49837020094996, imps:49836365121812 },
  45: { name:49835568931220, start:49837491558164, end:49838749932948, budget:49837050026004, imps:49836401826452 },
  46: { name:49835606314516, start:49837506110996, end:49838755655188, budget:49837050761748, imps:49836366934292 },
  47: { name:49835614637972, start:49837536174612, end:49838795169556, budget:49837038732820, imps:49836403773204 },
  48: { name:49835601251220, start:49837522901908, end:49838779538836, budget:49837074660116, imps:49839428489236 },
  49: { name:49835609231380, start:49837523948052, end:49838797266452, budget:49837082317588, imps:49836570331924 },
  50: { name:49835616917268, start:49837643010324, end:49838774617364, budget:49837066751892, imps:49836508030100 },
  51: { name:49835617663892, start:49837617901972, end:49838808486804, budget:49837078338964, imps:49836542214420 },
  52: { name:49835638381204, start:49837600441364, end:49838859755156, budget:49837085165972, imps:49836526677908 },
  53: { name:49835621538836, start:49837660462740, end:49838853044372, budget:49837085880084, imps:49836573722004 },
  54: { name:49835637552532, start:49837621869588, end:49838868156948, budget:49837123025812, imps:49836563004692 },
  55: { name:49835671952276, start:49837622848148, end:49838828681620, budget:49837103447828, imps:49836588450836 },
  56: { name:49835672882452, start:49837649613204, end:49838886469140, budget:49837111793812, imps:49836597399060 },
  57: { name:49835673835540, start:49837669291924, end:49838856074132, budget:49837133214740, imps:49836628054676 },
  58: { name:49835691046292, start:49837642171028, end:49838871053588, budget:49837118668820, imps:49836629039892 },
  59: { name:49835803819796, start:49837694107412, end:49838879753876, budget:49837157244436, imps:49836568893844 },
  60: { name:49835867688340, start:49837672415636, end:49838907710740, budget:49837148854164, imps:49836616266516 },
  61: { name:49835838718996, start:49837681077908, end:49838918486548, budget:49837142948756, imps:49836639716756 },
  62: { name:49835873650196, start:49837699724692, end:49838914313108, budget:49837150923412, imps:49836619087636 },
  63: { name:49835875444884, start:49837675282324, end:49838921094804, budget:49837145445524, imps:49836643682836 },
  64: { name:49835862926356, start:49837684738068, end:49838930854164, budget:49837163117844, imps:49836655102740 },
  65: { name:49839391619348, start:49837719810196, end:49838964629908, budget:49837167300372, imps:49836688912532 }
};

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

function asStr(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// Build id -> value lookup for one ticket's custom_fields array
function fieldLookup(ticket) {
  const map = {};
  for (const f of ticket.custom_fields || []) map[f.id] = f.value;
  return map;
}

// Extract populated sponsorship slots + derive the campaign span
function extractSponsorships(ticket) {
  const lk = fieldLookup(ticket);
  const sponsorships = [];
  let minStart = null, maxEnd = null;
  for (let slot = 1; slot <= 65; slot++) {
    const ids = FIELD_MAP[slot];
    const name = asStr(lk[ids.name]);
    const start = asStr(lk[ids.start]);
    const end = asStr(lk[ids.end]);
    const budget = lk[ids.budget];
    const imps = lk[ids.imps];
    // a slot counts as present if it has a name or any date
    if (!name && !start && !end) continue;
    sponsorships.push({ slot, name: name || null, start: start || null, end: end || null,
                        budget: budget ?? null, imps: imps ?? null });
    if (start && (!minStart || start < minStart)) minStart = start; // ISO yyyy-mm-dd sorts lexically
    if (end && (!maxEnd || end > maxEnd)) maxEnd = end;
  }
  return { sponsorships, spanStart: minStart, spanEnd: maxEnd };
}

async function fetchCustomStatusMap() {
  const sub = process.env.ZENDESK_SUBDOMAIN;
  const map = {};
  try {
    const res = await fetch(`https://${sub}.zendesk.com/api/v2/custom_statuses.json`,
      { headers: { Authorization: authHeader() } });
    if (res.ok) {
      const data = await res.json();
      for (const s of data.custom_statuses || []) map[s.id] = { label: s.agent_label, category: s.status_category };
    } else {
      console.log(`custom_statuses fetch -> status ${res.status} (continuing without labels)`);
    }
  } catch (e) {
    console.log(`custom_statuses fetch error: ${e.message} (continuing)`);
  }
  return map;
}

async function fetchCampaignTickets() {
  const sub = process.env.ZENDESK_SUBDOMAIN;
  const formId = process.env.CAMPAIGN_FORM_ID;
  // active campaigns: this form, not closed. (custom statuses still roll up to a base category)
  const query = `type:ticket ticket_form_id:${formId} -status:closed`;
  let url = `https://${sub}.zendesk.com/api/v2/search.json?query=${encodeURIComponent(query)}&page[size]=100`;
  const tickets = [];
  let pages = 0;
  while (url && pages < 10) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    console.log(`search page ${pages + 1} -> status ${res.status}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Zendesk search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const t of data.results || []) tickets.push(t);
    url = data.meta && data.meta.has_more ? data.links.next : null;
    pages++;
  }
  console.log(`fetched ${tickets.length} campaign tickets`);
  return tickets;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const sent = event.headers['x-parser-secret'] || event.headers['X-Parser-Secret'];
  if (!process.env.PARSER_SHARED_SECRET || sent !== process.env.PARSER_SHARED_SECRET)
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ ok: false, error: 'Unauthorized' }) };

  try {
    const missing = ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN', 'CAMPAIGN_FORM_ID']
      .filter((k) => !process.env[k]);
    if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);

    const statusMap = await fetchCustomStatusMap();
    const tickets = await fetchCampaignTickets();

    const campaigns = tickets.map((t) => {
      const { sponsorships, spanStart, spanEnd } = extractSponsorships(t);
      const cs = t.custom_status_id ? statusMap[t.custom_status_id] : null;
      return {
        id: t.id,
        subject: t.subject || null,
        organizationId: t.organization_id || null,
        statusCategory: t.status || null,           // new/open/pending/hold/solved
        statusLabel: cs ? cs.label : (t.status || null), // custom status name when available
        spanStart, spanEnd,
        sponsorshipCount: sponsorships.length,
        sponsorships,
      };
    });

    console.log(`returning ${campaigns.length} campaigns`);
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, generatedAt: new Date().toISOString(),
                             count: campaigns.length, campaigns }),
    };
  } catch (err) {
    const message = (err && (err.message || String(err))) || 'Unknown error';
    console.error('DASHBOARD ERROR:', message);
    if (err && err.stack) console.error(err.stack);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, error: message }) };
  }
};
