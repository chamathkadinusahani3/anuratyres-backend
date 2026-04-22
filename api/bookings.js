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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── BOOKING ID GENERATOR (fallback for old clients) ─────────────
function generateBookingId() {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const randomPart = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  return `HV-ANU-${datePart}-${randomPart}`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const db = await getDb();
    const col = db.collection('bookings');

    // ─── GET BOOKINGS ────────────────────────────────────────────
    if (req.method === 'GET') {
      const { status, search, date, limit = 50 } = req.query;

      const query = {};

      if (status && status !== 'all') {
        query.status = status;
      }

      if (search) {
        query.$or = [
          { bookingId: { $regex: search, $options: 'i' } },
          { 'customer.name': { $regex: search, $options: 'i' } },
          { 'customer.email': { $regex: search, $options: 'i' } },
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
        .limit(parseInt(limit))
        .toArray();

      return res.status(200).json({
        success: true,
        bookings: bookings.map(b => ({
          id: b.bookingId,
          date: b.date
            ? (() => {
                const d = new Date(b.date);
                d.setMinutes(d.getMinutes() + 330);
                return d.toISOString().split('T')[0];
              })()
            : '',
          customer: b.customer?.name || '',
          vehicle: b.customer?.vehicleNo || 'N/A',
          service: Array.isArray(b.services)
            ? b.services.map(s => s.name).join(', ')
            : '',
          status: b.status,
          amount: b.amount,
          email: b.customer?.email || '',
          phone: b.customer?.phone || '',
          branch: b.branch?.name || '',
          timeSlot: b.timeSlot || '',
        })),
      });
    }

    // ─── CREATE BOOKING ──────────────────────────────────────────
    if (req.method === 'POST') {
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

      // ── Use frontend-provided ID, or generate one as fallback ────
      const bookingId = body.bookingId || generateBookingId();

      // ── DUPLICATE GUARD — if this bookingId already exists, return
      //    the existing booking instead of inserting a second record.
      //    This is the server-side safety net against double-POSTs
      //    caused by React StrictMode or network retries.
      const existing = await col.findOne({ bookingId });
      if (existing) {
        console.warn(`Duplicate POST blocked for bookingId: ${bookingId}`);
        return res.status(200).json({
          success: true,
          message: 'Booking already exists',
          booking: { bookingId },
          duplicate: true,
        });
      }

      const doc = {
        bookingId,
        firebaseUid: body.firebaseUid || null,
        branch: body.branch || null,
        category: body.category || '',
        services: Array.isArray(body.services) ? body.services : [],
        date: new Date(body.date),
        timeSlot: body.timeSlot,
        customer: body.customer,
        status: 'Pending',
        amount: body.amount || '0',
        source: body.source || 'website',
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

    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });

  } catch (err) {
    console.error('bookings.js error:', err);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message,
    });
  }
};