// /api/bookings/cron/late-alerts.js
// Dedicated cron endpoint — called every minute by cron-job.org

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

let cachedClient = null;
function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match && match[1] ? match[1] : 'anura-tyres';
}
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db(getDbName(MONGODB_URI));
}

const BRANCH_VARIANT_MAP = {
  'anura tyres (pvt) ltd pannipitiya': 'pannipitiya',
  'anura tyres pvt ltd pannipitiya':   'pannipitiya',
  'pannipitiya':                        'pannipitiya',
  'pannipitiya branch':                 'pannipitiya',
  'anura tyres pannipitiya':            'pannipitiya',
  'anura tyre service pannipitiya':     'pannipitiya',
  'anura tyres (pvt) ltd ratnapura':   'ratnapura',
  'anura tyres pvt ltd ratnapura':     'ratnapura',
  'ratnapura':                          'ratnapura',
  'ratnapura branch':                   'ratnapura',
  'anura tyres ratnapura':              'ratnapura',
  'anura tyre service ratnapura':       'ratnapura',
  'anura tyres pvt ltd kalawana':      'kalawana',
  'kalawana':                           'kalawana',
  'kalawana branch':                    'kalawana',
  'anura tyres kalawana':               'kalawana',
  'anura tyre service kalawana':        'kalawana',
  'anura tyre service nivithigala':    'nivithigala',
  'nivithigala':                        'nivithigala',
  'nivithigala branch':                 'nivithigala',
  'anura tyres nivithigala':            'nivithigala',
  'anura tyres (pvt) ltd nivithigala':  'nivithigala',
};

function canonicalizeBranch(name) {
  if (!name) return '';
  return BRANCH_VARIANT_MAP[name.trim().toLowerCase()] ?? name.trim().toLowerCase();
}

const BRANCH_PHONES = {
  pannipitiya: '077 578 5785',
  ratnapura:   '076 688 5885',
  kalawana:    '0777 32 95 32',
  nivithigala: '045 227 9396',
};

function formatPhone(raw) {
  let phone = (raw || '').replace(/[\s-]/g, '');
  if (phone.startsWith('+'))   phone = phone.slice(1);
  if (phone.startsWith('0'))   phone = '94' + phone.slice(1);
  if (!phone.startsWith('94')) phone = '94' + phone;
  return phone;
}

async function sendSMS(rawPhone, message) {
  const userId   = process.env.NOTIFY_USER_ID;
  const apiKey   = process.env.NOTIFY_API_KEY;
  const senderId = process.env.NOTIFY_SENDER_ID || 'NotifyDEMO';
  const phone    = formatPhone(rawPhone);
  if (!userId || !apiKey || phone.length < 11) return false;
  try {
    const params = new URLSearchParams({ user_id: userId, api_key: apiKey, sender_id: senderId, to: phone, message });
    const smsRes  = await fetch(`https://app.notify.lk/api/v1/send?${params}`, { method: 'GET' });
    const smsData = await smsRes.json().catch(() => ({}));
    return smsData.status === 'success';
  } catch (err) {
    console.error('[sendSMS] error:', err.message);
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: check ?secret= query param or Authorization header against CRON_SECRET env var.
  // If CRON_SECRET is not configured, the endpoint is open (non-sensitive read+SMS only).
  const cronSecret  = (process.env.CRON_SECRET || '').trim();
  if (cronSecret) {
    const authHeader  = (req.headers['authorization'] || '').trim();
    const querySecret = (req.query?.secret || '').trim();
    const authorized  = authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret;
    if (!authorized) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const db          = await getDb();
    const bookingsCol = db.collection('bookings');
    const alertsCol   = db.collection('sentAlerts');

    await alertsCol.createIndex({ key: 1 }, { unique: true });
    await alertsCol.createIndex({ sentAt: 1 }, { expireAfterSeconds: 604800 });

    const nowUTC     = new Date();
    const nowSL      = new Date(nowUTC.getTime() + 330 * 60_000);
    const todayStr   = nowSL.toISOString().split('T')[0];
    const nowMinutes = nowSL.getUTCHours() * 60 + nowSL.getUTCMinutes();

    const pendingBookings = await bookingsCol
      .find({ status: 'Pending', timeSlot: { $exists: true, $ne: '' } })
      .toArray();

    const results = [];

    for (const booking of pendingBookings) {
      const bookingDateSL  = new Date(new Date(booking.date).getTime() + 330 * 60_000);
      if (bookingDateSL.toISOString().split('T')[0] !== todayStr) continue;

      const [slotH, slotM] = booking.timeSlot.split(':').map(Number);
      if (isNaN(slotH) || isNaN(slotM)) continue;
      const late = nowMinutes - (slotH * 60 + slotM);
      if (late < 10) continue;

      const levels = late >= 30 ? [10, 30] : [10];

      for (const level of levels) {
        const alertKey    = `${booking.bookingId}-${level}`;
        const alreadySent = await alertsCol.findOne({ key: alertKey });
        if (alreadySent) continue;

        try {
          await alertsCol.insertOne({ key: alertKey, sentAt: new Date() });
        } catch (dupErr) {
          continue;
        }

        const customerName = booking.customer?.name || 'Customer';
        const serviceName  = Array.isArray(booking.services)
          ? booking.services.map(s => s.name).join(' & ')
          : 'your service';
        const canonBranch  = canonicalizeBranch(booking.branch?.name || '');
        const branchShort  = canonBranch.charAt(0).toUpperCase() + canonBranch.slice(1);
        const branchPhone  = BRANCH_PHONES[canonBranch] || '';

        const message = level >= 30
          ? `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} was cancelled (no-show). Call ${branchPhone} to rebook. - Anura Tyres ${branchShort}`
          : `Hi ${customerName}, your ${serviceName} appt at ${booking.timeSlot} hasn't started. Please arrive at Anura Tyres ${branchShort} ASAP or call ${branchPhone}.`;

        const smsSent = await sendSMS(booking.customer?.phone || '', message);

        let autoCancelled = false;
        if (level >= 30) {
          await bookingsCol.updateOne(
            { bookingId: booking.bookingId },
            { $set: { status: 'Cancelled', updatedAt: new Date() } },
          );
          autoCancelled = true;
        }

        results.push({ bookingId: booking.bookingId, level, smsSent, autoCancelled });
        console.log(`[cron/late-alerts] ${booking.bookingId} level=${level} smsSent=${smsSent} autoCancelled=${autoCancelled}`);
      }
    }

    return res.status(200).json({ ok: true, processed: results.length, results });
  } catch (err) {
    console.error('[cron/late-alerts] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
