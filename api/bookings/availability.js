// /api/bookings/availability.js
//  GET  /api/bookings/availability?branch=X&date=YYYY-MM-DD

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
let cachedClient = null;

function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return (match && match[1]) ? match[1] : 'anura-tyres';
}

async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db(getDbName(MONGODB_URI));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── Canonical branch map (same as bookings.js) ───────────────────────────────
// Maps every known name variant → canonical key (lowercase location name only)
const BRANCH_VARIANT_MAP = {
  'anura tyres (pvt) ltd pannipitiya': 'pannipitiya',
  'anura tyres pvt ltd pannipitiya':   'pannipitiya',
  'pannipitiya':                        'pannipitiya',
  'pannipitiya branch':                 'pannipitiya',
  'anura tyres pannipitiya':            'pannipitiya',
  'anura tyre service pannipitiya':     'pannipitiya',

  'anura tyres (pvt) ltd ratnapura':   'ratnapura',
  'anura tyres pvt ltd ratnapura':     'ratnapura',
  'ratnapura':                          'ratnapura',
  'ratnapura branch':                   'ratnapura',
  'anura tyres ratnapura':              'ratnapura',
  'anura tyre service ratnapura':       'ratnapura',

  'anura tyres pvt ltd kalawana':      'kalawana',
  'kalawana':                           'kalawana',
  'kalawana branch':                    'kalawana',
  'anura tyres kalawana':               'kalawana',
  'anura tyre service kalawana':        'kalawana',

  'anura tyre service nivithigala':    'nivithigala',
  'nivithigala':                        'nivithigala',
  'nivithigala branch':                 'nivithigala',
  'anura tyres nivithigala':            'nivithigala',
  'anura tyres (pvt) ltd nivithigala':  'nivithigala',
};

// Returns the canonical key (e.g. "pannipitiya") for any branch name variant
function canonicalizeBranch(name) {
  if (!name) return '';
  return BRANCH_VARIANT_MAP[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

// Returns ALL known stored variants for a branch as an array for $in queries.
// This ensures bookings stored under ANY past name format are all counted.
function branchVariants(name) {
  const canon = canonicalizeBranch(name);
  const variants = Object.entries(BRANCH_VARIANT_MAP)
    .filter(([, v]) => v === canon)
    .map(([k]) =>
      // Restore title-case for the stored values
      k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    );
  // Also include the raw input in case it was stored verbatim and isn't in the map
  const raw = name.trim();
  if (!variants.map(v => v.toLowerCase()).includes(raw.toLowerCase())) {
    variants.push(raw);
  }
  return [...new Set(variants)];
}

// ─── Capacity per canonical branch ───────────────────────────────────────────
const BRANCH_CAPACITY = {
  'pannipitiya': 3,
  'ratnapura':   2,
  'kalawana':    2,
  'nivithigala': 2,
};

const ALL_TIME_SLOTS = [
  '08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00',
  '13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
  '17:00','17:30','18:00','18:30','19:00',
];

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const { branch, date } = req.query;
  if (!branch || !date) {
    return res.status(400).json({ success: false, message: 'branch and date are required' });
  }

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    // ── Canonicalize the incoming branch name ─────────────────────────────
    // e.g. "Anura Tyres (Pvt) Ltd Ratnapura" → "ratnapura"
    // This is the FIX: previously used branch.split(' ')[0] = "Anura"
    // which matched ALL branches. Now we match only THIS branch's variants.
    const canon    = canonicalizeBranch(branch);
    const variants = branchVariants(branch); // all stored name formats for this branch
    const capacity = BRANCH_CAPACITY[canon] ?? 2;

    // ── Date range in Sri Lanka timezone (UTC+5:30) ───────────────────────
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    dayStart.setMinutes(dayStart.getMinutes() - 330); // shift back 5h30m to UTC
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    // ── Query: only bookings for THIS branch on THIS date ─────────────────
    // $in over all known variants ensures we catch bookings stored under
    // any past name format — but ONLY for this branch, not others.
    const bookings = await col.find({
      'branch.name': { $in: variants },
      date:          { $gte: dayStart, $lte: dayEnd },
      status:        { $nin: ['Cancelled'] },
    }).project({ timeSlot: 1 }).toArray();

    // ── Count bookings per time slot ──────────────────────────────────────
    const slotCounts = {};
    for (const b of bookings) {
      if (b.timeSlot) slotCounts[b.timeSlot] = (slotCounts[b.timeSlot] || 0) + 1;
    }

    const slots = ALL_TIME_SLOTS.map(time => ({
      time,
      booked:    slotCounts[time] || 0,
      capacity,
      available: (slotCounts[time] || 0) < capacity,
    }));

    return res.status(200).json({ success: true, branch, date, capacity, slots });

  } catch (err) {
    console.error('availability.js error:', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};