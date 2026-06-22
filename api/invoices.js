// /api/invoices.js
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

function generateInvoiceNumber() {
  const now = new Date();
  const yr  = now.getFullYear();
  const mo  = String(now.getMonth() + 1).padStart(2, '0');
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  return `INV-${yr}${mo}-${rnd}`;
}

// Award loyalty points: 1 point per Rs 1000 spent
// Uses customer phone (stripped of spaces) as the loyalty account ID
async function awardLoyaltyPoints(db, phone, customerName, points, invoiceNumber) {
  if (!phone || points <= 0) return 0;
  const customerId = phone.replace(/\s+/g, '');
  const txCol      = db.collection('crm_loyalty_tx');
  const balCol     = db.collection('crm_loyalty_balance');
  const now        = new Date().toISOString();

  await txCol.insertOne({
    customerId, customerName, points, type: 'earn',
    reason: `Invoice ${invoiceNumber}`, ref: invoiceNumber,
    date: now, createdAt: now,
  });

  const bal       = await balCol.findOne({ customerId });
  const newPoints = (bal?.points ?? 0) + points;
  const tier      = newPoints >= 5000 ? 'Platinum'
                  : newPoints >= 2000 ? 'Gold'
                  : newPoints >= 500  ? 'Silver' : 'Bronze';

  await balCol.updateOne(
    { customerId },
    { $set: { points: newPoints, tier, customerName, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  return points;
}

const VALID_STATUSES  = ['Draft', 'Issued', 'Paid', 'Void'];
const VALID_PAYMENTS  = ['Unpaid', 'Partial', 'Paid', 'Overdue'];

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db      = await getDb();
    const col     = db.collection('invoices');
    const jobsCol = db.collection('job_assignments');

    const rawUrl  = (req.url || '').split('?')[0].replace(/\/$/, '');
    const idMatch = rawUrl.match(/\/([a-f0-9]{24})(\/.*)?$/);
    const sub     = idMatch?.[2] || '';
    const docId   = idMatch?.[1] || null;

    // ── GET /api/invoices?resource=jobs&branch=X  ─────────────────────────────
    // Returns completed jobs that have no linked invoice yet (for auto-fill)
    if (!docId && req.method === 'GET' && req.query.resource === 'jobs') {
      const { branch, date } = req.query;
      if (!branch) return res.status(400).json({ error: 'branch required' });

      const jobDate = date || new Date().toISOString().split('T')[0];

      // Jobs completed today or recent (last 7 days if no date given)
      const sinceISO = date
        ? `${date}T00:00:00.000Z`
        : new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

      const jobs = await jobsCol.aggregate([
        {
          $match: {
            branch,
            status: 'done',
            date:   date ? jobDate : { $gte: sinceISO.split('T')[0] },
          },
        },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timerArr' } },
        { $sort: { updatedAt: -1 } },
        { $limit: 100 },
      ]).toArray();

      // Fetch service prices for labour suggestion
      const pricesCol = db.collection('service_prices');
      const allPrices = await pricesCol.find({}).toArray();
      const priceMap  = {};
      allPrices.forEach(p => { priceMap[p.name.toLowerCase().trim()] = p.price || 0; });

      // Check which jobs are already invoiced
      const invoicedJobIds = new Set(
        (await col.find({ jobId: { $exists: true, $ne: null } }, { projection: { jobId: 1 } }).toArray())
          .map(d => d.jobId?.toString())
          .filter(Boolean)
      );

      const result = jobs.map(j => {
        const timer       = j.timerArr[0] || null;
        const workMins    = timer ? Math.round((timer.activeWorkSecs || 0) / 60) : 0;
        const labourRate  = 600; // Rs per hour default
        const labourSugg  = Math.round((workMins / 60) * labourRate);
        const partsSugg   = priceMap[(j.service || '').toLowerCase().trim()] || 0;
        const isInvoiced  = invoicedJobIds.has(j._id.toString());
        return {
          id:            j._id.toString(),
          service:       j.service || '',
          customerName:  j.customerName || '',
          customerPhone: j.customerPhone || '',
          vehiclePlate:  j.vehiclePlate  || '',
          date:          j.date,
          timeSlot:      j.timeSlot || '',
          allocatedMins: j.allocatedMins || 0,
          workMins,
          labourSugg,
          partsSugg,
          isInvoiced,
          staffName:     j.staffName || '',
        };
      });

      return res.status(200).json(result);
    }

    // ── PATCH /:id/payment ────────────────────────────────────────────────────
    if (docId && sub === '/payment' && req.method === 'PATCH') {
      const { paidAmount, paymentMethod, paymentNotes, paymentDate } = req.body;
      const doc = await col.findOne({ _id: new ObjectId(docId) });
      if (!doc) return res.status(404).json({ error: 'Not found' });

      const paid    = Number(paidAmount) || 0;
      const balance = doc.total - paid;
      const payStatus = paid <= 0 ? 'Unpaid'
        : balance <= 0 ? 'Paid'
        : 'Partial';
      const status = payStatus === 'Paid' ? 'Paid' : doc.status === 'Draft' ? 'Issued' : doc.status;

      // Award loyalty points when invoice transitions to Paid for the first time
      let pointsEarned = 0;
      const becomingPaid = payStatus === 'Paid' && doc.paymentStatus !== 'Paid' && !doc.loyaltyPointsAwarded;
      if (becomingPaid) {
        const pts = Math.floor((doc.total || 0) / 1000);
        pointsEarned = await awardLoyaltyPoints(db, doc.customer?.phone, doc.customer?.name, pts, doc.invoiceNumber);
      }

      await col.updateOne(
        { _id: new ObjectId(docId) },
        {
          $set: {
            paidAmount:    paid,
            balance:       Math.max(0, balance),
            paymentStatus: payStatus,
            paymentMethod: paymentMethod || doc.paymentMethod || '',
            paymentNotes:  paymentNotes  || '',
            paymentDate:   paymentDate   || doc.paymentDate  || new Date().toISOString().split('T')[0],
            status,
            updatedAt:     new Date().toISOString(),
            ...(becomingPaid && pointsEarned > 0 ? { loyaltyPointsAwarded: pointsEarned } : {}),
          },
          $push: {
            paymentHistory: {
              amount:    paid,
              method:    paymentMethod || 'Cash',
              notes:     paymentNotes  || '',
              date:      paymentDate   || new Date().toISOString().split('T')[0],
              recordedAt:new Date().toISOString(),
            },
          },
        },
      );
      return res.status(200).json({ ok: true, paymentStatus: payStatus, balance: Math.max(0, balance), pointsEarned });
    }

    // ── PATCH /:id/status ────────────────────────────────────────────────────
    if (docId && sub === '/status' && req.method === 'PATCH') {
      const { status } = req.body;
      if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
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
        const { _id, id, createdAt, invoiceNumber, paymentHistory, ...payload } = req.body;
        await col.updateOne({ _id: oid }, { $set: { ...payload, updatedAt: new Date().toISOString() } });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        await col.deleteOne({ _id: oid });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET /api/invoices ─────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const { branch, status, paymentStatus, search, limit = '100', from, to } = req.query;
      const query = {};
      if (branch && branch !== 'All') query.branch = branch;
      if (status && status !== 'All') query.status = status;
      if (paymentStatus && paymentStatus !== 'All') query.paymentStatus = paymentStatus;
      if (from || to) {
        query.invoiceDate = {};
        if (from) query.invoiceDate.$gte = from;
        if (to)   query.invoiceDate.$lte = to;
      }
      if (search) {
        query.$or = [
          { invoiceNumber:       { $regex: search, $options: 'i' } },
          { 'customer.name':     { $regex: search, $options: 'i' } },
          { 'customer.phone':    { $regex: search, $options: 'i' } },
          { 'customer.vehiclePlate': { $regex: search, $options: 'i' } },
          { jobRef:              { $regex: search, $options: 'i' } },
        ];
      }
      const docs = await col
        .find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit), 500))
        .toArray();
      return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
    }

    // ── POST /api/invoices ────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { _id, id, paymentHistory, ...body } = req.body;
      const now    = new Date().toISOString();
      const total  = Number(body.total) || 0;
      const paid   = Number(body.paidAmount) || 0;
      const doc = {
        ...body,
        invoiceNumber:  generateInvoiceNumber(),
        status:         body.status         || 'Issued',
        paymentStatus:  paid >= total && total > 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid',
        paidAmount:     paid,
        balance:        Math.max(0, total - paid),
        paymentHistory: paid > 0 ? [{ amount: paid, method: body.paymentMethod || 'Cash', notes: '', date: body.paymentDate || now.split('T')[0], recordedAt: now }] : [],
        createdAt:      now,
        updatedAt:      now,
      };
      const result = await col.insertOne(doc);

      // Award loyalty points if invoice is created as Paid
      let pointsEarned = 0;
      if (doc.paymentStatus === 'Paid') {
        const pts = Math.floor((doc.total || 0) / 1000);
        pointsEarned = await awardLoyaltyPoints(db, body.customer?.phone, body.customer?.name, pts, doc.invoiceNumber);
        if (pointsEarned > 0) {
          await col.updateOne({ _id: result.insertedId }, { $set: { loyaltyPointsAwarded: pointsEarned } });
        }
      }

      return res.status(201).json({ id: result.insertedId.toString(), invoiceNumber: doc.invoiceNumber, pointsEarned });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[invoices]', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
