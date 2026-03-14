// /api/staff.js
// Handles ALL staff routes via ?resource= and ?action= params
// Routes:
//   POST ?action=login           → staff login → JWT
//   POST ?action=register        → create staff account
//   POST ?action=update          → update name/role/branch/phone
//   POST ?action=deactivate      → set active:false
//   GET  ?resource=list&branch=X&date=Y  → list staff + today status
//   PATCH ?resource=status&id=X  → clock_in / start_break / end_break / assign_bay / set_status

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { setCorsHeaders } = require('./cors');

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET  = process.env.JWT_SECRET || 'anura-tyres-staff-secret';

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db('anura-tyres');
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db       = await getDb();
    const staffCol = db.collection('staff');
    const dayCol   = db.collection('staff_day_status');
    const { resource, action, id, branch, date } = req.query;

    // ── GET: list staff for board ─────────────────────────────────────────
    if (req.method === 'GET') {
      if (!branch || !date) return res.status(400).json({ error: 'branch and date required' });

      const members = await staffCol.find({ branch, active: true }).toArray();
      const dayStatuses = await dayCol.find({ branch, date }).toArray();
      const statusMap = {};
      dayStatuses.forEach(s => { statusMap[s.staffId.toString()] = s; });

      return res.status(200).json(members.map(m => ({
        id:       m._id,
        _id:      m._id,
        name:     m.name,
        role:     m.role,
        username: m.username,
        phone:    m.phone || '',
        branch:   m.branch,
        dayStatus: statusMap[m._id.toString()] || {
          status: 'off', bayNumber: null, clockInAt: null,
        },
      })));
    }

    // ── POST: auth actions ────────────────────────────────────────────────
    if (req.method === 'POST') {

      // LOGIN
      if (action === 'login') {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const member = await staffCol.findOne({ username: username.toLowerCase().trim(), active: true });
        if (!member) return res.status(401).json({ error: 'Invalid credentials' });

        const valid = await bcrypt.compare(password, member.passwordHash);
        if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign(
          { id: member._id, role: member.role, branch: member.branch, name: member.name },
          JWT_SECRET,
          { expiresIn: '12h' }
        );
        return res.status(200).json({
          token,
          staff: { id: member._id, name: member.name, role: member.role, branch: member.branch, username: member.username },
        });
      }

      // REGISTER
      if (action === 'register') {
        const { username, password, name, role, branch: b, phone } = req.body;
        if (!username || !password || !name || !b)
          return res.status(400).json({ error: 'username, password, name, branch required' });

        const exists = await staffCol.findOne({ username: username.toLowerCase().trim() });
        if (exists) return res.status(409).json({ error: 'Username already taken' });

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await staffCol.insertOne({
          username: username.toLowerCase().trim(), passwordHash,
          name, role: role || 'mechanic', branch: b, phone: phone || '',
          active: true, createdAt: new Date(),
        });
        return res.status(201).json({ id: result.insertedId, name, username });
      }

      // UPDATE
      if (action === 'update') {
        const { id: uid, name, role, branch: b, phone, password } = req.body;
        if (!uid) return res.status(400).json({ error: 'id required' });
        let oid;
        try { oid = new ObjectId(uid); } catch { return res.status(400).json({ error: 'Invalid id' }); }

        const update = { name, role, branch: b, phone: phone || '' };
        if (password && password.length >= 6) {
          update.passwordHash = await bcrypt.hash(password, 10);
        }
        await staffCol.updateOne({ _id: oid }, { $set: update });
        return res.status(200).json({ ok: true });
      }

      // DEACTIVATE
      if (action === 'deactivate') {
        const { id: uid } = req.body;
        if (!uid) return res.status(400).json({ error: 'id required' });
        let oid;
        try { oid = new ObjectId(uid); } catch { return res.status(400).json({ error: 'Invalid id' }); }
        await staffCol.updateOne({ _id: oid }, { $set: { active: false } });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    // ── PATCH: day status (clock in, break, bay) ──────────────────────────
    if (req.method === 'PATCH') {
      const staffId = id || req.body?.staffId;
      if (!staffId) return res.status(400).json({ error: 'staffId required' });
      let sid;
      try { sid = new ObjectId(staffId); } catch { return res.status(400).json({ error: 'Invalid staffId' }); }

      const { action: a, branch: b, date: d, status, bayNumber } = req.body;
      if (!b || !d) return res.status(400).json({ error: 'branch and date required' });

      const now    = new Date();
      const filter = { staffId: sid, branch: b, date: d };
      const opts   = { upsert: true };

      if (a === 'clock_in') {
        await dayCol.updateOne(filter,
          { $set: { status: 'active', clockInAt: now }, $setOnInsert: { bayNumber: null, breakLogs: [] } }, opts);
      } else if (a === 'clock_out') {
        await dayCol.updateOne(filter, { $set: { status: 'off', clockOutAt: now } }, opts);
      } else if (a === 'start_break') {
        await dayCol.updateOne(filter,
          { $set: { status: 'on_break' }, $push: { breakLogs: { startedAt: now, endedAt: null } } }, opts);
      } else if (a === 'end_break') {
        await dayCol.updateOne(
          { ...filter, 'breakLogs.endedAt': null },
          { $set: { status: 'active', 'breakLogs.$.endedAt': now } }
        );
      } else if (a === 'assign_bay') {
        await dayCol.updateOne(filter, { $set: { bayNumber: bayNumber ?? null } }, opts);
      } else if (a === 'set_status' && status) {
        await dayCol.updateOne(filter, { $set: { status } }, opts);
      } else {
        return res.status(400).json({ error: 'Unknown action' });
      }

      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('staff.js error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};