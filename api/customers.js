const { MongoClient } = require('mongodb');
const pLimit = require('p-limit');

let adminApp, adminAuth, adminFirestore;

function initFirebase() {
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

// MongoDB global cache  (serverless-safe)
let cached = global.mongo;
if (!cached) cached = global.mongo = { client: null, promise: null };

async function getMongoDb() {
  if (!cached.client) {
    if (!cached.promise) {
      cached.promise = new MongoClient(process.env.MONGODB_URI).connect();
    }
    cached.client = await cached.promise;
  }
  return cached.client.db(process.env.MONGODB_DB || 'anura-tyres');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    initFirebase();

    const limitUsers = parseInt(req.query.limit || '50', 10);

    const result = await adminAuth.listUsers(limitUsers);
    const users = result.users;

    const db = await getMongoDb();
    const mongoBookings = await db.collection('bookings').find().toArray();

    const bookingsByUid = {};
    mongoBookings.forEach(b => {
      if (!b.firebaseUid) return;
      if (!bookingsByUid[b.firebaseUid]) bookingsByUid[b.firebaseUid] = [];
      bookingsByUid[b.firebaseUid].push(b);
    });

    const limiter = pLimit(5);

    const customers = await Promise.all(
      users.map(user =>
        limiter(async () => {
          const uid = user.uid;

          const bookings = bookingsByUid[uid] || [];

          const totalRevenue = bookings.reduce((s, b) => s + (b.total || 0), 0);

          return {
            uid,
            name: user.displayName || '',
            email: user.email || '',
            provider: user.providerData?.[0]?.providerId || 'password',
            createdAt: user.metadata.creationTime,
            stats: {
              bookingCount: bookings.length,
              totalRevenue,
            },
          };
        })
      )
    );

    res.setHeader('Cache-Control', 's-maxage=60');

    return res.status(200).json({
      success: true,
      customers,
    });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};