//   /api/bookings/stats/summary.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  const match = MONGODB_URI.match(/\/([^/?]+)(\?|$)/);
  const dbName = (match && match[1]) ? match[1] : 'anura-tyres';
  return cachedClient.db(dbName);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Role, X-User-Branch');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    // Optional branch filter (partial, case-insensitive)
    const branch = (req.query.branch || '').trim();
    const branchFilter = branch
      ? { 'branch.name': { $regex: branch, $options: 'i' } }
      : {};

    // Today's date range in Sri Lanka time (UTC+5:30)
    const SL_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowSL        = new Date(Date.now() + SL_OFFSET_MS);
    const todayStr     = nowSL.toISOString().slice(0, 10); // "YYYY-MM-DD"
    // Midnight SL in UTC = SL midnight minus 5:30
    const dayStartUTC  = new Date(new Date(todayStr + 'T00:00:00.000Z').getTime() - SL_OFFSET_MS);
    const dayEndUTC    = new Date(new Date(todayStr + 'T23:59:59.999Z').getTime() - SL_OFFSET_MS);
    const todayFilter  = {
      date: { $gte: dayStartUTC.toISOString(), $lte: dayEndUTC.toISOString() },
    };

    const [
      total, pending, inProgress, completed, cancelled,
      todayTotal, todayPending, todayInProgress, todayCompleted,
    ] = await Promise.all([
      col.countDocuments({ ...branchFilter }),
      col.countDocuments({ ...branchFilter, status: 'Pending' }),
      col.countDocuments({ ...branchFilter, status: 'In Progress' }),
      col.countDocuments({ ...branchFilter, status: 'Completed' }),
      col.countDocuments({ ...branchFilter, status: 'Cancelled' }),
      col.countDocuments({ ...branchFilter, ...todayFilter }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'Pending' }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'In Progress' }),
      col.countDocuments({ ...branchFilter, ...todayFilter, status: 'Completed' }),
    ]);

    return res.status(200).json({
      success: true,
      stats: {
        total, pending, inProgress, completed, cancelled,
        today: { total: todayTotal, pending: todayPending, inProgress: todayInProgress, completed: todayCompleted },
      },
    });
  } catch (err) {
    console.error('summary.js error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
