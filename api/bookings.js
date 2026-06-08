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
const BRANCH_VARIANT_MAP = {
  'anura tyres (pvt) ltd pannipitiya':  'pannipitiya',
  'anura tyres pvt ltd pannipitiya':    'pannipitiya',
  'pannipitiya':                         'pannipitiya',
  'pannipitiya branch':                  'pannipitiya',
  'anura tyres pannipitiya':             'pannipitiya',
  'anura tyre service pannipitiya':      'pannipitiya',

  'anura tyres (pvt) ltd ratnapura':    'ratnapura',
  'anura tyres pvt ltd ratnapura':      'ratnapura',
  'ratnapura':                           'ratnapura',
  'ratnapura branch':                    'ratnapura',
  'anura tyres ratnapura':               'ratnapura',
  'anura tyre service ratnapura':        'ratnapura',

  'anura tyres pvt ltd kalawana':       'kalawana',
  'kalawana':                            'kalawana',
  'kalawana branch':                     'kalawana',
  'anura tyres kalawana':                'kalawana',
  'anura tyre service kalawana':         'kalawana',

  'anura tyre service nivithigala':     'nivithigala',
  'nivithigala':                         'nivithigala',
  'nivithigala branch':                  'nivithigala',
  'anura tyres nivithigala':             'nivithigala',
  'anura tyres (pvt) ltd nivithigala':   'nivithigala',
};

function canonicalizeBranch(name) {
  if (!name) return '';
  return BRANCH_VARIANT_MAP[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

function branchVariants(name) {
  const canon = canonicalizeBranch(name);
  const variants = Object.entries(BRANCH_VARIANT_MAP)
    .filter(([, v]) => v === canon)
    .map(([k]) =>
      k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    );
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

// ─── SMS HELPER ───────────────────────────────────────────────────
const BRANCH_PHONES = {
  pannipitiya: '077 578 5785',
  ratnapura:   '076 688 5885',
  kalawana:    '0777 32 95 32',
  nivithigala: '045 227 9396',
};

function formatPhone(raw) {
  let phone = (raw || '').replace(/[\s-]/g, '');
  if (phone.startsWith('+'))   phone = phone.slice(1);
  if (phone.startsWith('0'))   phone = '94' + phone.slice(1);
  if (!phone.startsWith('94')) phone = '94' + phone;
  return phone;
}

async function sendSMS(rawPhone, message) {
  const userId   = process.env.NOTIFY_USER_ID;
  const apiKey   = process.env.NOTIFY_API_KEY;
  const senderId = process.env.NOTIFY_SENDER_ID || 'NotifyDEMO';
  const phone    = formatPhone(rawPhone);

  if (!userId || !apiKey || phone.length < 11) return false;

  try {
    const params = new URLSearchParams({
      user_id: userId, api_key: apiKey,
      sender_id: senderId, to: phone, message,
    });
    const smsRes  = await fetch(`https://app.notify.lk/api/v1/send?${params}`, { method: 'GET' });
    const smsData = await smsRes.json().catch(() => ({}));
    return smsData.status === 'success';
  } catch (err) {
    console.error('[sendSMS] error:', err.message);
    return false;
  }
}

// ─── AVAILABILITY: capacity per branch + per-slot booking counts ─
// Folded in from the old standalone /api/bookings/availability.js so this
// file can serve /api/bookings/availability without costing an extra
// serverless function (Vercel Hobby plan caps a deployment at 12).
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

// Called when req.url matches /api/bookings/availability (GET)
async function handleAvailability(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { branch, date } = req.query;
  if (!branch || !date) {
    return res.status(400).json({ success: false, message: 'branch and date are required' });
  }

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    const canon    = canonicalizeBranch(branch);
    const variants = branchVariants(branch); // all stored name formats for this branch
    const capacity = BRANCH_CAPACITY[canon] ?? 2;

    const dayStart = new Date(`${date}T00:00:00.000Z`);
    dayStart.setMinutes(dayStart.getMinutes() - 330); // shift back 5h30m to UTC
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const bookings = await col.find({
      'branch.name': { $in: variants },
      date:          { $gte: dayStart, $lte: dayEnd },
      status:        { $nin: ['Cancelled'] },
    }).project({ timeSlot: 1 }).toArray();

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
    console.error('availability error:', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
}

// ─── STATS SUMMARY: today + overall booking counts by status ────
// Folded in from the old standalone /api/bookings/stats/summary.js for the
// same reason — keeps this deployment under the 12-function cap.
// Called when req.url matches /api/bookings/stats/summary (GET)
async function handleStatsSummary(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    const branch = (req.query.branch || '').trim();
    const branchFilter = branch
      ? { 'branch.name': { $regex: branch, $options: 'i' } }
      : {};

    // Today's date range in Sri Lanka time (UTC+5:30)
    const SL_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowSL        = new Date(Date.now() + SL_OFFSET_MS);
    const todayStr     = nowSL.toISOString().slice(0, 10); // "YYYY-MM-DD"
    const dayStartUTC  = new Date(new Date(todayStr + 'T00:00:00.000Z').getTime() - SL_OFFSET_MS);
    const dayEndUTC    = new Date(new Date(todayStr + 'T23:59:59.999Z').getTime() - SL_OFFSET_MS);
    const todayFilter  = {
      date: { $gte: dayStartUTC.toISOString(), $lte: dayEndUTC.toISOString() },
    };

    const [
      total, pending, inProgress, completed, cancelled,
      todayTotal, todayPending, todayInProgress, todayCompleted,
    ] = await Promise.all([
      col.countDocuments({ ...branchFilter }),
      col.countDocuments({ ...branchFilter, status: 'Pending' }),
      col.countDocuments({ ...branchFilter, status: 'In Progress' }),
      col.countDocuments({ ...branchFilter, status: 'Completed' }),
      col.countDocuments({ ...branchFilter, status: 'Cancelled' }),
      col.countDocuments({ ...branchFilter, ...todayFilter }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'Pending' }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'In Progress' }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'Completed' }),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        total, pending, inProgress, completed, cancelled,
        today: { total: todayTotal, pending: todayPending, inProgress: todayInProgress, completed: todayCompleted },
      },
    });
  } catch (err) {
    console.error('stats/summary error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─── CRON: LATE ALERT HANDLER ────────────────────────────────────
// Called when req.url matches /api/bookings/cron/late-alerts (GET)
// Vercel cron / cron-job.org hits this every minute with the Authorization header.
async function handleCronLateAlerts(req, res) {
  // Security — accept via Authorization header (Vercel) or ?secret= query param (cron-job.org)
  const cronSecret  = process.env.CRON_SECRET;
  const authHeader  = (req.headers['authorization'] || '').trim();
  const querySecret = (req.query?.secret || '').trim();

  const authorized = cronSecret && (
    authHeader  === `Bearer ${cronSecret}` ||
    querySecret === cronSecret
  );
  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db          = await getDb();
  const bookingsCol = db.collection('bookings');
  const alertsCol   = db.collection('sentAlerts');

  // Ensure indexes exist (idempotent after first run)
  await alertsCol.createIndex({ key: 1 }, { unique: true });
  // Auto-expire records after 7 days so the collection stays small
  await alertsCol.createIndex({ sentAt: 1 }, { expireAfterSeconds: 604800 });

  // Sri Lanka is UTC+5:30 — compute today's date string in local time
  const nowUTC    = new Date();
  const nowSL     = new Date(nowUTC.getTime() + 330 * 60_000); // +5h30m
  const todayStr  = nowSL.toISOString().split('T')[0];         // "YYYY-MM-DD"
  const nowH      = nowSL.getUTCHours();
  const nowM      = nowSL.getUTCMinutes();
  const nowMinutes = nowH * 60 + nowM;                         // minutes since midnight SL

  // Only fetch Pending bookings that have a timeSlot
  const pendingBookings = await bookingsCol
    .find({ status: 'Pending', timeSlot: { $exists: true, $ne: '' } })
    .toArray();

  const results = [];

  for (const booking of pendingBookings) {
    // ── Check booking is for today (SL time) ──────────────────────────────
    const bookingDateUTC = new Date(booking.date);
    const bookingDateSL  = new Date(bookingDateUTC.getTime() + 330 * 60_000);
    const bookingDateStr = bookingDateSL.toISOString().split('T')[0];
    if (bookingDateStr !== todayStr) continue;

    // ── How many minutes late? ────────────────────────────────────────────
    const [slotH, slotM] = booking.timeSlot.split(':').map(Number);
    if (isNaN(slotH) || isNaN(slotM)) continue;
    const slotMinutes = slotH * 60 + slotM;
    const late        = nowMinutes - slotMinutes;
    if (late < 10) continue; // not late yet

    const levels = late >= 30 ? [10, 30] : [10];

    for (const level of levels) {
      const alertKey = `${booking.bookingId}-${level}`;

      // ── Idempotency: skip if already fired ───────────────────────────────
      const alreadySent = await alertsCol.findOne({ key: alertKey });
      if (alreadySent) continue;

      // Mark BEFORE sending to prevent duplicate if SMS call hangs / retry races
      try {
        await alertsCol.insertOne({ key: alertKey, sentAt: new Date() });
      } catch (dupErr) {
        // Duplicate key = another invocation beat us, skip safely
        continue;
      }

      // ── Build message ─────────────────────────────────────────────────────
      const customerName = booking.customer?.name || 'Customer';
      const serviceName  = Array.isArray(booking.services)
        ? booking.services.map(s => s.name).join(' & ')
        : 'your service';
      const canonBranch  = canonicalizeBranch(booking.branch?.name || '');
      const branchShort  = canonBranch.charAt(0).toUpperCase() + canonBranch.slice(1);
      const branchPhone  = BRANCH_PHONES[canonBranch] || '';

      const message = level >= 30
        ? `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} was cancelled (no-show). Call ${branchPhone} to rebook. - Anura Tyres ${branchShort}`
        : `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} hasn't started. Please arrive at Anura Tyres ${branchShort} ASAP or call ${branchPhone}.`;

      const smsSent = await sendSMS(booking.customer?.phone || '', message);

      // ── Auto-cancel at 30 min ─────────────────────────────────────────────
      let autoCancelled = false;
      if (level >= 30) {
        await bookingsCol.updateOne(
          { bookingId: booking.bookingId },
          { $set: { status: 'Cancelled', updatedAt: new Date() } },
        );
        autoCancelled = true;
      }

      results.push({ bookingId: booking.bookingId, level, smsSent, autoCancelled });
      console.log(`[cron/late-alerts] ${booking.bookingId} level=${level} smsSent=${smsSent} autoCancelled=${autoCancelled}`);
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Route: cron/late-alerts ──────────────────────────────────────
  // Matches GET /api/bookings/cron/late-alerts
  // (Vercel strips the /api/bookings prefix but passes it in req.url)
  const url = (req.url || '').split('?')[0].replace(/\/$/, '');
  if (url.endsWith('/cron/late-alerts') || url.endsWith('/cron-late-alerts')) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed — use GET' });
    }
    try {
      return await handleCronLateAlerts(req, res);
    } catch (err) {
      console.error('[cron/late-alerts] unhandled error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── Route: availability ───────────────────────────────────────────
  // Matches GET /api/bookings/availability (folded in — see handleAvailability)
  if (url.endsWith('/availability')) {
    return handleAvailability(req, res);
  }

  // ── Route: stats/summary ──────────────────────────────────────────
  // Matches GET /api/bookings/stats/summary (folded in — see handleStatsSummary)
  if (url.endsWith('/stats/summary')) {
    return handleStatsSummary(req, res);
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

    // ─── PATCH — UPDATE BOOKING STATUS ──────────────────────────
    if (req.method === 'PATCH') {
      let user;
      try {
        user = getUserFromHeaders(req);
      } catch (err) {
        return res.status(401).json({ success: false, message: err.message });
      }

      const { bookingId, status } = req.body;

      if (!bookingId) {
        return res.status(400).json({ success: false, message: 'bookingId is required' });
      }

      const VALID_STATUSES = ['Pending', 'In Progress', 'Completed', 'Cancelled', 'Waiting'];
      if (!status || !VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
        });
      }

      const existing = await col.findOne({ bookingId });
      if (!existing) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      if (
        !user.canSeeAllBranches &&
        canonicalizeBranch(existing.branch?.name) !== canonicalizeBranch(user.branch)
      ) {
        return res.status(403).json({
          success: false,
          message: `You can only update bookings for ${user.branch} branch`,
        });
      }

      await col.updateOne(
        { bookingId },
        { $set: { status, updatedAt: new Date() } },
      );

      return res.status(200).json({
        success: true,
        message: `Booking ${bookingId} status updated to ${status}`,
        bookingId,
        status,
      });
    }

    // ─── ALL POST REQUESTS ───────────────────────────────────────
    if (req.method === 'POST') {
      let user;
      try {
        user = getUserFromHeaders(req);
      } catch (err) {
        return res.status(401).json({ success: false, message: err.message });
      }

      const body = req.body;

      // ── LATE ALERT (legacy client-side trigger — kept for compatibility) ──
      // NOTE: SMS is now handled by the cron route above.
      // This block only runs if the old frontend still fires it;
      // it is safe to remove once BookingsPage.tsx is updated.
      if (body?.action === 'late-alert') {
        const { bookingId, minutesLate = 10 } = body;

        if (!bookingId) return res.status(400).json({ success: false, message: 'bookingId required' });

        const booking = await col.findOne({ bookingId });
        if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

        if (booking.status === 'Cancelled')
          return res.json({ ok: true, skipped: true, reason: 'Already cancelled' });

        // Check sentAlerts so even the legacy path can't double-send
        const alertsCol = db.collection('sentAlerts');
        const level     = minutesLate >= 30 ? 30 : 10;
        const alertKey  = `${bookingId}-${level}`;
        const already   = await alertsCol.findOne({ key: alertKey });

        if (already) {
          return res.json({ ok: true, skipped: true, reason: 'Already sent by cron' });
        }

        try {
          await alertsCol.insertOne({ key: alertKey, sentAt: new Date() });
        } catch {
          return res.json({ ok: true, skipped: true, reason: 'Duplicate' });
        }

        const customerName = booking.customer?.name || 'Customer';
        const serviceName  = Array.isArray(booking.services)
          ? booking.services.map(s => s.name).join(' & ')
          : 'your service';
        const canonBranch  = canonicalizeBranch(booking.branch?.name || '');
        const branchShort  = canonBranch.charAt(0).toUpperCase() + canonBranch.slice(1);
        const branchPhone  = BRANCH_PHONES[canonBranch] || '';

        const smsMessage = minutesLate >= 30
          ? `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} was cancelled (no-show). Call ${branchPhone} to rebook. - Anura Tyres ${branchShort}`
          : `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} hasn't started. Please arrive at Anura Tyres ${branchShort} ASAP or call ${branchPhone}.`;

        const smsSent = await sendSMS(booking.customer?.phone || '', smsMessage);

        let autoCancelled = false;
        if (minutesLate >= 30) {
          await col.updateOne({ bookingId }, { $set: { status: 'Cancelled', updatedAt: new Date() } });
          autoCancelled = true;
        }

        return res.json({ ok: true, smsSent, autoCancelled });
      }

      // ─── CREATE BOOKING ────────────────────────────────────────
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

      const existing = await col.findOne({ bookingId });
      if (existing) {
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