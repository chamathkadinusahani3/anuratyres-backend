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
// LOYALTY      GET  ?resource=loyalty[&customerId]  → balances (with nearExpiryPoints) or customer history
//              POST ?resource=loyalty              → add/deduct points (expiryDays, multiplier params)
//
// LOYALTY-CATALOGUE  GET  ?resource=loyalty-catalogue         → list reward items
//                    POST ?resource=loyalty-catalogue         → create reward item
//                   PATCH ?resource=loyalty-catalogue&id=X   → update
//                  DELETE ?resource=loyalty-catalogue&id=X   → delete
//
// APPROVALS    GET  ?resource=approvals[&branch&status]
//              POST ?resource=approvals            → create approval request
//             PATCH ?resource=approvals&id=X      → approve/deny
//
// CUSTOMERS    GET  ?resource=customers[&uid]      → CRM supplement data
//             PATCH ?resource=customers&uid=X      → update tags/notes/tier
//              POST ?resource=customers            → create walk-in customer
//            DELETE ?resource=customers&uid=X      → delete walk-in customer
//
// INSPECTIONS  GET  ?resource=inspections[&jobId=X|&id=X|&branch]
//              POST ?resource=inspections            → create inspection for a job
//             PATCH ?resource=inspections&id=X      → save damage/media/notes/approval
//
// EVENTS       GET  ?resource=events[&from&to]      → list manual calendar events
//              POST ?resource=events               → create manual event
//             PATCH ?resource=events&id=X         → update
//            DELETE ?resource=events&id=X         → delete
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

// Parse raw body manually to support large payloads (video base64 can be 5–15 MB)
async function parseBody(req) {
  if (req.body !== undefined) return req.body; // already parsed by Vercel for small bodies
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
    req.body = await parseBody(req);
  }

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
          // Return all balances with nearExpiryPoints (points expiring within 30 days)
          const balances = await balCol.find({}).sort({ points: -1 }).toArray();
          const thirtyDaysLater = new Date(Date.now() + 30 * 86400000).toISOString();
          const expiring = await txCol.aggregate([
            { $match: { type: 'earn', expiresAt: { $exists: true, $lte: thirtyDaysLater, $gt: now() } } },
            { $group: { _id: '$customerId', expiringPoints: { $sum: '$points' } } },
          ]).toArray();
          const expiryMap = {};
          expiring.forEach(e => { expiryMap[e._id] = e.expiringPoints; });
          return res.status(200).json(balances.map(d => ({
            ...d, id: d._id.toString(),
            nearExpiryPoints: expiryMap[d.customerId] || 0,
          })));
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
        const { customerId, points, type = 'earn', reason = '', ref = '',
                multiplier = 1, expiryDays = 365 } = req.body;
        if (!customerId || points == null) return res.status(400).json({ error: 'customerId and points required' });
        const rawPoints = Math.abs(Number(points)) * Math.max(1, Number(multiplier));
        const delta     = type === 'redeem' || type === 'expiry' ? -rawPoints : rawPoints;
        const expiresAt = type === 'earn' ? new Date(Date.now() + Number(expiryDays) * 86400000).toISOString() : null;

        await txCol.insertOne({ customerId, points: delta, type, reason, ref, date: now(), expiresAt,
          multiplier: type === 'earn' ? Number(multiplier) : undefined });

        const bal = await balCol.findOne({ customerId });
        const newPoints = Math.max(0, (bal?.points ?? 0) + delta);
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

    // ── LOYALTY REWARDS CATALOGUE ──────────────────────────────────────────────
    if (resource === 'loyalty-catalogue') {
      const col = db.collection('crm_loyalty_catalogue');

      if (req.method === 'GET') {
        const docs = await col.find({}).sort({ points: 1 }).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { name, description = '', points, category = 'service', active = true } = req.body;
        if (!name || !points) return res.status(400).json({ error: 'name and points required' });
        const r = await col.insertOne({ name, description, points: Number(points), category, active, createdAt: now() });
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, createdAt, ...body } = req.body;
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

      // Delete walk-in customer (only walk-in records stored in this collection)
      if (req.method === 'DELETE') {
        const { uid } = req.query;
        if (!uid) return res.status(400).json({ error: 'uid required' });
        const result = await col.deleteOne({ uid });
        if (result.deletedCount === 0) return res.status(404).json({ error: 'Customer not found' });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── DAMAGE INSPECTIONS ────────────────────────────────────────────────────
    // Linked to job_assignments by jobId (string). Media stored as compressed
    // base64 inside the document (images only; videos store metadata only).
    if (resource === 'inspections') {
      const col = db.collection('inspections');

      if (req.method === 'GET') {
        const { jobId, id, branch, limit = '100' } = req.query;

        // Fetch single by MongoDB _id
        if (id) {
          const oid = toOid(id);
          if (!oid) return res.status(400).json({ error: 'valid id required' });
          const doc = await col.findOne({ _id: oid });
          if (!doc) return res.status(404).json({ error: 'Not found' });
          return res.status(200).json({ ...doc, id: doc._id.toString() });
        }

        // Fetch by jobId — return null if none exists (not 404)
        if (jobId) {
          const doc = await col.findOne({ jobId });
          if (!doc) return res.status(200).json(null);
          return res.status(200).json({ ...doc, id: doc._id.toString() });
        }

        // List with optional branch filter
        const q = {};
        if (branch && branch !== 'all') {
          q['jobSummary.branch'] = { $regex: branch, $options: 'i' };
        }
        const docs = await col.find(q).sort({ updatedAt: -1 }).limit(Math.min(Number(limit), 200)).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      // Create new inspection (idempotent — returns existing if jobId already has one)
      if (req.method === 'POST') {
        const { jobId, jobSummary = {} } = req.body;
        if (!jobId) return res.status(400).json({ error: 'jobId required' });

        const existing = await col.findOne({ jobId });
        if (existing) return res.status(200).json({ ...existing, id: existing._id.toString() });

        const doc = {
          jobId,
          jobSummary,
          damageReports:      [],
          techNotes:          '',
          quotationItems:     [{ id: Math.random().toString(36).slice(2, 10), item: '', qty: 1, unitPrice: 0, labourCost: 0 }],
          approvalStatus:     'not_sent',
          approvalTimestamps: {},
          mediaFiles:         [],
          timeline:           [],
          auditTrail:         [],
          createdAt: now(),
          updatedAt: now(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ ...doc, id: r.insertedId.toString() });
      }

      // Partial update — caller sends only the fields that changed
      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, createdAt, jobId, ...body } = req.body;
        await col.updateOne({ _id: oid }, { $set: { ...body, updatedAt: now() } });
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── MANUAL CALENDAR EVENTS ────────────────────────────────────────────────
    if (resource === 'events') {
      const col = db.collection('crm_events');

      if (req.method === 'GET') {
        const { from, to, limit = '500' } = req.query;
        const q = {};
        if (from || to) {
          q.date = {};
          if (from) q.date.$gte = from;
          if (to)   q.date.$lte = to;
        }
        const docs = await col.find(q).sort({ date: 1, time: 1 }).limit(Math.min(Number(limit), 1000)).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { title, date } = req.body;
        if (!title || !date) return res.status(400).json({ error: 'title and date required' });
        const { _id, id, ...rest } = req.body;
        const doc = { time: '09:00', type: 'custom', notes: '', customerName: '', branch: '', ...rest, createdAt: now() };
        const r   = await col.insertOne(doc);
        return res.status(201).json({ ...doc, id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const { id } = req.query;
        const oid = toOid(id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, createdAt, ...body } = req.body;
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
