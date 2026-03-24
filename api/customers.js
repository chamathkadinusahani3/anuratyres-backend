// api/customers.js — CommonJS version
const { MongoClient } = require('mongodb');

let adminApp = null;
let adminAuth = null;
let adminFirestore = null;

function initFirebase() {
  if (adminApp) return;
  const { initializeApp, getApps, cert } = require('firebase-admin/app');
  const { getAuth }      = require('firebase-admin/auth');
  const { getFirestore } = require('firebase-admin/firestore');

  if (!getApps().length) {
    adminApp = initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  } else {
    adminApp = getApps()[0];
  }

  adminAuth      = getAuth(adminApp);
  adminFirestore = getFirestore(adminApp);
}

let cachedClient = null;
async function getMongoDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }
  return cachedClient.db(process.env.MONGODB_DB || 'anura-tyres');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false });

  try {
    initFirebase();

    const allUsers = [];
    let pageToken;

    do {
      const result = await adminAuth.listUsers(200, pageToken);
      allUsers.push(...result.users);
      pageToken = result.pageToken;
    } while (pageToken);

    const db = await getMongoDb();
    const mongoBookings = await db.collection('bookings').find({
      firebaseUid: { $exists: true, $ne: null },
    }).toArray();

    const bookingsByUid = {};
    for (const b of mongoBookings) {
      if (!b.firebaseUid) continue;
      if (!bookingsByUid[b.firebaseUid]) bookingsByUid[b.firebaseUid] = [];
      bookingsByUid[b.firebaseUid].push({
        id: b._id?.toString(),
        date: b.date,
        branch: b.branch,
        services: b.services,
        status: b.status,
        timeSlot: b.timeSlot,
        vehicleNo: b.vehicleNo,
        total: b.total || 0,
      });
    }

    async function safeGet(ref) {
      try {
        const snap = await ref.get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch {
        return [];
      }
    }

    const customers = await Promise.all(
      allUsers.map(async (user) => {
        try {
          const uid = user.uid;

          const vehicles = await safeGet(
            adminFirestore.collection('users').doc(uid).collection('vehicles')
          );

          const appointments = await safeGet(
            adminFirestore.collection('users').doc(uid).collection('appointments')
              .orderBy('date', 'desc').limit(20)
          );

          const orders = await safeGet(
            adminFirestore.collection('users').doc(uid).collection('orders')
              .orderBy('date', 'desc').limit(20)
          );

          const activity = await safeGet(
            adminFirestore.collection('users').doc(uid).collection('activity')
              .orderBy('timestamp', 'desc').limit(50)
          );

          const bookings = bookingsByUid[uid] || [];

          const bookingRevenue = bookings.reduce((s, b) => s + (b.total || 0), 0);
          const orderRevenue   = orders.reduce((s, o) => s + (o.total || 0), 0);
          const totalRevenue   = bookingRevenue + orderRevenue;

          return {
            uid,
            name: user.displayName || '',
            email: user.email || '',
            phone: user.phoneNumber || '',
            photoURL: user.photoURL || '',
            emailVerified: user.emailVerified,
            provider: user.providerData?.[0]?.providerId || 'password',
            createdAt: user.metadata.creationTime,
            lastLogin: user.metadata.lastSignInTime,
            disabled: user.disabled,
            vehicles, appointments, orders, activity, bookings,
            stats: {
              vehicleCount: vehicles.length,
              appointmentCount: appointments.length,
              orderCount: orders.length,
              bookingCount: bookings.length,
              totalRevenue,
              lastActivity: activity[0]?.timestamp?.toDate
                ? activity[0].timestamp.toDate().toISOString()
                : activity[0]?.timestamp || null,
            },
          };
        } catch (err) {
          return { uid: user.uid, error: err.message };
        }
      })
    );

    customers.sort((a, b) =>
      new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    return res.status(200).json({ success: true, total: customers.length, customers });

  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};