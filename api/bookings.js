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

// ─── BRANCH NAME NORMALIZER ──────────────────────────────────────
// Strips " Branch" suffix and lowercases for comparison.
// Stored docs may have "Pannipitiya" or "Pannipitiya Branch" —
// both normalise to "pannipitiya" so matching is consistent.
function normalizeBranchName(name) {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+branch$/i, '').trim();
}

// Build a MongoDB $or query that matches both short and full branch names.
// e.g. user.branch = "Pannipitiya Branch" → matches "Pannipitiya" AND "Pannipitiya Branch"
function branchQuery(branchValue) {
  const norm = normalizeBranchName(branchValue);
  const full  = norm.charAt(0).toUpperCase() + norm.slice(1) + ' Branch';
  const short = norm.charAt(0).toUpperCase() + norm.slice(1);
  return { $or: [{ 'branch.name': full }, { 'branch.name': short }] };
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
  'suspension check':         'SC',
  'oil change':               'OC',
  'battery service':          'BAT',
  'battery check':            'BAT',
  'battery check & replace':  'BAT',
  'wheel change':             'WC',
  'tyre change':              'TC',
  'full service':             'FS',
  'ac service':               'AC',
  'heavy vehicle':            'HV',
  'heavy vehicle alignment':  'HV',
  'truck tyre':               'TT',
  'truck tyre change':        'TT',
  'bus full':                 'BF',
  'bus full service':         'BF',
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
// Format: <SERVICE_CODES>-<BRANCH>-<YYYYMMDD>-<MS_BASE36><RANDOM6>
// e.g.  WB-AL-PAN-20250424-1k7z2qAB3X
// Using millisecond timestamp (base-36) + 6 random chars gives
// ~2.8 trillion unique values per day — collision-proof in practice.
function generateBookingId(serviceNames, branchName, date) {
  const prefixes = [...new Set(serviceNames.map(s => getServiceCode(s)))];
  const serviceSegment = prefixes.length > 0 ? prefixes.join('-') : 'SV';

  // Use first 3 letters of the first significant word in the branch name
  const branchSegment = normalizeBranchName(branchName)
    .replace(/[^a-z]/g, '')
    .slice(0, 3)
    .toUpperCase() || 'HQ';

  const d = new Date(date);
  const dateSegment =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');

  // Millisecond timestamp in base-36 (6-7 chars, monotonically increasing)
  const tsSegment = Date.now().toString(36).toUpperCase();

  // 6 additional random chars for extra entropy
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

      const query = {};

      // ── BRANCH ACCESS CONTROL ────────────────────────────────────
      // FIX: use $or to match both "Pannipitiya" and "Pannipitiya Branch"
      if (!user.canSeeAllBranches) {
        Object.assign(query, branchQuery(user.branch));
      }

      if (status && status !== 'all') {
        query.status = status;
      }

      if (search) {
        query.$or = [
          { bookingId:          { $regex: search, $options: 'i' } },
          { 'customer.name':    { $regex: search, $options: 'i' } },
          { 'customer.email':   { $regex: search, $options: 'i' } },
          { 'customer.vehicleNo': { $regex: search, $options: 'i' } },
        ];
      }

      if (date) {
        const start = new Date(`${date}T00:00:00.000Z`);
        start.setMinutes(start.getMinutes() - 330);
        const end = new Date(`${date}T23:59:59.999Z`);
        query.date = { $gte: start, $lte: end };
      }

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
          customer: b.customer?.name  || '',
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
      // FIX: normalize both sides before comparing so "Pannipitiya" === "Pannipitiya Branch"
      if (
        !user.canSeeAllBranches &&
        normalizeBranchName(body.branch.name) !== normalizeBranchName(user.branch)
      ) {
        return res.status(403).json({
          success: false,
          message: `You can only create bookings for ${user.branch} branch`,
        });
      }

      // ── GENERATE BOOKING ID ──────────────────────────────────────
      // Always generate on the backend — never trust a client-supplied ID
      const serviceNames = Array.isArray(body.services)
        ? body.services.map(s => s.name)
        : [];
      const bookingId = generateBookingId(serviceNames, body.branch.name, body.date);

      // ── DUPLICATE GUARD ──────────────────────────────────────────
      // With the stronger ID this should be extremely rare, but keep the guard
      const existing = await col.findOne({ bookingId });
      if (existing) {
        console.warn(`Duplicate bookingId generated (extremely rare): ${bookingId}`);
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
        createdAt:   new Date(),
        updatedAt:   new Date(),
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