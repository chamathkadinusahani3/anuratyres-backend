// /api/quotations.js
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  const match = MONGODB_URI.match(/\/([^/?]+)(\?|$)/);
  return cachedClient.db(match?.[1] || 'anura-tyres');
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Role, X-User-Branch');
}

function generateQuoteNumber() {
  const now    = new Date();
  const yr     = now.getFullYear();
  const mo     = String(now.getMonth() + 1).padStart(2, '0');
  const rnd    = Math.floor(Math.random() * 9000) + 1000;
  return `QT-${yr}${mo}-${rnd}`;
}

const VALID_STATUSES = ['Draft', 'Pending', 'Approved', 'Rejected', 'Invoiced'];

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db  = await getDb();
    const col = db.collection('quotations');

    const rawUrl  = (req.url || '').split('?')[0].replace(/\/$/, '');
    const idMatch = rawUrl.match(/\/([a-f0-9]{24})(\/.*)?$/);
    const sub     = idMatch?.[2] || '';   // e.g. '/status'
    const docId   = idMatch?.[1] || null;

    // ── PATCH /:id/status ─────────────────────────────────────────────────────
    if (docId && sub === '/status' && req.method === 'PATCH') {
      const { status } = req.body;
      if (!VALID_STATUSES.includes(status))
        return res.status(400).json({ error: `Invalid status. Use: ${VALID_STATUSES.join(', ')}` });
      await col.updateOne({ _id: new ObjectId(docId) }, { $set: { status, updatedAt: new Date().toISOString() } });
      return res.status(200).json({ ok: true });
    }

    // ── GET/PUT/DELETE /:id ───────────────────────────────────────────────────
    if (docId && !sub) {
      const oid = new ObjectId(docId);

      if (req.method === 'GET') {
        const doc = await col.findOne({ _id: oid });
        if (!doc) return res.status(404).json({ error: 'Not found' });
        return res.status(200).json({ ...doc, id: doc._id.toString() });
      }

      if (req.method === 'PUT') {
        // eslint-disable-next-line no-unused-vars
        const { _id, id, createdAt, quoteNumber, ...payload } = req.body;
        await col.updateOne(
          { _id: oid },
          { $set: { ...payload, updatedAt: new Date().toISOString() } },
        );
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        await col.deleteOne({ _id: oid });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET /api/quotations ───────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { branch, status, search, limit = '100' } = req.query;
      const query = {};
      if (branch && branch !== 'All') query.branch = branch;
      if (status && status !== 'All') query.status = status;
      if (search) {
        query.$or = [
          { quoteNumber:     { $regex: search, $options: 'i' } },
          { 'customer.name': { $regex: search, $options: 'i' } },
          { 'customer.phone':{ $regex: search, $options: 'i' } },
          { 'vehicle.plate': { $regex: search, $options: 'i' } },
          { 'vehicle.make':  { $regex: search, $options: 'i' } },
        ];
      }
      const docs = await col
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit), 500))
        .toArray();
      return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
    }

    // ── POST /api/quotations ──────────────────────────────────────────────────
    if (req.method === 'POST') {
      // eslint-disable-next-line no-unused-vars
      const { _id, id, ...body } = req.body;
      const now = new Date().toISOString();
      const doc = {
        ...body,
        quoteNumber: generateQuoteNumber(),
        status:      body.status || 'Draft',
        createdAt:   now,
        updatedAt:   now,
      };
      const result = await col.insertOne(doc);
      return res.status(201).json({ id: result.insertedId.toString(), quoteNumber: doc.quoteNumber });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[quotations]', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
