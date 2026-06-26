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
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET  = process.env.JWT_SECRET || 'anura-crm-2026-internal';

// Default users — seeded into crm_users if the collection is empty
const SEED_USERS = [
  { username: 'admin',     password: 'admin123',   name: 'Admin User',       role: 'Admin',        branch: 'All Branches', initials: 'AU' },
  { username: 'manager',   password: 'manager123', name: 'Kamal Perera',      role: 'Manager',      branch: 'Pannipitiya',  initials: 'KP' },
  { username: 'reception', password: 'recep123',   name: 'Nimal Silva',       role: 'Receptionist', branch: 'Pannipitiya',  initials: 'NS' },
  { username: 'sales',     password: 'sales123',   name: 'Amaya Fernando',    role: 'Sales',        branch: 'Ratnapura',    initials: 'AF' },
  { username: 'tech',      password: 'tech123',    name: 'Ruwan Jayawardena', role: 'Technician',   branch: 'Pannipitiya',  initials: 'RJ' },
];

async function ensureUsersSeeded(db) {
  const col = db.collection('crm_users');
  const count = await col.countDocuments();
  if (count > 0) return;
  const docs = await Promise.all(SEED_USERS.map(async u => ({
    username:     u.username,
    passwordHash: await bcrypt.hash(u.password, 10),
    name:  u.name, role: u.role, branch: u.branch, initials: u.initials,
    active: true, createdAt: new Date(),
  })));
  await col.insertMany(docs);
}

function userInitials(name) {
  const p = String(name).trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : String(name).slice(0, 2).toUpperCase();
}

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

    // ── AUTH (verify + login) ─────────────────────────────────────────────────
    if (resource === 'auth') {
      await ensureUsersSeeded(db);
      const col = db.collection('crm_users');

      if (req.method === 'GET') {
        const authHeader = String(req.headers['authorization'] || '');
        if (!authHeader.startsWith('Bearer '))
          return res.status(401).json({ error: 'Unauthorized' });
        try {
          const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
          return res.status(200).json({ user: { id: decoded.id, name: decoded.name, role: decoded.role, branch: decoded.branch, initials: decoded.initials } });
        } catch {
          return res.status(401).json({ error: 'Token expired or invalid' });
        }
      }

      if (req.method === 'POST') {
        const { username, password } = req.body || {};
        if (!username || !password)
          return res.status(400).json({ error: 'Username and password required' });

        const user = await col.findOne({ username: String(username).toLowerCase().trim() });
        if (!user || !user.active)
          return res.status(401).json({ error: 'Invalid username or password' });

        const valid = await bcrypt.compare(String(password), user.passwordHash);
        if (!valid)
          return res.status(401).json({ error: 'Invalid username or password' });

        const sessionUser = { id: user._id.toString(), name: user.name, role: user.role, branch: user.branch, initials: user.initials };
        const token = jwt.sign(sessionUser, JWT_SECRET, { expiresIn: '30d' });
        return res.status(200).json({ token, user: sessionUser });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── USERS (management) ─────────────────────────────────────────────────────
    if (resource === 'users') {
      await ensureUsersSeeded(db);
      const col = db.collection('crm_users');

      const toPublic = u => { const { _id, passwordHash: _ph, ...rest } = u; return { ...rest, id: _id.toString() }; };

      if (req.method === 'GET') {
        const docs = await col.find({}).project({ passwordHash: 0 }).sort({ createdAt: 1 }).toArray();
        return res.status(200).json(docs.map(toPublic));
      }

      if (req.method === 'POST') {
        const { username, password, name, role, branch, active = true } = req.body || {};
        if (!username || !password || !name || !role)
          return res.status(400).json({ error: 'username, password, name, role required' });
        const uname = String(username).toLowerCase().trim();
        if (await col.findOne({ username: uname }))
          return res.status(400).json({ error: 'Username already taken' });
        const doc = {
          username: uname, passwordHash: await bcrypt.hash(String(password), 10),
          name: String(name).trim(), role: String(role),
          branch: branch || 'All Branches', initials: userInitials(String(name)),
          active: Boolean(active), createdAt: new Date(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { password, name, ...rest } = req.body || {};
        const updates = { ...rest, updatedAt: new Date() };
        if (name) { updates.name = String(name).trim(); updates.initials = userInitials(String(name)); }
        if (password) updates.passwordHash = await bcrypt.hash(String(password), 10);
        await col.updateOne({ _id: oid }, { $set: updates });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        await col.deleteOne({ _id: oid });
        return res.status(200).json({ ok: true });
      }
    }

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

    // ── MESSAGES (Chat) ────────────────────────────────────────────────────────
    if (resource === 'messages') {
      const col = db.collection('crm_messages');

      if (req.method === 'GET') {
        const { user, with: withUser } = req.query;
        if (!user) return res.status(400).json({ error: 'user required' });

        if (withUser) {
          // Full thread between two users — mark incoming as read
          const msgs = await col.find({
            $or: [
              { from: user, to: withUser },
              { from: withUser, to: user },
            ],
          }).sort({ createdAt: 1 }).toArray();
          await col.updateMany({ from: withUser, to: user, read: false }, { $set: { read: true } });
          return res.status(200).json(msgs.map(d => ({ ...d, id: d._id.toString() })));
        }

        // Conversations summary
        const msgs = await col.find({ $or: [{ from: user }, { to: user }] })
          .sort({ createdAt: -1 }).toArray();
        const map = {};
        msgs.forEach(m => {
          const other = m.from === user ? m.to : m.from;
          if (!map[other]) map[other] = { with: other, lastMessage: m.message, lastAt: m.createdAt, unread: 0 };
          if (m.to === user && !m.read) map[other].unread++;
        });
        return res.status(200).json(Object.values(map));
      }

      if (req.method === 'POST') {
        const { from, to, message } = req.body;
        if (!from || !to || !message) return res.status(400).json({ error: 'from, to, message required' });
        const ts = now();
        const doc = { from, to, message, read: false, createdAt: ts };
        const r = await col.insertOne(doc);
        // Push a popup notification to the recipient
        await db.collection('crm_notifications').insertOne({
          to, from, message, type: 'message', read: false, createdAt: ts,
        });
        return res.status(201).json({ ...doc, id: r.insertedId.toString() });
      }
    }

    // ── NOTIFICATIONS ──────────────────────────────────────────────────────────
    if (resource === 'notifications') {
      const col = db.collection('crm_notifications');

      if (req.method === 'GET') {
        const { to, unread } = req.query;
        if (!to) return res.status(400).json({ error: 'to required' });
        const q = { to };
        if (unread === 'true') q.read = false;
        const docs = await col.find(q).sort({ createdAt: -1 }).limit(50).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { to, from, message, type = 'message' } = req.body;
        if (!to || !from || !message) return res.status(400).json({ error: 'to, from, message required' });
        const recipients = Array.isArray(to) ? to : [to];
        const ts = now();
        const docs = recipients.map(recipient => ({
          to: recipient, from, message, type, read: false, createdAt: ts,
        }));
        // Also write to crm_messages so all communication appears in the Messages page
        const msgCol = db.collection('crm_messages');
        await msgCol.insertMany(recipients.map(recipient => ({
          from, to: recipient, message, type, read: false, createdAt: ts,
        })));
        if (docs.length === 1) {
          const r = await col.insertOne(docs[0]);
          return res.status(201).json({ ...docs[0], id: r.insertedId.toString() });
        }
        await col.insertMany(docs);
        return res.status(201).json({ ok: true, count: docs.length });
      }

      if (req.method === 'PATCH') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        await col.updateOne({ _id: oid }, { $set: { read: true } });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        await col.deleteOne({ _id: oid });
        return res.status(200).json({ ok: true });
      }
    }

    // ── CUSTOMER SMS (notify.lk outbound) ────────────────────────────────────────
    if (resource === 'sms') {
      const col = db.collection('crm_sms_logs');

      if (req.method === 'GET') {
        const docs = await col.find({}).sort({ sentAt: -1 }).limit(200).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { recipients, message, sentBy = 'CRM', template = 'custom' } = req.body || {};
        if (!Array.isArray(recipients) || !recipients.length || !String(message || '').trim())
          return res.status(400).json({ error: 'recipients and message required' });

        const userId   = process.env.NOTIFY_USER_ID;
        const apiKey   = process.env.NOTIFY_API_KEY;
        const senderId = process.env.NOTIFY_SENDER_ID || 'NotifyDEMO';

        const results = await Promise.all(recipients.map(async ({ uid, name, fullName, phone }) => {
          const displayName = fullName || name || 'Customer';
          const personalizedMsg = String(message).replace(/\{name\}/gi, name || 'Customer');
          let sent = false;
          let error = null;

          if (userId && apiKey && phone) {
            let p = String(phone).replace(/[\s\-()+]/g, '');
            if (p.startsWith('0'))    p = '94' + p.slice(1);
            if (!p.startsWith('94')) p = '94' + p;

            if (p.length >= 11) {
              try {
                const params = new URLSearchParams({ user_id: userId, api_key: apiKey, sender_id: senderId, to: p, message: personalizedMsg });
                const smsRes  = await fetch(`https://app.notify.lk/api/v1/send?${params}`, { method: 'GET' });
                const smsData = await smsRes.json().catch(() => ({}));
                sent  = smsData.status === 'success';
                if (!sent) error = smsData.message || 'SMS gateway error';
              } catch (e) { error = e.message; }
            } else { error = 'Invalid phone number format'; }
          } else {
            error = !userId ? 'SMS gateway not configured' : 'Missing phone number';
          }

          await col.insertOne({
            uid: uid || '', name: displayName, phone: phone || '',
            message: personalizedMsg, template, sent, error: error || null,
            sentBy, sentAt: new Date(),
          });
          return { uid, name: displayName, phone, sent, error };
        }));

        const successCount = results.filter(r => r.sent).length;
        return res.status(200).json({ results, successCount, failCount: results.length - successCount });
      }
    }

    // ── CREDIT ACCOUNTS ───────────────────────────────────────────────────────
    if (resource === 'credit') {
      const col = db.collection('crm_credit_accounts');

      if (req.method === 'GET') {
        const { id, type } = req.query;
        if (id) {
          const doc = await col.findOne({ _id: toOid(id) });
          if (!doc) return res.status(404).json({ error: 'Account not found' });
          return res.status(200).json({ ...doc, id: doc._id.toString() });
        }
        const q = { active: { $ne: false } };
        if (type && type !== 'all') q.type = type;
        const docs = await col.find(q).sort({ companyName: 1 }).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { companyName, type, contactPerson, phone, email, address, creditLimit, paymentTermDays, accountManager, branch, notes } = req.body || {};
        if (!companyName || !type || !phone) return res.status(400).json({ error: 'companyName, type, phone required' });
        const doc = {
          companyName: String(companyName).trim(), type: String(type),
          contactPerson: String(contactPerson || '').trim(), phone: String(phone).trim(),
          email: String(email || '').trim(), address: String(address || '').trim(),
          creditLimit: Number(creditLimit) || 0, usedCredit: 0,
          paymentTermDays: Number(paymentTermDays) || 30,
          lastInvoiceDate: null, dueDate: null,
          accountManager: String(accountManager || '').trim(),
          branch: String(branch || 'Pannipitiya').trim(),
          notes: String(notes || '').trim(),
          active: true, createdAt: new Date(), updatedAt: new Date(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ ...doc, id: r.insertedId.toString() });
      }

      if (req.method === 'PATCH') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        const { _id, id: _id2, createdAt, ...body } = req.body || {};
        await col.updateOne({ _id: oid }, { $set: { ...body, updatedAt: new Date() } });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'DELETE') {
        const oid = toOid(req.query.id);
        if (!oid) return res.status(400).json({ error: 'valid id required' });
        await col.updateOne({ _id: oid }, { $set: { active: false, updatedAt: new Date() } });
        return res.status(200).json({ ok: true });
      }
    }

    // ── CREDIT TRANSACTIONS ───────────────────────────────────────────────────
    if (resource === 'credit-tx') {
      const col  = db.collection('crm_credit_tx');
      const acol = db.collection('crm_credit_accounts');

      if (req.method === 'GET') {
        const { accountId } = req.query;
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        const docs = await col.find({ accountId }).sort({ date: -1 }).limit(100).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { accountId, type, amount, description, invoiceNo, recordedBy } = req.body || {};
        if (!accountId || !type || !amount) return res.status(400).json({ error: 'accountId, type, amount required' });
        const amt = Math.abs(Number(amount));
        if (!amt) return res.status(400).json({ error: 'amount must be positive' });

        const account = await acol.findOne({ _id: toOid(accountId) });
        if (!account) return res.status(404).json({ error: 'Account not found' });

        const doc = {
          accountId, type, amount: amt,
          description: String(description || '').trim(),
          invoiceNo: String(invoiceNo || '').trim(),
          recordedBy: String(recordedBy || '').trim(),
          date: new Date(),
        };
        await col.insertOne(doc);

        const creditDelta = type === 'debit' ? amt : -amt;
        const setFields = { updatedAt: new Date() };
        if (type === 'debit') {
          setFields.lastInvoiceDate = new Date();
          const due = new Date();
          due.setDate(due.getDate() + (account.paymentTermDays || 30));
          setFields.dueDate = due;
        }
        await acol.updateOne({ _id: toOid(accountId) }, { $inc: { usedCredit: creditDelta }, $set: setFields });

        return res.status(201).json({ ...doc, id: doc._id?.toString() });
      }
    }

    // ── CREDIT CALL LOGS ──────────────────────────────────────────────────────
    if (resource === 'credit-calls') {
      const col = db.collection('crm_credit_calls');

      if (req.method === 'GET') {
        const { accountId, followUpToday, hasTyreInquiry } = req.query;
        if (followUpToday === 'true') {
          const s = new Date(); s.setHours(0,0,0,0);
          const e = new Date(); e.setHours(23,59,59,999);
          const docs = await col.find({ followUpDate: { $gte: s, $lte: e } }).sort({ followUpDate: 1 }).toArray();
          return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
        }
        if (hasTyreInquiry === 'true') {
          const docs = await col.find({ tyreInquiries: { $exists: true, $not: { $size: 0 } } })
            .sort({ calledAt: -1 }).limit(300).toArray();
          return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
        }
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        const docs = await col.find({ accountId }).sort({ calledAt: -1 }).limit(50).toArray();
        return res.status(200).json(docs.map(d => ({ ...d, id: d._id.toString() })));
      }

      if (req.method === 'POST') {
        const { accountId, companyName, calledBy, phone, outcome, notes, followUpDate, tyreInquiries } = req.body || {};
        if (!accountId || !outcome) return res.status(400).json({ error: 'accountId, outcome required' });
        const doc = {
          accountId,
          companyName: String(companyName || '').trim(),
          calledBy: String(calledBy || '').trim(),
          phone: String(phone || '').trim(),
          outcome: String(outcome).trim(),
          notes: String(notes || '').trim(),
          followUpDate: followUpDate ? new Date(followUpDate) : null,
          tyreInquiries: Array.isArray(tyreInquiries) ? tyreInquiries.map(t => ({
            size:  String(t.size  || '').trim(),
            brand: String(t.brand || '').trim(),
            qty:   Number(t.qty)  || 1,
            notes: String(t.notes || '').trim(),
          })).filter(t => t.size) : [],
          calledAt: new Date(),
        };
        const r = await col.insertOne(doc);
        return res.status(201).json({ ...doc, id: r.insertedId.toString() });
      }
    }

    return res.status(400).json({ error: `Unknown resource: ${resource}` });

  } catch (err) {
    console.error('[crm]', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
