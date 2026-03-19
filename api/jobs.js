// /api/jobs.js
// Handles ALL job management routes via ?resource= param
//
// Routes:
//   GET    ?branch=X&date=YYYY-MM-DD            → list jobs, auto-pull today's bookings
//   POST   (no resource)                         → create manual job
//   PATCH  ?resource=assign&id=X                → assign_staff / assign_bay / unassign / chain_next / set_status
//   DELETE ?resource=assign&id=X                → delete job
//   POST   ?resource=timer                       → start / pause / approve_resume / stop
//   GET    ?resource=lobby&branch=X&date=Y       → live countdowns for lobby screen
//   GET    ?resource=report&branch=X&date=Y      → end-of-day productivity report

const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

// ─── Service time allocations (minutes) ──────────────────────────────────────
const SERVICE_TIMES = {
  'Wheel Balancing':        20,
  'Wheel Alignment':        20,
  'Front Tyre Change':      20,
  'Rear Tyre Change':       20,
  'Both Front Tyres':       30,
  'Both Rear Tyres':        30,
  'All 4 Tyres':            50,
  'Single Tyre Change':     20,
  'Tyre Change':            20,
  'Tyre Repair (Puncture)': 15,
  'Tyre Puncture Repair':   15,
  'Battery Replacement':    15,
  'Battery Check & Replace':15,
  'Oil Change':             30,
  'Full Service':           60,
  'Full Vehicle Check':     40,
  'Light Truck Tyre Change':30,
  'Heavy Vehicle Tyre':     45,
  'Heavy Vehicle Alignment':45,
  'Truck Tyre Change':      45,
  'Bus Full Service':       60,
  'Tyre Rotation':          20,
  'Brake Inspection':       25,
  'Brake Service':          25,
  'Suspension Check':       30,
  'AC Service':             45,
  'Nitrogen Filling':       15,
  'General Service':        60,
};

function getAllocatedMins(serviceName) {
  if (!serviceName) return 30;
  const key = Object.keys(SERVICE_TIMES).find(
    k => k.toLowerCase() === serviceName.toLowerCase()
  );
  return key ? SERVICE_TIMES[key] : 30;
}

// ─── MongoDB connection ───────────────────────────────────────────────────────
// Extract DB name from URI — same DB that bookings.js uses via Mongoose
function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  // URI format: mongodb+srv://user:pass@cluster/dbname?options
  const match = uri.match(/\/([^\/\?]+)(\?|$)/);
  if (match && match[1] && match[1] !== '') return match[1];
  return 'anura-tyres';
}

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db(getDbName(MONGODB_URI));
}

// ─── Pull today's bookings → job_assignments ──────────────────────────────────
// Bookings schema: { branch: { name }, date: Date, services: [{name}],
//                   customer: { name, vehicleNo }, status, timeSlot }
async function syncBookingsToJobs(db, branch, dateStr) {
  const jobsCol = db.collection('job_assignments');

  // Date range — covers UTC+5:30 (Sri Lanka)
  // New bookings saved at T12:00Z, old ones at T00:00Z, so search wide
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  dayStart.setMinutes(dayStart.getMinutes() - 330); // 18:30 prev day UTC
  const dayEnd   = new Date(`${dateStr}T23:59:59.999Z`);

  // Branch matching — website stores full name e.g. "Anura Tyres (Pvt) Ltd Pannipitiya"
  // Job board uses short name e.g. "Pannipitiya"
  // Use regex so "Pannipitiya" matches any branch name containing that word
  const branchRegex = new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const bookings = await db.collection('bookings').find({
    'branch.name': { $regex: branchRegex },
    date:   { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['Cancelled', 'Completed'] },
  }).toArray();

  for (const booking of bookings) {
    const bookingIdStr = booking._id.toString();

    const services = Array.isArray(booking.services)
      ? booking.services.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean)
      : ['General Service'];

    for (const serviceName of services) {
      const exists = await jobsCol.findOne({
        bookingId: bookingIdStr,
        service:   serviceName,
      });

      if (!exists) {
        await jobsCol.insertOne({
          bookingId:     bookingIdStr,
          bookingRef:    booking.bookingId || '',
          branch,
          date:          dateStr,
          timeSlot:      booking.timeSlot          || '',
          vehiclePlate:  booking.customer?.vehicleNo || '',
          customerName:  booking.customer?.name      || '',
          customerPhone: booking.customer?.phone     || '',
          service:       serviceName,
          allocatedMins: getAllocatedMins(serviceName),
          staffId:       null,
          bayNumber:     null,
          status:        'unassigned',
          chainedFromJob:null,
          chainedToJob:  null,
          order:         0,
          source:        'website',
          createdAt:     new Date(),
          updatedAt:     new Date(),
        });
      }
    }
  }
}


module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db        = await getDb();
    const jobsCol   = db.collection('job_assignments');
    const timersCol = db.collection('job_timers');
    const { resource, id, branch, date } = req.query;

    // ═════════════════════════════════════════════════════
    // DEBUG — GET ?resource=debug&branch=X&date=Y
    // Shows raw bookings found — remove after fixing
    // ═════════════════════════════════════════════════════════════════
    if (resource === 'debug') {
      if (req.method !== 'GET') return res.status(405).end();
      const allBookings = await db.collection('bookings')
        .find({}).sort({ _id: -1 }).toArray();
      return res.status(200).json({
        db: getDbName(MONGODB_URI),
        total: allBookings.length,
        bookings: allBookings.map(b => ({
          bookingId:  b.bookingId,
          date:       b.date,
          createdAt:  b.createdAt,
          branchName: b.branch?.name,
          status:     b.status,
          services:   b.services?.map(s => s.name),
          customer:   b.customer?.name,
        })),
      });
    }