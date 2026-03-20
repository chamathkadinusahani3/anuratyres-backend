// /api/[id].js  — GET/PATCH/DELETE a single booking by bookingId
const { MongoClient, ObjectId } = require('mongodb');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Firebase Admin (optional — only initialised if env vars present) ──────────
let adminDb = null;
try {
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getFirestore }                  = require('firebase-admin/firestore');
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  adminDb = getFirestore();
} catch (err) {
  console.warn('Firebase Admin not available:', err.message);
}

const STATUS_MAP = {
  'Pending':     'upcoming',
  'In Progress': 'upcoming',
  'Waiting':     'upcoming',
  'Completed':   'completed',
  'Cancelled':   'cancelled',
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const id = req.query.id || req.url?.split('/').pop()?.split('?')[0];
  if (!id) return res.status(400).json({ success: false, message: 'Booking ID is required' });

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    // ── GET ───────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const booking = await col.findOne({ bookingId: id });
      if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
      return res.status(200).json({ success: true, booking });
    }

    // ── PATCH ─────────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { status, firebaseUid } = req.body || {};
      const VALID_STATUSES = ['Pending', 'In Progress', 'Completed', 'Cancelled', 'Waiting'];
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
      }

      const updateData = { updatedAt: new Date() };
      if (status)      updateData.status      = status;
      if (firebaseUid) updateData.firebaseUid = firebaseUid;

      const result = await col.findOneAndUpdate(
        { bookingId: id },
        { $set: updateData },
        { returnDocument: 'after' }
      );
      const booking = result?.value || result;

      if (!booking) {
        return res.status(404).json({ success: false, message: `Booking not found: ${id}` });
      }

      // Sync to Firestore if available
      if (status && booking.firebaseUid && adminDb) {
        try {
          await adminDb
            .collection('users').doc(booking.firebaseUid)
            .collection('appointments').doc(booking.bookingId)
            .update({ status: STATUS_MAP[status] ?? 'upcoming', updatedAt: new Date().toISOString() });
        } catch (e) {
          console.warn('Firestore sync failed:', e.message);
        }
      }

      return res.status(200).json({ success: true, message: 'Booking updated', booking });
    }

    // ── DELETE ──────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const result = await col.findOneAndDelete({ bookingId: id });
      const booking = result?.value || result;
      if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
      return res.status(200).json({ success: true, message: 'Booking deleted successfully' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[id].js error:', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};