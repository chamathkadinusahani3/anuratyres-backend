import { connectToDatabase } from "../../lib/mongodb.js";
import Booking from "../../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../../lib/cors.js";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ── Firebase Admin init (runs once, safe across hot reloads) ────────────────
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      // Replace \n escape in env var with real newlines
      privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const adminDb = getFirestore();

// ── Status mapping: MongoDB → Firestore ─────────────────────────────────────
// MongoDB uses Title Case, Firestore uses lowercase to match DashboardPage
const STATUS_MAP = {
  'Pending':     'upcoming',
  'In Progress': 'upcoming',
  'Completed':   'completed',
  'Cancelled':   'cancelled',
};

export default async function handler(req, res) {
  const { id } = req.query;

  setCorsHeaders(res);

  if (handleOptionsRequest(req, res)) return;

  try {
    await connectToDatabase();

    if (req.method === 'GET') {
      const booking = await Booking.findOne({ bookingId: id });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }
      return res.status(200).json({ success: true, booking });
    }

    if (req.method === 'PATCH') {
      const { status } = req.body;

      if (status && !['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        });
      }

      // 1️⃣ Update MongoDB as before
      const booking = await Booking.findOneAndUpdate(
        { bookingId: id },
        { status, updatedAt: new Date() },
        { new: true }
      );

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      // 2️⃣ Sync to Firestore if this booking belongs to a logged-in user
      if (booking.firebaseUid) {
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
          // MongoDB is already updated — log and continue
          console.error('⚠️ Firestore sync failed (non-critical):', firestoreErr.message);
        }
      } else {
        console.log(`ℹ️ No firebaseUid for booking ${booking.bookingId} — skipping Firestore sync`);
      }

      return res.status(200).json({
        success: true,
        message: 'Booking status updated',
        booking
      });
    }

    if (req.method === 'DELETE') {
      const booking = await Booking.findOneAndDelete({ bookingId: id });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }
      return res.status(200).json({
        success: true,
        message: 'Booking deleted successfully'
      });
    }

    res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
}