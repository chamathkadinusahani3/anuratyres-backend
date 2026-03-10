import { connectToDatabase } from "../../lib/mongodb.js";
import Booking from "../../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../../lib/cors.js";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ── Firebase Admin init (safe — won't crash if env vars missing) ─────────────
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
  'Completed':   'completed',
  'Cancelled':   'cancelled',
};

export default async function handler(req, res) {
  const { id } = req.query;

  setCorsHeaders(req, res); // ✅ correct

  if (handleOptionsRequest(req, res)) return;

  try {
    await connectToDatabase();

    if (req.method === 'GET') {
      const booking = await Booking.findOne({ bookingId: id });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      return res.status(200).json({ success: true, booking });
    }

    if (req.method === 'PATCH') {
      const { status, firebaseUid } = req.body;

      if (status && !['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
      }

      const updateData = { updatedAt: new Date() };
      if (status)      updateData.status      = status;
      if (firebaseUid) updateData.firebaseUid = firebaseUid;

      const booking = await Booking.findOneAndUpdate(
        { bookingId: id },
        updateData,
        { new: true }
      );

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }

      // ── Sync to Firestore when status changes ────────────────────────────
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
          console.error('⚠️ Firestore sync failed:', firestoreErr.message);
        }
      } else if (status && !booking.firebaseUid) {
        console.log(`ℹ️ No firebaseUid for ${booking.bookingId} — skipping Firestore sync`);
      } else if (status && !adminDb) {
        console.warn('⚠️ adminDb not initialized — check FIREBASE_* env vars in Vercel');
      }

      return res.status(200).json({ success: true, message: 'Booking updated', booking });
    }

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
    console.error('Error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}