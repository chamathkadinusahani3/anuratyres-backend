// /api/bookings.js

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

// ─── DB connection ───────────────────────────────────────────────
let cachedClient = null;

function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match && match[1] ? match[1] : 'anura-tyres';
}

async function getDb() {
  if (!cachedClient) {
    cachedClient = await MongoClient.connect(MONGODB_URI);
  }
  return cachedClient.db(getDbName(MONGODB_URI));
}

// ─── CORS ────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Role, X-User-Branch');
}

// ─── CANONICAL BRANCH MAP ────────────────────────────────────────
// Source of truth for every branch name variant seen across:
//   Website (from types.ts BRANCHES array)  → branch.name sent in POST body
//   Admin manual booking (BookingsPage.tsx) → shortName sent in POST body
//   Old DB records                          → whatever was stored historically
//
// All variants map to a lowercase canonical key used only for comparison.
//
const BRANCH_VARIANT_MAP = {
  // ── Pannipitiya ──────────────────────────────────────────────────
  // website sends:
  'anura tyres (pvt) ltd pannipitiya':  'pannipitiya',
  // admin manual sends:
  'pannipitiya':                         'pannipitiya',
  // old DB records:
  'pannipitiya branch':                  'pannipitiya',
  // any other past variants:
  'anura tyres pannipitiya':             'pannipitiya',
  'anura tyre service pannipitiya':      'pannipitiya',

  // ── Ratnapura ────────────────────────────────────────────────────
  // website sends:
  'anura tyres (pvt) ltd ratnapura':    'ratnapura',
  // admin manual sends:
  'ratnapura':                           'ratnapura',
  // old DB records:
  'ratnapura branch':                    'ratnapura',
  // any other past variants:
  'anura tyres ratnapura':               'ratnapura',
  'anura tyre service ratnapura':        'ratnapura',

  // ── Kalawana ─────────────────────────────────────────────────────
  // website sends:
  'anura tyres pvt ltd kalawana':       'kalawana',
  // admin manual sends:
  'kalawana':                            'kalawana',
  // old DB records:
  'kalawana branch':                     'kalawana',
  // any other past variants:
  'anura tyres kalawana':                'kalawana',
  'anura tyre service kalawana':         'kalawana',

  // ── Nivithigala ──────────────────────────────────────────────────
  // website sends:
  'anura tyre service nivithigala':     'nivithigala',
  // admin manual sends:
  'nivithigala':                         'nivithigala',
  // old DB records:
  'nivithigala branch':                  'nivithigala',
  // any other past variants:
  'anura tyres nivithigala':             'nivithigala',
  'anura tyres (pvt) ltd nivithigala':   'nivithigala',
};

// Returns the canonical key for any branch name variant.
function canonicalizeBranch(name) {
  if (!name) return '';
  return BRANCH_VARIANT_MAP[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

// Returns ALL known stored variants for a branch as an array for $in queries.
// This ensures GET requests catch bookings stored under any past name format.
function branchVariants(name) {
  const canon = canonicalizeBranch(name);
  const variants = Object.entries(BRANCH_VARIANT_MAP)
    .filter(([, v]) => v === canon)
    .map(([k]) =>
      // Restore the original casing from the map key
      k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    );
  // Also include raw input in case it was stored verbatim and isn't in the map
  const raw = name.trim();
  if (!variants.map(v => v.toLowerCase()).includes(raw.toLowerCase())) {
    variants.push(raw);
  }
  return [...new Set(variants)];
}

// ─── EXTRACT & VALIDATE USER ─────────────────────────────────────
function getUserFromHeaders(req) {
  const role   = req.headers['x-user-role']?.trim()   || 'Cashier';
  const branch = req.headers['x-user-branch']?.trim() || '';

  const VALID_ROLES = ['Super Admin', 'Admin', 'Manager', 'Cashier'];
  if (!VALID_ROLES.includes(role)) {
    throw new Error(`Invalid role: ${role}`);
  }

  const canSeeAllBranches = ['Super Admin', 'Admin'].includes(role);

  if (!canSeeAllBranches && !branch) {
    throw new Error(`${role} must have a branch specified`);
  }

  return { role, branch, canSeeAllBranches };
}

// ─── SERVICE CODE MAP ─────────────────────────────────────────────
const SERVICE_CODE_MAP = {
  'wheel balancing':          'WB',
  'wheel alignment':          'AL',
  'tyre replacement':         'TR',
  'tire replacement':         'TR',
  'tyre rotation':            'RT',
  'tire rotation':            'RT',
  'nitrogen filling':         'NF',
  'flat repair':              'FR',
  'puncture repair':          'PR',
  'tyre repair (puncture)':   'PR',
  'brake service':            'BS',
  'brakes service':           'BS',
  'suspension check':         'SC',
  'suspension':               'SC',
  'oil change':               'OC',
  'battery service':          'BAT',
  'battery check':            'BAT',
  'battery check & replace':  'BAT',
  'batteries':                'BAT',
  'wheel change':             'WC',
  'tyre change':              'TC',
  'tyre sales':               'TS',
  'full service':             'FS',
  'ac service':               'AC',
  'alloy wheels':             'AW',
  'heavy vehicle':            'HV',
  'heavy vehicle alignment':  'HV',
  'heavy alignment':          'HV',
  'heavy tyres':              'HT',
  'heavy balancing':          'HB',
  'heavy brakes':             'HBR',
  'heavy suspension':         'HS',
  'truck tyre':               'TT',
  'truck tyre change':        'TT',
  'bus full':                 'BF',
  'bus full service':         'BF',
  'engine tune-up':           'ET',
  'diagnostics':              'DG',
};

function getServiceCode(serviceName) {
  const key = serviceName.toLowerCase().trim();
  if (SERVICE_CODE_MAP[key]) return SERVICE_CODE_MAP[key];
  for (const [k, v] of Object.entries(SERVICE_CODE_MAP)) {
    if (key.includes(k.split(' ')[0])) return v;
  }
  return serviceName.replace(/[^a-zA-Z]/g, '').slice(0, 2).toUpperCase() || 'SV';
}

// ─── BOOKING ID GENERATOR ─────────────────────────────────────────
// Format: <SERVICE_CODES>-<BRANCH3>-<YYYYMMDD>-<MS_BASE36><RANDOM6>
// e.g.  AW-PAN-20260424-LK8Z2QAB3X
function generateBookingId(serviceNames, branchName, date) {
  const prefixes = [...new Set(serviceNames.map(s => getServiceCode(s)))];
  const serviceSegment = prefixes.length > 0 ? prefixes.join('-') : 'SV';

  const canon = canonicalizeBranch(branchName);
  const branchSegment = canon.replace(/[^a-z]/g, '').slice(0, 3).toUpperCase() || 'HQ';

  const d = new Date(date);
  const dateSegment =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');

  const tsSegment = Date.now().toString(36).toUpperCase();

  const CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = Array.from({ length: 6 }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('');

  return `${serviceSegment}-${branchSegment}-${dateSegment}-${tsSegment}${random}`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    // ─── GET BOOKINGS ────────────────────────────────────────────
    if (req.method === 'GET') {
      let user;
      try {
        user = getUserFromHeaders(req);
      } catch (err) {
        return res.status(401).json({ success: false, message: err.message });
      }

      const { status, search, date, limit = 50 } = req.query;

      const mustClauses = [];

      // ── BRANCH ACCESS CONTROL ────────────────────────────────────
      // $in over ALL known variants so bookings stored under any
      // name format (website, manual, old records) are all returned.
      if (!user.canSeeAllBranches) {
        const variants = branchVariants(user.branch);
        mustClauses.push({ 'branch.name': { $in: variants } });
      }

      if (status && status !== 'all') {
        mustClauses.push({ status });
      }

      if (search) {
        mustClauses.push({
          $or: [
            { bookingId:              { $regex: search, $options: 'i' } },
            { 'customer.name':        { $regex: search, $options: 'i' } },
            { 'customer.email':       { $regex: search, $options: 'i' } },
            { 'customer.vehicleNo':   { $regex: search, $options: 'i' } },
          ],
        });
      }

      if (date) {
        const start = new Date(`${date}T00:00:00.000Z`);
        start.setMinutes(start.getMinutes() - 330);
        const end = new Date(`${date}T23:59:59.999Z`);
        mustClauses.push({ date: { $gte: start, $lte: end } });
      }

      const query = mustClauses.length > 0 ? { $and: mustClauses } : {};

      const bookings = await col
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(parseInt(limit), 500))
        .toArray();

      return res.status(200).json({
        success: true,
        bookings: bookings.map(b => ({
          id:       b.bookingId,
          date:     b.date
            ? (() => {
                const d = new Date(b.date);
                d.setMinutes(d.getMinutes() + 330);
                return d.toISOString().split('T')[0];
              })()
            : '',
          customer: b.customer?.name      || '',
          vehicle:  b.customer?.vehicleNo || 'N/A',
          service:  Array.isArray(b.services) ? b.services.map(s => s.name).join(', ') : '',
          status:   b.status,
          amount:   b.amount,
          email:    b.customer?.email || '',
          phone:    b.customer?.phone || '',
          branch:   b.branch?.name   || '',
          timeSlot: b.timeSlot        || '',
        })),
        userRole:   user.role,
        userBranch: user.branch,
      });
    }

    // ─── CREATE BOOKING ──────────────────────────────────────────
    if (req.method === 'POST') {
      let user;
      try {
        user = getUserFromHeaders(req);
      } catch (err) {
        return res.status(401).json({ success: false, message: err.message });
      }

      const body = req.body;

      if (!body.customer?.name || !body.customer?.email || !body.customer?.phone) {
        return res.status(400).json({
          success: false,
          message: 'Customer name, email and phone are required',
        });
      }
      if (!body.date || !body.timeSlot) {
        return res.status(400).json({
          success: false,
          message: 'Date and time slot are required',
        });
      }
      if (!body.branch || !body.branch.name) {
        return res.status(400).json({
          success: false,
          message: 'Branch information is required',
        });
      }

      // ── AUTHORIZATION CHECK ──────────────────────────────────────
      // Canonicalize both sides so "Anura Tyres (Pvt) Ltd Pannipitiya" === "Pannipitiya"
      if (
        !user.canSeeAllBranches &&
        canonicalizeBranch(body.branch.name) !== canonicalizeBranch(user.branch)
      ) {
        return res.status(403).json({
          success: false,
          message: `You can only create bookings for ${user.branch} branch`,
        });
      }

      const serviceNames = Array.isArray(body.services)
        ? body.services.map(s => s.name)
        : [];
      const bookingId = generateBookingId(serviceNames, body.branch.name, body.date);

      // ── DUPLICATE GUARD ──────────────────────────────────────────
      const existing = await col.findOne({ bookingId });
      if (existing) {
        console.warn(`Duplicate bookingId generated: ${bookingId}`);
        return res.status(200).json({
          success:   true,
          message:   'Booking already exists',
          booking:   { bookingId },
          duplicate: true,
        });
      }

      const doc = {
        bookingId,
        firebaseUid: body.firebaseUid || null,
        branch:      body.branch,
        category:    body.category || '',
        services:    Array.isArray(body.services) ? body.services : [],
        date:        new Date(body.date),
        timeSlot:    body.timeSlot,
        customer:    body.customer,
        status:      'Pending',
        amount:      body.amount || '0',
        source:      body.source || 'website',
        ...(body.discountInfo ? {
          discountInfo: body.discountInfo,
          discountCode: body.discountCode || '',
        } : {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await col.insertOne(doc);

      return res.status(201).json({
        success: true,
        message: 'Booking created successfully',
        booking: { bookingId },
      });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed' });

  } catch (err) {
    console.error('bookings.js error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error:   err.message,
    });
  }
};