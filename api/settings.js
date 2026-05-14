// api/settings.js
// ─────────────────────────────────────────────────────────────────────────────
// ONE Vercel endpoint that handles everything via query-string routing.
//
// Route table (all via query param  ?resource=X&action=Y):
//
//  GET  /api/settings?resource=section&section=profile        → load profile
//  PUT  /api/settings?resource=section&section=profile        → save profile
//  GET  /api/settings?resource=section&section=business       → load business
//  PUT  /api/settings?resource=section&section=business       → save business
//  GET  /api/settings?resource=section&section=notifications  → load notifications
//  PUT  /api/settings?resource=section&section=notifications  → save notifications
//  GET  /api/settings?resource=section&section=appearance     → load appearance
//  PUT  /api/settings?resource=section&section=appearance     → save appearance
//  GET  /api/settings?resource=sessions                       → list sessions
//  DELETE /api/settings?resource=sessions&id=sess_X           → revoke session
// ─────────────────────────────────────────────────────────────────────────────

import { getCollection } from '../lib/mongodb';

// ── CORS helper (allow your frontend Vercel URL) ──────────────────────────────
function setCors(req, res) {
  const allowed = process.env.FRONTEND_URL || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id');
}

// ── Default data seeded on first GET ─────────────────────────────────────────
const DEFAULTS = {
  profile: {
    name: 'Admin User',
    email: 'admin@anuratyres.lk',
    phone: '077-1234567',
    role: 'Manager',
    bio: '',
    avatarColor: '#FFD700',
  },
  business: {
    name: 'Anura Tyres Pvt Ltd',
    tagline: 'Your Trusted Tyre Specialists',
    email: 'info@anuratyres.lk',
    phone: '011-2851234',
    website: 'www.anuratyres.lk',
    address: '123 High Level Road, Pannipitiya',
    openTime: '08:30',
    closeTime: '19:00',
    currency: 'LKR',
    timezone: 'Asia/Colombo',
  },
  notifications: {
    newBooking: true,
    bookingUpdates: true,
    lowStock: true,
    staffAlerts: false,
    dailySummary: true,
    weeklyReport: false,
    sound: true,
    email: true,
    browserPush: false,
  },
  appearance: {
    theme: 'dark',
    accent: '#FFD700',
    compact: false,
    animations: true,
    fontSize: 'md',
  },
};

const SEED_SESSIONS = [
  { id: 'sess_001', device: 'Chrome on Windows',      location: 'Colombo, LK',     time: 'Now — Current session', current: true  },
  { id: 'sess_002', device: 'Safari on iPhone 14',    location: 'Pannipitiya, LK', time: '2 hours ago',           current: false },
  { id: 'sess_003', device: 'Firefox on MacBook Pro', location: 'Maharagama, LK',  time: 'Yesterday, 6:45 PM',    current: false },
];

const ALLOWED_SECTIONS = new Set(['profile', 'business', 'notifications', 'appearance']);

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res);

  // Preflight
  if (req.method === 'OPTIONS') return res.status(204).end();

  const userId   = req.headers['x-user-id'] || 'default_admin';
  const resource = req.query.resource; // 'section' | 'sessions'

  try {
    // ── SECTION routes ────────────────────────────────────────────────────────
    if (resource === 'section') {
      const section = req.query.section;

      if (!section || !ALLOWED_SECTIONS.has(section)) {
        return res.status(400).json({ error: `Unknown section "${section}"` });
      }

      const col = await getCollection('settings');

      // GET — load
      if (req.method === 'GET') {
        const doc = await col.findOne({ userId, section });
        if (!doc) return res.status(200).json({ data: DEFAULTS[section], source: 'default' });
        const { _id, userId: _u, section: _s, ...data } = doc;
        return res.status(200).json({ data, source: 'db' });
      }

      // PUT — save / upsert
      if (req.method === 'PUT') {
        const body = req.body;
        if (!body || typeof body !== 'object') {
          return res.status(400).json({ error: 'Body must be a JSON object' });
        }
        const { _id, userId: _u, section: _s, ...payload } = body;
        await col.updateOne(
          { userId, section },
          { $set: { ...payload, userId, section, updatedAt: new Date().toISOString() } },
          { upsert: true }
        );
        return res.status(200).json({ success: true });
      }

      return res.status(405).json({ error: 'Method not allowed for section' });
    }

    // ── SESSIONS routes ───────────────────────────────────────────────────────
    if (resource === 'sessions') {
      const col = await getCollection('sessions');

      // GET — list
      if (req.method === 'GET') {
        let sessions = await col.find({ userId }).sort({ createdAt: -1 }).toArray();
        if (sessions.length === 0) {
          const seeded = SEED_SESSIONS.map(s => ({
            ...s,
            userId,
            createdAt: new Date().toISOString(),
          }));
          await col.insertMany(seeded);
          sessions = seeded;
        }
        const cleaned = sessions.map(({ _id, userId: _u, ...rest }) => rest);
        return res.status(200).json({ sessions: cleaned });
      }

      // DELETE — revoke by id
      if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: '`id` query param required' });

        const session = await col.findOne({ userId, id });
        if (!session)          return res.status(404).json({ error: 'Session not found' });
        if (session.current)   return res.status(403).json({ error: 'Cannot revoke current session' });

        await col.deleteOne({ userId, id });
        return res.status(200).json({ success: true });
      }

      return res.status(405).json({ error: 'Method not allowed for sessions' });
    }

    // ── Unknown resource ──────────────────────────────────────────────────────
    return res.status(400).json({
      error: 'Unknown resource. Use ?resource=section&section=X or ?resource=sessions',
    });

  } catch (err) {
    console.error('[/api/settings]', err);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
}