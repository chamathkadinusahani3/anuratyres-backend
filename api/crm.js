// /api/crm.js
// Single CRM endpoint — routes via ?resource= param
//
// CALLS        GET  ?resource=calls[&branch&customerId&status&limit]
//              POST ?resource=calls                → create call log
//             PATCH ?resource=calls&id=X          → update status/notes
//
// REMINDERS    GET  ?resource=reminders[&branch&customerId&status]
//              POST ?resource=reminders            → create reminder
//             PATCH ?resource=reminders&id=X      → update (status/channel)
//            DELETE ?resource=reminders&id=X      → delete
//
// FLEET        GET  ?resource=fleet[&id=X]
//              POST ?resource=fleet                → create fleet account
//             PATCH ?resource=fleet&id=X          → update
//
// LOYALTY      GET  ?resource=loyalty[&customerId]
//              POST ?resource=loyalty              → add/deduct points
//
// APPROVALS    GET  ?resource=approvals[&branch&status]
//              POST ?resource=approvals            → create approval request
//             PATCH ?resource=approvals&id=X      → approve/deny
//
// CUSTOMERS    GET  ?resource=customers[&uid]      → CRM supplement data
//             PATCH ?resource=customers&uid=X      → update tags/notes/tier
//              POST ?resource=customers            → create walk-in customer
//
// DASHBOARD    GET  ?resource=dashboard[&branch]   → aggregated KPIs

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function toOid(id) {
  try { return new ObjectId(id); } catch { return null; }
}

function now() { return new Date().toISOString(); }

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db       = await getDb();
    const resource = req.query.resource;

    if (!resource) return res.status(400).json({ error: 'resource param required' });

    // ── CALLS ──────────────────────────────────────────────────────────────────
    if (resource === 'calls') {
      const col = db.collection('crm_calls');

      if (req.method === 'GET') {
        const { branch, customerId, status, limit = '100' } = req.query;
        const q = {};
        if (branch)     q.branch     = branch;
        if (customerId) q.customerId = customerId;
        if (status)     q.status     = status;
        const docs = await col.find(q).sort({ date: -1 }).limit(Math.min(Number(limit), 500)).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { customerId, phone, reason, status = 'Open', agent, branch,
                direction = 'Inbound', notes = '', followUpDue = null, duration = '' } = req.body;
        if (!reason) return res.status(400).json({ error: 'reason required' });
        if (!customerId && !phone) return res.status(400).json({ error: 'customerId or phone required' });
        const doc = {
          customerId, phone: phone || '', reason, status, agent: agent || '',
          branch: branch || '', direction, notes, followUpDue, duration,
          date: req.body.date || now(), createdAt: now(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, ...body } = req.body;
        await col.updateOne({ _id: oid }, { $set: { ...body, updatedAt: now() } });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── REMINDERS ──────────────────────────────────────────────────────────────
    if (resource === 'reminders') {
      const col = db.collection('crm_reminders');

      if (req.method === 'GET') {
        const { branch, customerId, status, limit = '200' } = req.query;
        const q = {};
        if (branch)     q.branch     = branch;
        if (customerId) q.customerId = customerId;
        if (status)     q.status     = status;
        const docs = await col.find(q).sort({ dueDate: 1 }).limit(Math.min(Number(limit), 500)).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { customerId, type, dueDate, channel = 'Manual', branch = '', vehicleId = null, notes = '' } = req.body;
        if (!customerId || !type || !dueDate) return res.status(400).json({ error: 'customerId, type, dueDate required' });
        const doc = { customerId, type, dueDate, channel, branch, vehicleId, notes, status: 'Pending', createdAt: now() };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, ...body } = req.body;
        await col.updateOne({ _id: oid }, { $set: { ...body, updatedAt: now() } });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        await col.deleteOne({ _id: oid });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── FLEET ──────────────────────────────────────────────────────────────────
    if (resource === 'fleet') {
      const col = db.collection('crm_fleet');

      if (req.method === 'GET') {
        const { id } = req.query;
        if (id) {
          const oid = toOid(id);
          if (!oid) return res.status(400).json({ error: 'valid id required' });
          const doc = await col.findOne({ _id: oid });
          if (!doc) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json({ ...doc, id: doc._id.toString() });
        }
        const docs = await col.find({}).sort({ companyName: 1 }).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { companyName, contactPerson, phone, email = '', contractType = 'Comprehensive',
                billingCycle = 'Monthly', accountManager = '', creditLimit = 0,
                vehicles = [], notes = '' } = req.body;
        if (!companyName || !contactPerson || !phone)
          return res.status(400).json({ error: 'companyName, contactPerson, phone required' });
        const doc = {
          companyName, contactPerson, phone, email, contractType, billingCycle,
          accountManager, creditLimit, vehicles, notes,
          balance: 0, overdueAmount: 0,
          vehicleCount: vehicles.length,
          createdAt: now(), updatedAt: now(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, createdAt, ...body } = req.body;
        if (body.vehicles) body.vehicleCount = body.vehicles.length;
        await col.updateOne({ _id: oid }, { $set: { ...body, updatedAt: now() } });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── LOYALTY ────────────────────────────────────────────────────────────────
    if (resource === 'loyalty') {
      const txCol  = db.collection('crm_loyalty_tx');
      const balCol = db.collection('crm_loyalty_balance');

      if (req.method === 'GET') {
        const { customerId, limit = '50' } = req.query;
        if (!customerId) {
          // Return all balances (for loyalty page overview)
          const balances = await balCol.find({}).sort({ points: -1 }).toArray();
          return res.status(200).json(balances.map(d => ({ ...d, id: d._id.toString() })));
        }
        const [txs, bal] = await Promise.all([
          txCol.find({ customerId }).sort({ date: -1 }).limit(Math.min(Number(limit), 200)).toArray(),
          balCol.findOne({ customerId }),
        ]);
        return res.status(200).json({
          customerId,
          balance:      bal?.points ?? 0,
          tier:         bal?.tier   ?? 'Bronze',
          transactions: txs.map(d => ({ ...d, id: d._id.toString() })),
        });
      }

      if (req.method === 'POST') {
        const { customerId, points, type = 'earn', reason = '', ref = '' } = req.body;
        if (!customerId || points == null) return res.status(400).json({ error: 'customerId and points required' });
        const delta = type === 'redeem' ? -Math.abs(Number(points)) : Math.abs(Number(points));

        await txCol.insertOne({ customerId, points: delta, type, reason, ref, date: now() });

        const bal = await balCol.findOne({ customerId });
        const newPoints = (bal?.points ?? 0) + delta;
        const tier =
          newPoints >= 5000 ? 'Platinum' :
          newPoints >= 2000 ? 'Gold' :
          newPoints >= 500  ? 'Silver' : 'Bronze';

        await balCol.updateOne(
          { customerId },
          { $set: { points: newPoints, tier, updatedAt: now() }, $setOnInsert: { createdAt: now() } },
          { upsert: true },
        );
        return res.status(200).json({ ok: true, newBalance: newPoints, tier });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── APPROVALS ──────────────────────────────────────────────────────────────
    if (resource === 'approvals') {
      const col = db.collection('crm_approvals');

      if (req.method === 'GET') {
        const { branch, status, limit = '100' } = req.query;
        const q = {};
        if (branch) q.branch = branch;
        if (status) q.status = status;
        const docs = await col.find(q).sort({ date: -1 }).limit(Math.min(Number(limit), 200)).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { type, requestedBy, customerId = null, jobId = null, branch,
                amount = null, notes = '' } = req.body;
        if (!type || !requestedBy || !branch) return res.status(400).json({ error: 'type, requestedBy, branch required' });
        const doc = {
          type, requestedBy, customerId, jobId, branch, amount, notes,
          status: 'Pending', date: now(), createdAt: now(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { action, respondedBy = '', notes = '' } = req.body;
        if (!['Approved', 'Rejected', 'Pending'].includes(action))
          return res.status(400).json({ error: 'action must be Approved | Rejected | Pending' });
        await col.updateOne({ _id: oid }, {
          $set: { status: action, respondedBy, responseNotes: notes, respondedAt: now(), updatedAt: now() }
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── CRM CUSTOMER SUPPLEMENT ────────────────────────────────────────────────
    // Stores extra CRM fields per customer (tags, notes, tier, creditLimit, etc.)
    // Keyed by Firebase uid OR walk-in ID
    if (resource === 'customers') {
      const col = db.collection('crm_customers');

      if (req.method === 'GET') {
        const { uid } = req.query;
        if (uid) {
          const doc = await col.findOne({ uid });
          return res.status(200).json(doc ? { ...doc, id: doc._id.toString() } : { uid, tags: [], notes: '', tier: 'Bronze', pointsBalance: 0 });
        }
        const docs = await col.find({}).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      // Create walk-in customer (not a Firebase Auth user)
      if (req.method === 'POST') {
        const { name, phone, email = '', nic = '', dob = '', address = '',
                tags = [], notes = '', preferredContact = 'Call', creditLimit = 0 } = req.body;
        if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
        const walkInId = `walkin-${Date.now()}`;
        const doc = {
          uid: walkInId, walkIn: true,
          name, phone, email, nic, dob, address, tags, notes,
          preferredContact, creditLimit, tier: 'Bronze',
          pointsBalance: 0, csat: 0, noShowCount: 0,
          vehicles: [], createdAt: now(), updatedAt: now(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString(), uid: walkInId });
      }

      // Update supplement fields for existing customer
      if (req.method === 'PATCH') {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ error: 'uid required' });
        const { _id, id, createdAt, ...body } = req.body;
        await col.updateOne(
          { uid },
          { $set: { ...body, updatedAt: now() }, $setOnInsert: { uid, createdAt: now() } },
          { upsert: true },
        );
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── DASHBOARD KPIs ─────────────────────────────────────────────────────────
    if (resource === 'dashboard') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

      const { branch } = req.query;
      const bFilter    = branch && branch !== 'All' ? { branch } : {};
      const todayStr   = new Date().toISOString().split('T')[0];

      const [callsToday, pendingApprovals, openComplaints, pendingReminders, recentCalls] =
        await Promise.all([
          db.collection('crm_calls').countDocuments({ ...bFilter, date: { $regex: `^${todayStr}` } }),
          db.collection('crm_approvals').countDocuments({ ...bFilter, status: 'Pending' }),
          db.collection('crm_calls').countDocuments({ ...bFilter, reason: 'Complaint', status: { $nin: ['Resolved'] } }),
          db.collection('crm_reminders').countDocuments({ ...bFilter, status: 'Pending', dueDate: { $lte: new Date(Date.now() + 7 * 86400_000).toISOString().split('T')[0] } }),
          db.collection('crm_calls').find({ ...bFilter }).sort({ date: -1 }).limit(10).toArray(),
        ]);

      return res.status(200).json({
        callsToday,
        pendingApprovals,
        openComplaints,
        pendingReminders,
        recentCalls: recentCalls.map(d => ({ ...d, id: d._id.toString() })),
      });
    }

    return res.status(400).json({ error: `Unknown resource: ${resource}` });

  } catch (err) {
    console.error('[crm]', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
