//  /api/bookings/stats/summary.js
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const db  = await getDb();
    const col = db.collection('bookings');

    const [total, pending, inProgress, completed, cancelled] = await Promise.all([
      col.countDocuments({}),
      col.countDocuments({ status: 'Pending' }),
      col.countDocuments({ status: 'In Progress' }),
      col.countDocuments({ status: 'Completed' }),
      col.countDocuments({ status: 'Cancelled' }),
    ]);

    return res.status(200).json({
      success: true,
      stats: { total, pending, inProgress, completed, cancelled },
    });
  } catch (err) {
    console.error('summary.js error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};