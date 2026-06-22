// api/customers.js — CommonJS version
const { MongoClient } = require('mongodb');

// ── Firebase Admin init ───────────────────────────────────────────────────────
let adminApp = null;
let adminAuth = null;
let adminFirestore = null;

function initFirebase() {
  if (adminApp) return;
  try {
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
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    throw err;
  }
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
let cachedClient = null;
let cachedDb = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;

  if (!process.env.MONGODB_URI) {
    throw new Error('Missing MONGODB_URI');
  }

  if (!cachedClient || !cachedClient.topology || !cachedClient.topology.isConnected()) {
    cachedClient = new MongoClient(process.env.MONGODB_URI);
    await cachedClient.connect();
  }

  const match = process.env.MONGODB_URI.match(/\/([^/?]+)(\?|$)/);
  const dbName = match?.[1] || 'anura-tyres';

  cachedDb = cachedClient.db(dbName);
  return cachedDb;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── PATCH /api/customers?uid=X  → update CRM supplement in crm_customers ──
  if (req.method === 'PATCH') {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ success: false, message: 'uid required' });
    try {
      const db = await getMongoDb();
      const { _id, id, createdAt, ...body } = req.body;
      await db.collection('crm_customers').updateOne(
        { uid },
        { $set: { ...body, updatedAt: new Date().toISOString() }, $setOnInsert: { uid, createdAt: new Date().toISOString() } },
        { upsert: true },
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  // ── Fast lookup by phone or vehicle (no Firebase, used by booking autofill) ──
  if (req.query.phone || req.query.vehicle) {
    try {
      const db      = await getMongoDb();
      const phone   = (req.query.phone   || '').replace(/\s/g, '');
      const vehicle = (req.query.vehicle || '').replace(/\s/g, '').toUpperCase();

      const orClauses = [];
      if (phone.length   >= 7) orClauses.push({ 'customer.phone':   { $regex: phone,   $options: 'i' } });
      if (vehicle.length >= 4) orClauses.push({ 'customer.vehicleNo': vehicle });

      if (orClauses.length > 0) {
        const booking = await db.collection('bookings').findOne(
          { $or: orClauses },
          { sort: { createdAt: -1 } },
        );
        if (booking?.customer) {
          return res.status(200).json({
            success:  true,
            customer: {
              name:      booking.customer.name      || '',
              phone:     booking.customer.phone     || '',
              email:     booking.customer.email     || '',
              vehicleNo: booking.customer.vehicleNo || '',
              source:    'booking',
            },
          });
        }

        // Fall back to crm_customers
        const crmOr = [];
        if (phone.length   >= 7) crmOr.push({ phone:            { $regex: phone, $options: 'i' } });
        if (vehicle.length >= 4) crmOr.push({ 'vehicles.plate': vehicle });
        if (crmOr.length > 0) {
          const crm = await db.collection('crm_customers').findOne({ $or: crmOr });
          if (crm) {
            return res.status(200).json({
              success:  true,
              customer: {
                name:      crm.name                   || '',
                phone:     crm.phone                  || '',
                email:     crm.email                  || '',
                vehicleNo: crm.vehicles?.[0]?.plate   || '',
                source:    'crm',
              },
            });
          }
        }
      }
      return res.status(200).json({ success: true, customer: null });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  try {
    initFirebase();

    // 1. Fetch all Firebase Auth users
    const allUsers = [];
    let pageToken;
    do {
      const result = await adminAuth.listUsers(1000, pageToken);
      allUsers.push(...result.users);
      pageToken = result.pageToken;
    } while (pageToken);

    // 2. Fetch MongoDB bookings grouped by firebaseUid + CRM supplement data
    const db = await getMongoDb();

    // Load CRM supplement data (tags, notes, tier, creditLimit, etc.)
    const crmSupplements = await db.collection('crm_customers').find({}).toArray();
    const crmByUid = {};
    for (const s of crmSupplements) {
      if (s.uid) crmByUid[s.uid] = s;
    }

    const mongoBookings = await db.collection('bookings').find({
      firebaseUid: { $exists: true, $ne: null },
    }).toArray();

    const bookingsByUid = {};
    const phoneByUid    = {};  // best phone from bookings for each Firebase UID
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
      // Capture first non-empty phone found in bookings for this UID
      if (!phoneByUid[b.firebaseUid] && b.customer?.phone) {
        phoneByUid[b.firebaseUid] = b.customer.phone;
      }
    }

    // 3. For each user fetch Firestore sub-collections
    const customers = await Promise.all(
      allUsers.map(async (user) => {
        try {
          const uid = user.uid;
          const [vehiclesSnap, appointmentsSnap, ordersSnap, activitySnap] = await Promise.all([
            adminFirestore.collection('users').doc(uid).collection('vehicles').get(),
            adminFirestore.collection('users').doc(uid).collection('appointments').orderBy('date', 'desc').limit(20).get(),
            adminFirestore.collection('users').doc(uid).collection('orders').orderBy('date', 'desc').limit(20).get(),
            adminFirestore.collection('users').doc(uid).collection('activity').orderBy('timestamp', 'desc').limit(50).get(),
          ]);

          const vehicles     = vehiclesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const appointments = appointmentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const orders       = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const activity     = activitySnap.docs.map(d => ({ id: d.id, ...d.data() }));
          const bookings     = bookingsByUid[uid] || [];
          const orderRevenue = orders.reduce((s, o) => s + (o.total || 0), 0);

          const crm = crmByUid[uid] || {};

          return {
            uid,
            name:          user.displayName || crm.name || '',
            email:         user.email || '',
            phone:         user.phoneNumber || crm.phone || phoneByUid[uid] || '',
            photoURL:      user.photoURL || '',
            emailVerified: user.emailVerified,
            provider:      user.providerData?.[0]?.providerId || 'email',
            createdAt:     user.metadata.creationTime,
            lastLogin:     user.metadata.lastSignInTime,
            disabled:      user.disabled,
            // CRM supplement fields (from crm_customers collection)
            tags:             crm.tags             ?? [],
            notes:            crm.notes            ?? '',
            tier:             crm.tier             ?? 'Bronze',
            creditLimit:      crm.creditLimit      ?? 0,
            preferredContact: crm.preferredContact ?? 'Call',
            nic:              crm.nic              ?? '',
            dob:              crm.dob              ?? '',
            pointsBalance:    crm.pointsBalance    ?? 0,
            csat:             crm.csat             ?? 0,
            noShowCount:      crm.noShowCount      ?? 0,
            referredBy:       crm.referredBy       ?? null,
            vehicles, appointments, orders, activity, bookings,
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
          const fallbackCrm = crmByUid[user.uid] || {};
          return {
            uid: user.uid, name: user.displayName || fallbackCrm.name || '', email: user.email || '',
            phone: user.phoneNumber || fallbackCrm.phone || phoneByUid[user.uid] || '',
            provider: user.providerData?.[0]?.providerId || 'email',
            createdAt: user.metadata.creationTime,
            lastLogin: user.metadata.lastSignInTime,
            disabled: user.disabled,
            vehicles: [], appointments: [], orders: [], activity: [], bookings: [],
            stats: { vehicleCount: 0, appointmentCount: 0, orderCount: 0, bookingCount: 0, totalRevenue: 0, lastActivity: null },
            error: err.message,
          };
        }
      })
    );

    // Include walk-in customers stored in crm_customers (no Firebase account)
    const walkIns = crmSupplements.filter(s => s.walkIn === true);
    for (const w of walkIns) {
      customers.push({
        uid:             w.uid,
        name:            w.name            ?? '',
        email:           w.email           ?? '',
        phone:           w.phone           ?? '',
        photoURL:        '',
        emailVerified:   false,
        provider:        'walk-in',
        createdAt:       w.createdAt,
        lastLogin:       null,
        disabled:        false,
        tags:            w.tags            ?? [],
        notes:           w.notes           ?? '',
        tier:            w.tier            ?? 'Bronze',
        creditLimit:     w.creditLimit     ?? 0,
        preferredContact:w.preferredContact ?? 'Call',
        nic:             w.nic             ?? '',
        dob:             w.dob             ?? '',
        pointsBalance:   w.pointsBalance   ?? 0,
        csat:            0,
        noShowCount:     0,
        referredBy:      null,
        vehicles:        w.vehicles        ?? [],
        appointments:    [],
        orders:          [],
        activity:        [],
        bookings:        [],
        stats: { vehicleCount: 0, appointmentCount: 0, orderCount: 0, bookingCount: 0, totalRevenue: 0, lastActivity: null },
      });
    }

    // ── Booking-only customers (manual bookings, no Firebase / CRM record) ──
    const anonymousBookings = await db.collection('bookings').find({
      $or: [{ firebaseUid: null }, { firebaseUid: { $exists: false } }],
      'customer.phone': { $exists: true, $ne: '' },
    }).toArray();

    const firebasePhones = new Set(allUsers.map(u => (u.phoneNumber || '').replace(/\s/g, '')).filter(Boolean));
    const crmPhones      = new Set(walkIns.map(w => (w.phone || '').replace(/\s/g, '')).filter(Boolean));

    const bookingPhoneMap = {};
    for (const b of anonymousBookings) {
      const rawPhone = b.customer?.phone || '';
      const phone    = rawPhone.replace(/\s/g, '');
      if (!phone || firebasePhones.has(phone) || crmPhones.has(phone)) continue;

      if (!bookingPhoneMap[phone]) {
        bookingPhoneMap[phone] = {
          uid:              `booking-${phone}`,
          name:             b.customer?.name  || '',
          email:            b.customer?.email || '',
          phone:            rawPhone,
          photoURL:         '',
          emailVerified:    false,
          provider:         'manual-booking',
          createdAt:        b.createdAt || new Date().toISOString(),
          lastLogin:        null,
          disabled:         false,
          tags:             [],
          notes:            '',
          tier:             'Bronze',
          creditLimit:      0,
          preferredContact: 'Call',
          nic:              '',
          dob:              '',
          pointsBalance:    0,
          csat:             0,
          noShowCount:      0,
          referredBy:       null,
          vehicles:         [],
          appointments:     [],
          orders:           [],
          activity:         [],
          bookings:         [],
          stats: { vehicleCount: 0, appointmentCount: 0, orderCount: 0, bookingCount: 0, totalRevenue: 0, lastActivity: null },
        };
      }

      const entry = bookingPhoneMap[phone];
      if (!entry.name && b.customer?.name) entry.name = b.customer.name;

      const plate = b.customer?.vehicleNo;
      if (plate && !entry.vehicles.some(v => v.plate === plate)) {
        entry.vehicles.push({ id: String(entry.vehicles.length), plate, make: '', model: '', year: '', tyreSize: '', insuranceExpiry: '', revenueExpiry: '' });
        entry.stats.vehicleCount++;
      }

      entry.stats.bookingCount++;
      entry.bookings.push({
        id:        b._id?.toString() || '',
        date:      b.date,
        branch:    typeof b.branch === 'object' ? (b.branch.name || b.branch.id || '') : (b.branch || ''),
        services:  (b.services || []).map(s => (typeof s === 'object' ? s.name : s)).filter(Boolean),
        status:    b.status,
        timeSlot:  b.timeSlot,
        vehicleNo: plate || '',
        total:     0,
      });
    }

    for (const entry of Object.values(bookingPhoneMap)) {
      customers.push(entry);
    }

    customers.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return res.status(200).json({ success: true, total: customers.length, customers });

  } catch (error) {
    console.error('[customers] error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};