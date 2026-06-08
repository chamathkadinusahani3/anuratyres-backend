// /api/staff.js
// Handles ALL staff + leave + notification routes via ?resource= and ?action= params
//
// ── STAFF routes ──────────────────────────────────────────────────────────────
//   POST   ?action=login                       → staff login → JWT
//   POST   ?action=register                    → create staff account
//   POST   ?action=update                      → update name/role/branch/phone/password
//   POST   ?action=deactivate                  → set active:false
//   GET    (no resource)  ?branch=X&date=Y     → list staff + today day-status
//   PATCH  ?resource=status&id=X               → clock_in / start_break / end_break / assign_bay / set_status
//
// ── LEAVE routes ──────────────────────────────────────────────────────────────
//   GET    ?resource=leave&branch=X            → all leave requests for a branch
//   GET    ?resource=leave&staffId=X           → leave requests for one staff member
//   POST   ?resource=leave&action=submit       → staff submits a leave request (also writes notification)
//   POST   ?resource=leave&action=respond      → manager approves / denies a request
//
// ── NOTIFICATION routes ───────────────────────────────────────────────────────
//   GET    ?resource=notifications&branch=X    → fetch notifications for a branch
//   PATCH  ?resource=notifications             → mark read / delete
//     body { action:'mark_read', id }          → mark one as read
//     body { action:'mark_all_read', branch }  → mark all read for branch
//     body { action:'delete', id }             → delete one notification
//
// Collections: staff, staff_day_status, leave_requests, notifications

const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');

const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET  = process.env.JWT_SECRET || 'anura-tyres-staff-secret';

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db('anura-tyres');
}

// ─── Default service prices (seeded on first GET) ────────────────────────────
const DEFAULT_SERVICE_PRICES = [
  { name: 'Wheel Balancing',      code: 'WB',  price: 800,   duration: 30  },
  { name: 'Wheel Alignment',      code: 'AL',  price: 2500,  duration: 60  },
  { name: 'Tyre Replacement',     code: 'TR',  price: 4000,  duration: 45  },
  { name: 'Tyre Rotation',        code: 'RT',  price: 1000,  duration: 30  },
  { name: 'Nitrogen Filling',     code: 'NF',  price: 500,   duration: 15  },
  { name: 'Flat Repair',          code: 'FR',  price: 600,   duration: 20  },
  { name: 'Puncture Repair',      code: 'PR',  price: 600,   duration: 20  },
  { name: 'Brake Service',        code: 'BS',  price: 5000,  duration: 90  },
  { name: 'Suspension Check',     code: 'SC',  price: 1500,  duration: 45  },
  { name: 'Oil Change',           code: 'OC',  price: 3500,  duration: 30  },
  { name: 'Battery Service',      code: 'BAT', price: 2000,  duration: 30  },
  { name: 'AC Service',           code: 'AC',  price: 8000,  duration: 120 },
  { name: 'Full Service',         code: 'FS',  price: 12000, duration: 180 },
  { name: 'Wheel Change',         code: 'WC',  price: 1500,  duration: 30  },
  { name: 'Tyre Sales',           code: 'TS',  price: 0,     duration: 20  },
  { name: 'Heavy Vehicle Alignment', code: 'HV', price: 6000, duration: 90 },
];

// ─── Notification helper ──────────────────────────────────────────────────────
async function pushNotification(notifCol, { branch, type, title, message }) {
  await notifCol.insertOne({
    branch,
    type,       // 'info' | 'warning' | 'error' | 'success'
    title,
    message,
    read:      false,
    createdAt: new Date().toISOString(),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db       = await getDb();
    const staffCol    = db.collection('staff');
    const dayCol      = db.collection('staff_day_status');
    const leaveCol    = db.collection('leave_requests');
    const notifCol    = db.collection('notifications');
    const pricesCol   = db.collection('service_prices');
    const bookingsCol = db.collection('bookings');

    const { resource, action, id, branch, date, staffId, month } = req.query;

    // ═══════════════════════════════════════════════════════════════════════════
    // SERVICE PRICES  (?resource=service-prices)
    // ═══════════════════════════════════════════════════════════════════════════
    if (resource === 'service-prices') {
      if (req.method === 'GET') {
        let prices = await pricesCol.find({}).sort({ name: 1 }).toArray();
        if (prices.length === 0) {
          await pricesCol.insertMany(DEFAULT_SERVICE_PRICES.map(p => ({ ...p })));
          prices = await pricesCol.find({}).sort({ name: 1 }).toArray();
        }
        return res.status(200).json(prices.map(p => ({ ...p, id: p._id.toString() })));
      }
      // PUT — replace entire price list
      if (req.method === 'PUT') {
        const { prices } = req.body;
        if (!Array.isArray(prices)) return res.status(400).json({ error: 'prices array required' });
        await pricesCol.deleteMany({});
        if (prices.length > 0) {
          await pricesCol.insertMany(prices.map(({ id: _id, ...p }) => ({
            name:     String(p.name || '').trim(),
            code:     String(p.code || '').trim().toUpperCase(),
            price:    Number(p.price)    || 0,
            duration: Number(p.duration) || 0,
          })));
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PAYROLL STATS  (?resource=payroll-stats&branch=X&month=YYYY-MM)
    // Returns real revenue from completed bookings × configured service prices
    // ═══════════════════════════════════════════════════════════════════════════
    if (resource === 'payroll-stats') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

      const targetMonth = month || new Date().toISOString().slice(0, 7); // "2026-06"
      const [yr, mo]    = targetMonth.split('-').map(Number);
      const SL_OFFSET   = 5.5 * 60 * 60 * 1000;

      // Month boundaries in SL time → UTC ISO strings
      const monthStartSL = new Date(Date.UTC(yr, mo - 1, 1, 0, 0, 0));
      const monthEndSL   = new Date(Date.UTC(yr, mo,     0, 23, 59, 59, 999));
      const startISO     = new Date(monthStartSL.getTime() - SL_OFFSET).toISOString();
      const endISO       = new Date(monthEndSL.getTime()   - SL_OFFSET).toISOString();

      // Build price lookup  (case-insensitive name → price)
      const allPrices = await pricesCol.find({}).toArray();
      const priceMap  = {};
      allPrices.forEach(p => { priceMap[p.name.toLowerCase().trim()] = p.price || 0; });

      // Completed bookings for the period (optionally branch-filtered)
      const bQuery = { status: 'Completed', date: { $gte: startISO, $lte: endISO } };
      if (branch) bQuery['branch.name'] = { $regex: branch, $options: 'i' };

      const bookings = await bookingsCol.find(bQuery).toArray();

      let totalRevenue = 0;
      bookings.forEach(b => {
        (b.services || []).forEach(svc => {
          const key   = (svc.name || '').toLowerCase().trim();
          totalRevenue += priceMap[key] || 0;
        });
      });

      return res.status(200).json({
        ok:           true,
        month:        targetMonth,
        totalJobs:    bookings.length,
        totalRevenue,
        bookingCount: bookings.length,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // NOTIFICATION ROUTES  (?resource=notifications)
    // ═══════════════════════════════════════════════════════════════════════════
    if (resource === 'notifications') {

      // ── GET: fetch notifications for a branch ──────────────────────────────
      if (req.method === 'GET') {
        if (!branch) return res.status(400).json({ error: 'branch required' });

        const docs = await notifCol
          .find({ branch })
          .sort({ createdAt: -1 })
          .limit(50)
          .toArray();

        return res.status(200).json(
          docs.map(d => ({
            id:        d._id.toString(),
            type:      d.type,
            title:     d.title,
            message:   d.message,
            read:      d.read,
            createdAt: d.createdAt,
          }))
        );
      }

      // ── PATCH: mark read / delete ──────────────────────────────────────────
      if (req.method === 'PATCH') {
        const { action: a, id: nid, branch: b } = req.body;

        if (a === 'mark_read' && nid) {
          let oid;
          try { oid = new ObjectId(nid); } catch { return res.status(400).json({ error: 'Invalid id' }); }
          await notifCol.updateOne({ _id: oid }, { $set: { read: true } });
          return res.status(200).json({ ok: true });
        }

        if (a === 'mark_all_read' && b) {
          await notifCol.updateMany({ branch: b, read: false }, { $set: { read: true } });
          return res.status(200).json({ ok: true });
        }

        if (a === 'delete' && nid) {
          let oid;
          try { oid = new ObjectId(nid); } catch { return res.status(400).json({ error: 'Invalid id' }); }
          await notifCol.deleteOne({ _id: oid });
          return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown notification action' });
      }

      return res.status(405).json({ error: 'Method not allowed for notifications' });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LEAVE ROUTES  (?resource=leave)
    // ═══════════════════════════════════════════════════════════════════════════
    if (resource === 'leave') {

      // ── GET: fetch leave requests ──────────────────────────────────────────
      if (req.method === 'GET') {
        const query = {};
        if (branch)  query.branch  = branch;
        if (staffId) query.staffId = staffId;

        const docs = await leaveCol
          .find(query)
          .sort({ createdAt: -1 })
          .limit(200)
          .toArray();

        return res.status(200).json(
          docs.map(d => ({
            id:          d._id.toString(),
            staffId:     d.staffId,
            staffName:   d.staffName,
            branch:      d.branch,
            type:        d.type,
            date:        d.date,
            reason:      d.reason || '',
            status:      d.status,
            createdAt:   d.createdAt,
            respondedAt: d.respondedAt || null,
            respondedBy: d.respondedBy || null,
          }))
        );
      }

      // ── POST: submit or respond ────────────────────────────────────────────
      if (req.method === 'POST') {

        // SUBMIT — staff creates a leave request
        if (action === 'submit') {
          const { staffId: sid, staffName, branch: b, type, date: d, reason } = req.body;

          if (!sid || !staffName || !b || !type)
            return res.status(400).json({ error: 'staffId, staffName, branch, type required' });

          const validTypes = ['Annual Leave', 'Sick Leave', 'Break Request', 'Tomorrow Off'];
          if (!validTypes.includes(type))
            return res.status(400).json({ error: 'Invalid leave type' });

          const leaveDate = d || new Date().toISOString().split('T')[0];

          const doc = {
            staffId:   sid,
            staffName,
            branch:    b,
            type,
            date:      leaveDate,
            reason:    (reason || '').trim(),
            status:    'Pending',
            createdAt: new Date().toISOString(),
          };

          const result = await leaveCol.insertOne(doc);

          // ── Push notification to admin dashboard ──────────────────────────
          const typeIcon  = { 'Break Request': '☕', 'Annual Leave': '📅', 'Sick Leave': '🏥', 'Tomorrow Off': '⚠️' };
          const notifType = type === 'Sick Leave' ? 'warning' : 'info';
          const dateLabel = type === 'Break Request' ? 'today' : leaveDate;
          await pushNotification(notifCol, {
            branch:  b,
            type:    notifType,
            title:   `Leave Request — ${type}`,
            message: `${staffName} requested ${type} for ${dateLabel}.${reason ? ` Reason: ${reason}` : ''}`,
          });
          // ─────────────────────────────────────────────────────────────────

          return res.status(201).json({ id: result.insertedId.toString(), ...doc });
        }

        // RESPOND — manager approves or denies
        if (action === 'respond') {
          const { id: lid, status, respondedBy } = req.body;

          if (!lid || !status)
            return res.status(400).json({ error: 'id and status required' });
          if (!['Approved', 'Denied'].includes(status))
            return res.status(400).json({ error: 'status must be Approved or Denied' });

          let oid;
          try { oid = new ObjectId(lid); } catch { return res.status(400).json({ error: 'Invalid id' }); }

          await leaveCol.updateOne(
            { _id: oid },
            { $set: { status, respondedAt: new Date().toISOString(), respondedBy: respondedBy || 'Admin' } }
          );
          return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Unknown leave action' });
      }

      return res.status(405).json({ error: 'Method not allowed for leave' });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STAFF ROUTES
    // ═══════════════════════════════════════════════════════════════════════════

    // ── GET: list staff ──────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const today     = new Date().toISOString().split('T')[0];
      const queryDate = date || today;

      const memberQuery = branch
        ? { branch, active: true }
        : { active: true };

      const members = await staffCol.find(memberQuery).toArray();

      const statusMap = {};
      if (branch) {
        const dayStatuses = await dayCol.find({ branch, date: queryDate }).toArray();
        dayStatuses.forEach(s => { statusMap[s.staffId.toString()] = s; });
      }

      return res.status(200).json(
        members.map(m => ({
          id:           m._id,
          _id:          m._id,
          name:         m.name,
          role:         m.role,
          jobTitle:     m.jobTitle || m.role || '',
          username:     m.username,
          phone:        m.phone || '',
          branch:       m.branch,
          skills:       m.skills       || [],
          workingHours: m.workingHours || null,
          baseSalary:   m.baseSalary   ?? null,
          otRate:       m.otRate       ?? null,
          dayStatus: statusMap[m._id.toString()] || {
            status: 'off', bayNumber: null, clockInAt: null,
          },
        }))
      );
    }

    // ── POST: auth & management ──────────────────────────────────────────────
    if (req.method === 'POST') {

      if (action === 'login') {
        const { username, password } = req.body;
        if (!username || !password)
          return res.status(400).json({ error: 'Username and password required' });

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

      if (action === 'register') {
        const { username, password, name, role, jobTitle, branch: b, phone, skills, workingHours, baseSalary, otRate } = req.body;
        if (!username || !password || !name || !b)
          return res.status(400).json({ error: 'username, password, name, branch required' });

        const exists = await staffCol.findOne({ username: username.toLowerCase().trim() });
        if (exists) return res.status(409).json({ error: 'Username already taken' });

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await staffCol.insertOne({
          username:     username.toLowerCase().trim(),
          passwordHash,
          name,
          role:         role || 'Cashier',
          jobTitle:     jobTitle || role || 'Staff',
          branch:       b,
          phone:        phone || '',
          skills:       Array.isArray(skills) ? skills : [],
          workingHours: workingHours || null,
          baseSalary:   baseSalary   ? Number(baseSalary)  : null,
          otRate:       otRate       ? Number(otRate)       : null,
          active:       true,
          createdAt:    new Date(),
        });
        return res.status(201).json({ id: result.insertedId, name, username });
      }

      if (action === 'update') {
        const { id: uid, name, role, jobTitle, branch: b, phone, password, skills, baseSalary, otRate } = req.body;
        if (!uid) return res.status(400).json({ error: 'id required' });
        let oid;
        try { oid = new ObjectId(uid); } catch { return res.status(400).json({ error: 'Invalid id' }); }
        const update = {
          name,
          role,
          jobTitle:   jobTitle || role,
          branch:     b,
          phone:      phone || '',
          skills:     Array.isArray(skills) ? skills : [],
        };
        if (baseSalary !== undefined && baseSalary !== null) update.baseSalary = Number(baseSalary);
        if (otRate     !== undefined && otRate     !== null) update.otRate     = Number(otRate);
        if (password && password.length >= 6) update.passwordHash = await bcrypt.hash(password, 10);
        await staffCol.updateOne({ _id: oid }, { $set: update });
        return res.status(200).json({ ok: true });
      }

      if (action === 'update-salary') {
        const { id: uid, baseSalary, otRate } = req.body;
        if (!uid) return res.status(400).json({ error: 'id required' });
        let oid;
        try { oid = new ObjectId(uid); } catch { return res.status(400).json({ error: 'Invalid id' }); }
        const update = {};
        if (baseSalary !== undefined) update.baseSalary = Number(baseSalary) || 0;
        if (otRate     !== undefined) update.otRate     = Number(otRate)     || 0;
        await staffCol.updateOne({ _id: oid }, { $set: update });
        return res.status(200).json({ ok: true });
      }

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

    // ── PATCH: day status ────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const sid_raw = id || req.body?.staffId;
      if (!sid_raw) return res.status(400).json({ error: 'staffId required' });
      let sid;
      try { sid = new ObjectId(sid_raw); } catch { return res.status(400).json({ error: 'Invalid staffId' }); }

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
        const validStatuses = ['active', 'on_break', 'off', 'Available', 'Busy', 'On Break', 'On Leave'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status value' });
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