// /api/bookings.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

// ─── DB connection ───────────────────────────────────────────────
let cachedClient = null;

function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return (match && match[1]) ? match[1] : 'anura-tyres';
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

// ─── Fallback Booking ID generator (only if frontend fails) ──────
function generateBookingId() {
  const timestamp = Date.now().toString().slice(-4);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `BK-${random}${timestamp}`.slice(0, 12);
}

// ─── Main handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const db = await getDb();
    const col = db.collection('bookings');

    // ───────────────── GET ─────────────────
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
        count: bookings.length,
        bookings: bookings.map(b => ({
          id: b.bookingId, // ✅ IMPORTANT: use bookingId
          bookingId: b.bookingId,

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
          amount: b.amount || '0',

          email: b.customer?.email || '',
          phone: b.customer?.phone || '',

          branch: b.branch?.name || '',
          timeSlot: b.timeSlot || '',
        })),
      });
    }

    // ───────────────── POST ─────────────────
    if (req.method === 'POST') {
      const body = req.body;

      // ✅ VALIDATION
      if (!body.customer?.name || !body.customer?.email || !body.customer?.phone) {
        return res.status(400).json({
          success: false,
          message: 'Customer name, email and phone are required',
        });
      }

      if (!body.date) {
        return res.status(400).json({
          success: false,
          message: 'Date is required',
        });
      }

      if (!body.timeSlot) {
        return res.status(400).json({
          success: false,
          message: 'Time slot is required',
        });
      }

      // ✅ CRITICAL FIX: USE FRONTEND bookingId
      const finalBookingId = body.bookingId || generateBookingId();

      const doc = {
        bookingId: finalBookingId, // ✅ FIXED

        firebaseUid: body.firebaseUid || null,

        branch: body.branch || null,
        category: body.category || '',

        services: Array.isArray(body.services) ? body.services : [],

        date: new Date(body.date),
        timeSlot: body.timeSlot,

        customer: {
          name: body.customer.name,
          email: body.customer.email,
          phone: body.customer.phone,
          vehicleNo: body.customer.vehicleNo || '',
        },

        status: 'Pending',
        amount: body.amount || '0',

        ...(body.discountInfo ? {
          discountInfo: body.discountInfo,
          discountCode: body.discountCode,
        } : {}),

        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await col.insertOne(doc);

      console.log('✅ Booking Created:', finalBookingId);

      return res.status(201).json({
        success: true,
        message: 'Booking created successfully',
        booking: {
          bookingId: finalBookingId,
          customer: doc.customer,
          date: doc.date,
          timeSlot: doc.timeSlot,
          branch: doc.branch,
        },
      });
    }

    // ────
    // ─── FALLBACK ────────────
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });

  } catch (err) {
    console.error('❌ bookings.js error:', err);

    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message,
    });
  }
};