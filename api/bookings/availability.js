// /api/availability.js
//  GET  /api/bookings/availability?branch=X&date=YYYY-MM-DD
const { MongoClient } = require('mongodb');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// Capacity per branch (max bookings per time slot)
const BRANCH_CAPACITY = {
  'Pannipitiya':                       3,
  'Ratnapura':                         2,
  'Kalawana':                          2,
  'Nivithigala':                       2,
  'Anura Tyres (Pvt) Ltd Pannipitiya': 3,
  'Anura Tyres (Pvt) Ltd Ratnapura':   2,
  'Anura Tyres Pvt Ltd Kalawana':      2,
  'Anura Tyre Service Nivithigala':    2,
};

const ALL_TIME_SLOTS = [
  '08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00',
  '13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
  '17:00','17:30','18:00','18:30','19:00',
];

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { branch, date } = req.query;
  if (!branch || !date) {
    return res.status(400).json({ success: false, message: 'branch and date are required' });
  }

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    const capacity = BRANCH_CAPACITY[branch] ?? 2;

    // Use regex to match both short and full branch names
    const branchRegex = new RegExp(branch.split(' ')[0], 'i'); // first word e.g. "Pannipitiya"

    // Date range for Sri Lanka timezone
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    dayStart.setMinutes(dayStart.getMinutes() - 330);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);

    const bookings = await col.find({
      'branch.name': { $regex: branchRegex },
      date: { $gte: dayStart, $lte: dayEnd },
      status: { $nin: ['Cancelled'] },
    }).project({ timeSlot: 1, status: 1 }).toArray();

    const slotCounts = {};
    for (const b of bookings) {
      if (b.timeSlot) slotCounts[b.timeSlot] = (slotCounts[b.timeSlot] || 0) + 1;
    }

    const slots = ALL_TIME_SLOTS.map(time => ({
      time,
      booked:    slotCounts[time] || 0,
      capacity,
      available: (slotCounts[time] || 0) < capacity,
    }));

    return res.status(200).json({ success: true, branch, date, capacity, slots });

  } catch (err) {
    console.error('availability.js error:', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};