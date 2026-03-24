// api/customers.js
// Fetches all registered customers from Firebase Auth + their Firestore data

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { MongoClient } from 'mongodb';

// ── Firebase Admin init ───────────────────────────────────────────────────────
function getFirebaseAdmin() {
  if (getApps().length > 0) return getApps()[0];
  return initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
let cachedClient = null;
async function getMongoDb() {
  if (!cachedClient || !cachedClient.topology?.isConnected()) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db('anura-tyres');
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    const app        = getFirebaseAdmin();
    const adminAuth  = getAuth(app);
    const firestore  = getFirestore(app);

    // ── 1. Fetch all Firebase Auth users (paginate if > 1000) ──────────────
    const allUsers = [];
    let pageToken;
    do {
      const result = await adminAuth.listUsers(1000, pageToken);
      allUsers.push(...result.users);
      pageToken = result.pageToken;
    } while (pageToken);

    // ── 2. Fetch MongoDB bookings grouped by firebaseUid ───────────────────
    const db = await getMongoDb();
    const mongoBookings = await db.collection('bookings').find({
      firebaseUid: { $exists: true, $ne: null }
    }).toArray();

    // Group bookings by firebaseUid
    const bookingsByUid = {};
    for (const b of mongoBookings) {
      if (!b.firebaseUid) continue;
      if (!bookingsByUid[b.firebaseUid]) bookingsByUid[b.firebaseUid] = [];
      bookingsByUid[b.firebaseUid].push({
        id:        b._id?.toString(),
        date:      b.date,
        branch:    b.branch,
        services:  b.services,
        status:    b.status,
        timeSlot:  b.timeSlot,
        vehicleNo: b.vehicleNo,
        total:     b.total || 0,
      });
    }

    // ── 3. For each user, fetch Firestore sub-collections in parallel ──────
    const customers = await Promise.all(
      allUsers.map(async (user) => {
        try {
          const uid = user.uid;

          // Firestore: vehicles, appointments, orders, activity
          const [vehiclesSnap, appointmentsSnap, ordersSnap, activitySnap] = await Promise.all([
            firestore.collection('users').doc(uid).collection('vehicles').get(),
            firestore.collection('users').doc(uid).collection('appointments').orderBy('date', 'desc').limit(20).get(),
            firestore.collection('users').doc(uid).collection('orders').orderBy('date', 'desc').limit(20).get(),
            firestore.collection('users').doc(uid).collection('activity').orderBy('timestamp', 'desc').limit(50).get(),
          ]);

          const vehicles = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const appointments = appointmentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const orders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const activity = activitySnap.docs.map(d => ({ id: d.id, ...d.data() }));

          // Revenue from MongoDB bookings + orders
          const bookings     = bookingsByUid[uid] || [];
          const orderRevenue = orders.reduce((s, o) => s + (o.total || 0), 0);

          return {
            uid,
            // Auth info
            name:          user.displayName || '',
            email:         user.email || '',
            phone:         user.phoneNumber || '',
            photoURL:      user.photoURL || '',
            emailVerified: user.emailVerified,
            provider:      user.providerData?.[0]?.providerId || 'email',
            createdAt:     user.metadata.creationTime,
            lastLogin:     user.metadata.lastSignInTime,
            disabled:      user.disabled,

            // Firestore data
            vehicles,
            appointments,
            orders,
            activity,

            // MongoDB bookings
            bookings,

            // Summary stats
            stats: {
              vehicleCount:     vehicles.length,
              appointmentCount: appointments.length,
              orderCount:       orders.length,
              bookingCount:     bookings.length,
              totalRevenue:     orderRevenue,
              lastActivity:     activity[0]?.timestamp || null,
            },
          };
        } catch (err) {
          // Return partial data if Firestore fetch fails for one user
          return {
            uid:      user.uid,
            name:     user.displayName || '',
            email:    user.email || '',
            phone:    user.phoneNumber || '',
            provider: user.providerData?.[0]?.providerId || 'email',
            createdAt: user.metadata.creationTime,
            lastLogin: user.metadata.lastSignInTime,
            disabled:  user.disabled,
            vehicles: [], appointments: [], orders: [], activity: [], bookings: [],
            stats: { vehicleCount: 0, appointmentCount: 0, orderCount: 0, bookingCount: 0, totalRevenue: 0, lastActivity: null },
            error: err.message,
          };
        }
      })
    );

    // Sort by most recently created
    customers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.status(200).json({
      success: true,
      total: customers.length,
      customers,
    });

  } catch (error) {
    console.error('[customers] error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}