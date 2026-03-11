import { connectToDatabase } from "../../lib/mongodb.js";
import Booking from "../../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../../lib/cors.js";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ── Firebase Admin init ───────────────────────────────────────────────────────
let adminDb = null;

try {
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
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase Admin init failed:', err.message);
}

// ── Status mapping: MongoDB → Firestore ──────────────────────────────────────
const STATUS_MAP = {
  'Pending':     'upcoming',
  'In Progress': 'upcoming',
  'Waiting':     'upcoming',
  'Completed':   'completed',
  'Cancelled':   'cancelled',
};

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handleOptionsRequest(req, res)) return;

  // ✅ FIX: Vercel passes dynamic segment as req.query.id
  // But also handle the case where it comes from the URL path directly
  const id = req.query.id || req.url?.split('/').pop()?.split('?')[0];

  console.log(`[${req.method}] /api/bookings/${id}`);

  if (!id) {
    return res.status(400).json({ success: false, message: 'Booking ID is required' });
  }

  try {
    await connectToDatabase();

    // ── GET ────────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const booking = await Booking.findOne({ bookingId: id });
      if (!booking) {
        console.log(`[GET] Booking not found: ${id}`);
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      return res.status(200).json({ success: true, booking });
    }

    // ── PATCH ──────────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const { status, firebaseUid } = req.body || {};

      console.log(`[PATCH] id=${id} status=${status} firebaseUid=${firebaseUid}`);

      // Validate status if provided
      const VALID_STATUSES = ['Pending', 'In Progress', 'Completed', 'Cancelled', 'Waiting'];
      if (status && !VALID_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: `Invalid status: ${status}` });
      }

      const updateData = { updatedAt: new Date() };
      if (status)      updateData.status      = status;
      if (firebaseUid) updateData.firebaseUid = firebaseUid;

      const booking = await Booking.findOneAndUpdate(
        { bookingId: id },
        { $set: updateData },
        { new: true }
      );

      if (!booking) {
        console.log(`[PATCH] Booking not found in MongoDB: ${id}`);
        // ✅ Debug: List a few bookings so we can see what IDs actually exist
        const sample = await Booking.find({}).limit(5).select('bookingId status');
        console.log('[PATCH] Sample bookings in DB:', sample.map(b => b.bookingId));
        return res.status(404).json({
          success: false,
          message: `Booking not found: ${id}`,
          debug_sample: sample.map(b => b.bookingId), // remove in production
        });
      }

      console.log(`[PATCH] Updated booking: ${booking.bookingId} → ${booking.status}`);

      // ── Sync to Firestore when status changes ────────────────────────────────
      if (status && booking.firebaseUid && adminDb) {
        try {
          const firestoreStatus = STATUS_MAP[status] ?? 'upcoming';
          await adminDb
            .collection('users')
            .doc(booking.firebaseUid)
            .collection('appointments')
            .doc(booking.bookingId)
            .update({
              status: firestoreStatus,
              updatedAt: new Date().toISOString(),
            });
          console.log(`✅ Firestore synced: ${booking.bookingId} → ${firestoreStatus}`);
        } catch (firestoreErr) {
          // Don't fail the whole request if Firestore sync fails
          console.error('⚠️ Firestore sync failed:', firestoreErr.message);
        }
      } else if (status && !booking.firebaseUid) {
        console.log(`ℹ️ No firebaseUid for ${booking.bookingId} — skipping Firestore sync`);
      } else if (status && !adminDb) {
        console.warn('⚠️ adminDb not initialized — check FIREBASE_* env vars in Vercel');
      }

      return res.status(200).json({ success: true, message: 'Booking updated', booking });
    }

    // ── DELETE ─────────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const booking = await Booking.findOneAndDelete({ bookingId: id });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      return res.status(200).json({ success: true, message: 'Booking deleted successfully' });
    }

    res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);

  } catch (error) {
    console.error('[id].js error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
}