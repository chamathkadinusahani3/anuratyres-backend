// /api/jobs.js
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

const SERVICE_TIMES = {
  'Wheel Balancing':        1,  'Wheel Alignment':        20,
  'Front Tyre Change':      20, 'Rear Tyre Change':        20,
  'Both Front Tyres':       30, 'Both Rear Tyres':         30,
  'All 4 Tyres':            50, 'Single Tyre Change':      20,
  'Tyre Change':            20, 'Tyre Repair (Puncture)':  15,
  'Tyre Puncture Repair':   15, 'Battery Replacement':     15,
  'Battery Check & Replace':15, 'Oil Change':              30,
  'Full Service':           60, 'Full Vehicle Check':      40,
  'Light Truck Tyre Change':30, 'Heavy Vehicle Tyre':      45,
  'Heavy Vehicle Alignment':45, 'Truck Tyre Change':       45,
  'Bus Full Service':       60, 'Tyre Rotation':           20,
  'Brake Inspection':       25, 'Brake Service':           25,
  'Suspension Check':       30, 'AC Service':              45,
  'Nitrogen Filling':       15, 'General Service':         60,
};

function getAllocatedMins(serviceName) {
  if (!serviceName) return 30;
  const key = Object.keys(SERVICE_TIMES).find(k => k.toLowerCase() === serviceName.toLowerCase());
  return key ? SERVICE_TIMES[key] : 30;
}

function getDbName(uri) {
  if (!uri) return 'anura-tyres';
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return (match && match[1]) ? match[1] : 'anura-tyres';
}

let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db(getDbName(MONGODB_URI));
}

// ─── Sync job status → booking status ────────────────────────────────────────
/**
 * Mirror job status changes onto the linked booking document.
 *
 *  job in_progress  → booking "In Progress"
 *  job done         → if ALL jobs for this booking are done → booking "Completed"
 *                     otherwise                             → booking "In Progress"
 *
 * Silently swallows errors so a booking-sync failure never breaks the job API.
 */
async function syncJobStatusToBooking(db, job, newJobStatus) {
  try {
    if (!job.bookingId) return; // walk-in / manual job — no linked booking

    const bookingsCol = db.collection('bookings');
    const jobsCol     = db.collection('job_assignments');

    let bookingOid;
    try { bookingOid = new ObjectId(job.bookingId); } catch { return; }

    const booking = await bookingsCol.findOne({ _id: bookingOid });
    if (!booking) return;
    // Never downgrade a booking that is already Cancelled or Completed
    if (['Cancelled', 'Completed'].includes(booking.status)) return;

    if (newJobStatus === 'in_progress') {
      await bookingsCol.updateOne(
        { _id: bookingOid },
        { $set: { status: 'In Progress', updatedAt: new Date() } },
      );
      return;
    }

    if (newJobStatus === 'done') {
      const allJobs = await jobsCol.find({ bookingId: job.bookingId }).toArray();
      const allDone = allJobs.every(j =>
        j._id.toString() === job._id.toString()
          ? true           // the job we just stopped — count as done
          : j.status === 'done',
      );
      await bookingsCol.updateOne(
        { _id: bookingOid },
        { $set: { status: allDone ? 'Completed' : 'In Progress', updatedAt: new Date() } },
      );
    }
  } catch (err) {
    console.error('[syncJobStatusToBooking] non-fatal error:', err.message);
  }
}

async function syncBookingsToJobs(db, branch, dateStr) {
  const jobsCol  = db.collection('job_assignments');
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  dayStart.setMinutes(dayStart.getMinutes() - 330);
  const dayEnd   = new Date(`${dateStr}T23:59:59.999Z`);
  const branchRegex = new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

  const bookings = await db.collection('bookings').find({
    $or: [
      { 'branch.name': { $regex: branchRegex } },
      { 'branch.name': null },
      { 'branch.name': { $exists: false } },
      { branch: null },
    ],
    date:   { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['Cancelled', 'Completed'] },
  }).toArray();

  const filtered = bookings.filter(b => {
    const bName = b.branch?.name;
    if (!bName) return true;
    return branchRegex.test(bName);
  });

  for (const booking of filtered) {
    const bookingIdStr = booking._id.toString();
    const services = Array.isArray(booking.services)
      ? booking.services.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean)
      : ['General Service'];

    for (const serviceName of services) {
      const exists = await jobsCol.findOne({ bookingId: bookingIdStr, service: serviceName });
      if (!exists) {
        await jobsCol.insertOne({
          bookingId:     bookingIdStr,
          bookingRef:    booking.bookingId    || '',
          branch,
          date:          dateStr,
          timeSlot:      booking.timeSlot     || '',
          vehiclePlate:  booking.customer?.vehicleNo || '',
          customerName:  booking.customer?.name      || '',
          customerPhone: booking.customer?.phone     || '',
          service:       serviceName,
          allocatedMins: getAllocatedMins(serviceName),
          staffId: null, bayNumber: null, status: 'unassigned',
          chainedFromJob: null, chainedToJob: null, order: 0,
          source: 'website', createdAt: new Date(), updatedAt: new Date(),
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
    const logsCol   = db.collection('job_stop_logs');

    const { resource, id, branch, date } = req.query;

    const pathSegments = req.url.split('?')[0].split('/').filter(Boolean);
    const lastSegment  = pathSegments[pathSegments.length - 1];

    // ── STOP JOB WITH REASON ─────────────────────────────────────────────────
    if (lastSegment === 'stop' || resource === 'jobs/stop') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

      const { vehiclePlate, reason } = req.body;
      if (!vehiclePlate || !reason)
        return res.status(400).json({ error: 'vehiclePlate and reason required' });

      const validReasons = ['COMPLETED', 'TERMINATED', 'STOCK_ISSUE', 'PRICE_DISAGREE'];
      if (!validReasons.includes(reason))
        return res.status(400).json({ error: `Invalid reason. Must be one of: ${validReasons.join(', ')}` });

      const now  = new Date();
      const jobs = await jobsCol.find({ vehiclePlate, status: { $in: ['in_progress', 'paused'] } }).toArray();
      if (jobs.length === 0) return res.status(404).json({ error: 'No active job found for this vehicle plate' });

      const stoppedJobs = [];
      for (const job of jobs) {
        const jid   = job._id;
        const timer = await timersCol.findOne({ jobId: jid });

        if (timer && !timer.stoppedAt) {
          const totalElapsedSecs = Math.floor((now - new Date(timer.startedAt)) / 1000);
          let totalPausedSecs = 0;
          for (const p of timer.pauseLogs) {
            if (p.resumedAt)
              totalPausedSecs += Math.floor((new Date(p.resumedAt) - new Date(p.pausedAt)) / 1000);
          }
          const activeWorkSecs = totalElapsedSecs - totalPausedSecs;
          const allocatedSecs  = (job.allocatedMins || 30) * 60;
          const isOvertime     = activeWorkSecs > allocatedSecs;
          const overtimeSecs   = isOvertime ? activeWorkSecs - allocatedSecs : 0;

          await timersCol.updateOne({ jobId: jid }, {
            $set: { stoppedAt: now, totalElapsedSecs, totalPausedSecs, activeWorkSecs, isOvertime, overtimeSecs, stoppedReason: reason },
          });
        }

        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'done', updatedAt: now } });

        await logsCol.insertOne({
          jobId: jid.toString(), vehiclePlate, service: job.service, reason, stoppedAt: now,
          stoppedBy: 'lobby_display', allocatedMins: job.allocatedMins,
          staffId: job.staffId?.toString() || null, branch: job.branch, date: job.date,
        });

        // ── Sync booking status ──────────────────────────────────────────────
        await syncJobStatusToBooking(db, job, 'done');

        stoppedJobs.push({ jobId: jid.toString(), service: job.service, reason });
      }

      return res.status(200).json({ ok: true, message: `Job stopped for ${vehiclePlate} with reason: ${reason}`, stoppedJobs });
    }

    // ── FORCE SYNC ───────────────────────────────────────────────────────────
    if (resource === 'sync') {
      if (req.method !== 'POST') return res.status(405).end();
      if (!branch || !date) return res.status(400).json({ error: 'branch and date required' });
      await syncBookingsToJobs(db, branch, date);
      const count = await jobsCol.countDocuments({ branch, date });
      return res.status(200).json({ ok: true, jobCount: count });
    }

    // ── DEBUG ────────────────────────────────────────────────────────────────
    if (resource === 'debug') {
      if (req.method !== 'GET') return res.status(405).end();
      const all = await db.collection('bookings').find({}).sort({ _id: -1 }).toArray();
      return res.status(200).json({
        db: getDbName(MONGODB_URI), total: all.length,
        bookings: all.map(b => ({
          bookingId: b.bookingId, date: b.date, createdAt: b.createdAt,
          branchName: b.branch?.name, status: b.status,
          services: b.services?.map(s => s.name), customer: b.customer?.name,
        })),
      });
    }

    // ── LOBBY ────────────────────────────────────────────────────────────────
    if (resource === 'lobby') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      if (!branch || !date)    return res.status(400).json({ error: 'branch and date required' });
      const now = new Date();

      const jobs = await jobsCol.aggregate([
        { $match: { branch, date, status: { $in: ['in_progress','paused','done','assigned'] } } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timer' } },
        { $lookup: { from: 'staff',      localField: 'staffId', foreignField: '_id', as: 'staff' } },
      ]).toArray();

      const byPlate = {};
      for (const job of jobs) {
        const plate = job.vehiclePlate || 'Unknown';
        if (!byPlate[plate]) {
          byPlate[plate] = { vehiclePlate: plate, customerName: job.customerName,
            timeSlot: job.timeSlot, services: [], overallStatus: 'assigned',
            remainingSecs: 0, isOvertime: false };
        }
        const timer = job.timer[0] || null;
        let remainingSecs = 0, isOvertime = false;
        if (timer?.startedAt && !timer.stoppedAt) {
          const elapsed = Math.floor((now - new Date(timer.startedAt)) / 1000);
          let paused = 0;
          for (const p of timer.pauseLogs || []) {
            const end = p.resumedAt ? new Date(p.resumedAt) : now;
            paused += Math.floor((end - new Date(p.pausedAt)) / 1000);
          }
          const active  = elapsed - paused;
          remainingSecs = Math.max(0, job.allocatedMins * 60 - active);
          isOvertime    = active > job.allocatedMins * 60;
        } else if (timer?.stoppedAt) {
          isOvertime = timer.isOvertime;
        } else {
          remainingSecs = job.allocatedMins * 60;
        }
        byPlate[plate].services.push({
          service: job.service, status: job.status,
          staffName: job.staff[0]?.name || null, remainingSecs,
          allocatedMins: job.allocatedMins, isOvertime,
        });
        byPlate[plate].remainingSecs += remainingSecs;
        if (isOvertime) byPlate[plate].isOvertime = true;
        if (job.status === 'in_progress') byPlate[plate].overallStatus = 'in_progress';
        else if (job.status === 'paused' && byPlate[plate].overallStatus !== 'in_progress') byPlate[plate].overallStatus = 'paused';
        if (byPlate[plate].services.every(s => s.status === 'done')) byPlate[plate].overallStatus = 'done';
      }
      return res.status(200).json(Object.values(byPlate));
    }

    // ── STAFF PERFORMANCE (real-time from jobs) ──────────────────────────────
    if (resource === 'staff-performance') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
      if (!branch || !date)    return res.status(400).json({ error: 'branch and date required' });

      // Jobs for the day with timer data
      const jobs = await jobsCol.aggregate([
        { $match: { branch, date } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timerArr' } },
      ]).toArray();

      // Service price lookup for revenue calculation
      const pricesCol = db.collection('service_prices');
      const allPrices = await pricesCol.find({}).toArray();
      const priceMap  = {};
      allPrices.forEach(p => { priceMap[p.name.toLowerCase().trim()] = p.price || 0; });

      const staffMap = {};

      for (const job of jobs) {
        if (!job.staffId) continue;
        const sid   = job.staffId.toString();
        const timer = job.timerArr[0] || null;
        const now   = Date.now();

        if (!staffMap[sid]) {
          staffMap[sid] = {
            staffId:        sid,
            jobsCompleted:  0,
            jobsInProgress: 0,
            jobsPending:    0,
            jobsOverdue:    0,
            totalRevenue:   0,
            overtimeMins:   0,
            allocatedMins:  0,
            activeWorkMins: 0,
            pauseCount:     0,
            activeBay:      null,
            currentJob:     null,
          };
        }

        const s = staffMap[sid];

        // Track which bay this staff is currently active in
        if (job.bayNumber && ['in_progress', 'paused', 'assigned'].includes(job.status)) {
          s.activeBay = String(job.bayNumber);
        }

        s.allocatedMins += job.allocatedMins || 0;

        if (job.status === 'done') {
          s.jobsCompleted++;
          s.totalRevenue  += priceMap[(job.service || '').toLowerCase().trim()] || 0;
          if (timer) {
            const workMins = Math.round((timer.activeWorkSecs || 0) / 60);
            const otMins   = Math.round((timer.overtimeSecs   || 0) / 60);
            s.activeWorkMins += workMins;
            s.overtimeMins   += otMins;
            s.pauseCount     += (timer.pauseLogs || []).length;
            if (timer.isOvertime) s.jobsOverdue++;
          }
        } else if (job.status === 'in_progress' || job.status === 'paused') {
          s.jobsInProgress++;
          if (timer) {
            s.pauseCount += (timer.pauseLogs || []).length;
            // Live elapsed for current in-progress job
            const elapsedSecs = timer.startedAt
              ? Math.floor((now - new Date(timer.startedAt).getTime()) / 1000)
              : 0;
            let livePausedSecs = 0;
            for (const p of (timer.pauseLogs || [])) {
              if (p.resumedAt) livePausedSecs += Math.floor((new Date(p.resumedAt) - new Date(p.pausedAt)) / 1000);
              else livePausedSecs += Math.floor((now - new Date(p.pausedAt).getTime()) / 1000);
            }
            const liveWorkSecs     = Math.max(0, elapsedSecs - livePausedSecs);
            const allocatedSecs    = (job.allocatedMins || 30) * 60;
            const liveOverSecs     = Math.max(0, liveWorkSecs - allocatedSecs);
            const liveIsOvertime   = liveWorkSecs > allocatedSecs;

            // Set currentJob for bay map display
            if (!s.currentJob || job.status === 'in_progress') {
              s.currentJob = {
                service:       job.service || '',
                vehiclePlate:  job.vehiclePlate || '',
                allocatedMins: job.allocatedMins || 30,
                liveWorkMins:  Math.round(liveWorkSecs  / 60),
                liveOverMins:  Math.round(liveOverSecs  / 60),
                isOvertime:    liveIsOvertime,
                status:        job.status,
                bayNumber:     job.bayNumber || null,
              };
            }
          }
        } else if (job.status === 'assigned') {
          s.jobsPending++;
        }
      }

      const result = Object.values(staffMap).map((s) => ({
        ...s,
        efficiencyPct: s.allocatedMins > 0 && s.activeWorkMins > 0
          ? Math.round(Math.min((s.allocatedMins / s.activeWorkMins) * 100, 150))
          : null,
        onTimeRate: s.jobsCompleted > 0
          ? Math.round(((s.jobsCompleted - s.jobsOverdue) / s.jobsCompleted) * 100)
          : null,
      }));

      return res.status(200).json(result);
    }

    // ── BUSINESS ANALYTICS REPORTS ──────────────────────────────────────────
    if (resource === 'reports') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

      const { type, from, to } = req.query;
      const invoicesCol  = db.collection('invoices');
      const pricesCol    = db.collection('service_prices');
      const inventoryCol = db.collection('inventory');
      const staffCol     = db.collection('staff');

      // Branch filter
      const bFilter = branch && branch !== 'All' ? { branch } : {};

      // Date range helpers
      const dateFilter = (field) => {
        if (!from && !to) return {};
        const d = {};
        if (from) d.$gte = from;
        if (to)   d.$lte = to;
        return { [field]: d };
      };

      // ── type=overview: KPI totals ─────────────────────────────────────────
      if (type === 'overview') {
        const [invoices, allJobs] = await Promise.all([
          invoicesCol.find({ ...bFilter, ...dateFilter('invoiceDate') }).toArray(),
          jobsCol.find({ ...bFilter, ...dateFilter('date') }).toArray(),
        ]);
        const paidInvs     = invoices.filter(i => i.paymentStatus === 'Paid');
        const totalRevenue = paidInvs.reduce((a, i) => a + (i.total || 0), 0);
        const partsTotal   = invoices.reduce((a, i) => a + (i.partsTotal   || 0), 0);
        const labourTotal  = invoices.reduce((a, i) => a + (i.labourCharge || 0), 0);
        const discounts    = invoices.reduce((a, i) => a + (i.discountAmt  || 0), 0);
        const outstanding  = invoices.filter(i => i.paymentStatus !== 'Paid' && i.paymentStatus !== 'Void')
                              .reduce((a, i) => a + (i.balance || 0), 0);
        const completed    = allJobs.filter(j => j.status === 'done').length;
        const avgJobRev    = paidInvs.length > 0 ? Math.round(totalRevenue / paidInvs.length) : 0;
        const compRate     = allJobs.length > 0 ? Math.round((completed / allJobs.length) * 100) : 0;

        return res.status(200).json({
          revenue: { total: totalRevenue, parts: partsTotal, labour: labourTotal, discounts, outstanding, invoiceCount: invoices.length },
          jobs:    { total: allJobs.length, completed, completionRate: compRate, avgJobRevenue: avgJobRev },
        });
      }

      // ── type=revenue-trend: daily & monthly breakdown ─────────────────────
      if (type === 'revenue-trend') {
        const invoices = await invoicesCol.find({ ...bFilter, ...dateFilter('invoiceDate') }).toArray();
        const byDay = {};
        const byMonth = {};
        invoices.forEach(inv => {
          const day = inv.invoiceDate || '';
          const mo  = day.slice(0, 7); // YYYY-MM
          if (!day) return;

          if (!byDay[day])  byDay[day]  = { date: day,  revenue: 0, parts: 0, labour: 0, discounts: 0, count: 0 };
          if (!byMonth[mo]) byMonth[mo] = { month: mo,  revenue: 0, parts: 0, labour: 0, discounts: 0, count: 0 };

          const rev = inv.paymentStatus === 'Paid' ? (inv.total || 0) : 0;
          const p   = inv.partsTotal   || 0;
          const l   = inv.labourCharge || 0;
          const d   = inv.discountAmt  || 0;

          byDay[day].revenue   += rev; byDay[day].parts   += p; byDay[day].labour   += l; byDay[day].discounts += d; byDay[day].count++;
          byMonth[mo].revenue  += rev; byMonth[mo].parts  += p; byMonth[mo].labour  += l; byMonth[mo].discounts+= d; byMonth[mo].count++;
        });

        return res.status(200).json({
          daily:   Object.values(byDay).sort((a,b)  => a.date.localeCompare(b.date)),
          monthly: Object.values(byMonth).sort((a,b) => a.month.localeCompare(b.month)),
        });
      }

      // ── type=jobs-stats: services + technicians + daily ───────────────────
      if (type === 'jobs-stats') {
        const jobs = await jobsCol.aggregate([
          { $match: { ...bFilter, ...dateFilter('date') } },
          { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timerArr' } },
        ]).toArray();

        const serviceMap = {};
        const techMap    = {};
        const dailyMap   = {};

        for (const job of jobs) {
          const timer = job.timerArr?.[0] || null;
          const svc   = job.service || 'Other';
          const day   = job.date    || '';
          const done  = job.status === 'done';

          // ── service breakdown
          if (!serviceMap[svc]) serviceMap[svc] = { service: svc, total: 0, completed: 0, totalWorkMins: 0, allocatedMins: 0 };
          serviceMap[svc].total++;
          serviceMap[svc].allocatedMins += job.allocatedMins || 0;
          if (done) {
            serviceMap[svc].completed++;
            serviceMap[svc].totalWorkMins += timer ? Math.round((timer.activeWorkSecs || 0) / 60) : 0;
          }

          // ── technician breakdown
          if (job.staffId) {
            const sid = job.staffId.toString();
            if (!techMap[sid]) techMap[sid] = { staffId: sid, name: job.staffName || 'Unknown', total: 0, completed: 0, totalWorkMins: 0, overtimeMins: 0, pauseCount: 0 };
            techMap[sid].total++;
            if (done && timer) {
              techMap[sid].completed++;
              techMap[sid].totalWorkMins += Math.round((timer.activeWorkSecs || 0) / 60);
              techMap[sid].overtimeMins  += Math.round((timer.overtimeSecs   || 0) / 60);
              techMap[sid].pauseCount    += (timer.pauseLogs || []).length;
            }
          }

          // ── daily breakdown
          if (day) {
            if (!dailyMap[day]) dailyMap[day] = { date: day, total: 0, completed: 0, inProgress: 0, paused: 0 };
            dailyMap[day].total++;
            if (job.status === 'done')        dailyMap[day].completed++;
            if (job.status === 'in_progress') dailyMap[day].inProgress++;
            if (job.status === 'paused')      dailyMap[day].paused++;
          }
        }

        const services = Object.values(serviceMap).map(s => ({
          ...s,
          avgMins:      s.completed > 0 ? Math.round(s.totalWorkMins / s.completed) : 0,
          efficiencyPct:s.allocatedMins > 0 && s.totalWorkMins > 0 ? Math.round((s.allocatedMins / s.totalWorkMins) * 100) : null,
        })).sort((a,b) => b.total - a.total);

        const technicians = Object.values(techMap).map(t => ({
          ...t,
          avgJobMins:   t.completed > 0 ? Math.round(t.totalWorkMins / t.completed) : 0,
          completionPct:t.total > 0 ? Math.round((t.completed / t.total) * 100) : 0,
        })).sort((a,b) => b.completed - a.completed);

        const daily = Object.values(dailyMap).sort((a,b) => a.date.localeCompare(b.date));

        return res.status(200).json({ services, technicians, daily });
      }

      // ── type=inventory ────────────────────────────────────────────────────
      if (type === 'inventory') {
        const items = await inventoryCol.find(branch && branch !== 'All' ? { branch } : {}).toArray();

        let totalValue = 0, lowStock = 0, outOfStock = 0;
        const catMap = {};
        const topItems = [];

        items.forEach(item => {
          const qty   = Number(item.quantity) || 0;
          const price = Number(item.unitPrice || item.price || item.cost || 0);
          const value = qty * price;
          totalValue += value;
          if (qty === 0) outOfStock++;
          else if (qty < (item.minStock || 5)) lowStock++;

          const cat = item.category || 'Uncategorised';
          if (!catMap[cat]) catMap[cat] = { category: cat, items: 0, value: 0 };
          catMap[cat].items++;
          catMap[cat].value += value;

          topItems.push({
            name:     item.name || item.itemName || 'Unknown',
            category: cat,
            quantity: qty,
            unitPrice:price,
            value,
            status:   qty === 0 ? 'Out of Stock' : qty < (item.minStock || 5) ? 'Low Stock' : 'In Stock',
          });
        });

        topItems.sort((a,b) => b.value - a.value);

        return res.status(200).json({
          totalItems: items.length,
          totalValue,
          lowStock,
          outOfStock,
          categories: Object.values(catMap).sort((a,b) => b.value - a.value),
          topItems:   topItems.slice(0, 15),
        });
      }

      // ── type=service-prices ───────────────────────────────────────────────
      if (type === 'service-prices') {
        const prices = await pricesCol.find({}).toArray();
        return res.status(200).json(prices.map(p => ({ name: p.name, code: p.code, price: p.price, duration: p.duration })));
      }

      return res.status(400).json({ error: 'Unknown report type. Use: overview | revenue-trend | jobs-stats | inventory | service-prices' });
    }

    // ── REPORT ───────────────────────────────────────────────────────────────
    if (resource === 'report') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      if (!branch || !date)    return res.status(400).json({ error: 'branch and date required' });

      const jobs = await jobsCol.aggregate([
        { $match: { branch, date, status: 'done' } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timer' } },
        { $lookup: { from: 'staff',      localField: 'staffId', foreignField: '_id', as: 'staff' } },
      ]).toArray();

      const staffMap = {};
      for (const job of jobs) {
        const timer  = job.timer[0];
        const member = job.staff[0];
        if (!timer || !member) continue;
        const sid = member._id.toString();
        if (!staffMap[sid]) staffMap[sid] = {
          staffId: sid, name: member.name, role: member.role,
          totalJobs: 0, completedJobs: 0,
          allocatedMins: 0, activeWorkMins: 0, overtimeMins: 0, pauseMins: 0, jobs: [],
        };
        const s = staffMap[sid];
        s.totalJobs++; s.completedJobs++;
        s.allocatedMins  += job.allocatedMins || 0;
        s.activeWorkMins += Math.round((timer.activeWorkSecs  || 0) / 60);
        s.overtimeMins   += Math.round((timer.overtimeSecs    || 0) / 60);
        s.pauseMins      += Math.round((timer.totalPausedSecs || 0) / 60);
        s.jobs.push({
          service: job.service, vehiclePlate: job.vehiclePlate, bookingRef: job.bookingRef,
          allocatedMins: job.allocatedMins,
          activeWorkMins: Math.round((timer.activeWorkSecs || 0) / 60),
          overtimeMins:   Math.round((timer.overtimeSecs   || 0) / 60),
          isOvertime: timer.isOvertime, pauseLogs: timer.pauseLogs || [],
        });
      }
      const report = Object.values(staffMap).map(s => ({
        ...s,
        efficiencyPct: s.allocatedMins > 0 ? Math.round((s.allocatedMins / Math.max(s.activeWorkMins, 1)) * 100) : 0,
        overtimeFlag: s.overtimeMins > 0,
      })).sort((a, b) => b.overtimeMins - a.overtimeMins);

      return res.status(200).json({
        branch, date, generatedAt: new Date(),
        totalJobsDone: jobs.length, totalStaffWorked: report.length, staff: report,
      });
    }

    // ── TIMER ────────────────────────────────────────────────────────────────
    if (resource === 'timer') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { jobId, staffId, action, reason, supervisorId } = req.body;
      if (!jobId || !action) return res.status(400).json({ error: 'jobId and action required' });
      let jid;
      try { jid = new ObjectId(jobId); } catch { return res.status(400).json({ error: 'Invalid jobId' }); }
      const now = new Date();

      if (action === 'start') {
        const existing = await timersCol.findOne({ jobId: jid });
        if (existing) return res.status(409).json({ error: 'Timer already exists' });
        let sid = null;
        if (staffId) { try { sid = new ObjectId(staffId); } catch {} }
        await timersCol.insertOne({
          jobId: jid, staffId: sid, startedAt: now, stoppedAt: null,
          pauseLogs: [], totalElapsedSecs: 0, totalPausedSecs: 0, activeWorkSecs: 0,
          isOvertime: false, overtimeSecs: 0,
          supervisorApproved: false, approvedBy: null, approvedAt: null,
        });
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'in_progress', updatedAt: now } });

        // ── Sync booking to "In Progress" ────────────────────────────────────
        const startedJob = await jobsCol.findOne({ _id: jid });
        await syncJobStatusToBooking(db, startedJob, 'in_progress');

        return res.status(200).json({ ok: true, startedAt: now });
      }

      if (action === 'pause') {
        if (!reason) return res.status(400).json({ error: 'reason required' });
        const timer = await timersCol.findOne({ jobId: jid });
        if (!timer) return res.status(404).json({ error: 'Timer not found' });
        if (timer.pauseLogs.find(p => !p.resumedAt)) return res.status(409).json({ error: 'Already paused' });
        await timersCol.updateOne({ jobId: jid },
          { $push: { pauseLogs: { reason, pausedAt: now, resumedAt: null, approvedBy: null } } });
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'paused', updatedAt: now } });
        return res.status(200).json({ ok: true });
      }

      if (action === 'approve_resume') {
        let supId = null;
        if (supervisorId) { try { supId = new ObjectId(supervisorId); } catch {} }
        await timersCol.updateOne(
          { jobId: jid, 'pauseLogs.resumedAt': null },
          { $set: { 'pauseLogs.$.resumedAt': now, 'pauseLogs.$.approvedBy': supId,
              supervisorApproved: true, approvedBy: supId, approvedAt: now } });
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'in_progress', updatedAt: now } });
        return res.status(200).json({ ok: true });
      }

      if (action === 'stop') {
        const timer = await timersCol.findOne({ jobId: jid });
        if (!timer) return res.status(404).json({ error: 'Timer not found' });
        const job   = await jobsCol.findOne({ _id: jid });
        const totalElapsedSecs = Math.floor((now - new Date(timer.startedAt)) / 1000);
        let totalPausedSecs = 0;
        for (const p of timer.pauseLogs) {
          if (p.resumedAt) totalPausedSecs += Math.floor((new Date(p.resumedAt) - new Date(p.pausedAt)) / 1000);
        }
        const activeWorkSecs = totalElapsedSecs - totalPausedSecs;
        const allocatedSecs  = (job?.allocatedMins || 30) * 60;
        const isOvertime     = activeWorkSecs > allocatedSecs;
        const overtimeSecs   = isOvertime ? activeWorkSecs - allocatedSecs : 0;
        await timersCol.updateOne({ jobId: jid },
          { $set: { stoppedAt: now, totalElapsedSecs, totalPausedSecs, activeWorkSecs, isOvertime, overtimeSecs } });
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'done', updatedAt: now } });

        // ── Sync booking to Completed / In Progress ──────────────────────────
        await syncJobStatusToBooking(db, job, 'done');

        if (job?.chainedToJob) {
          await jobsCol.updateOne({ _id: job.chainedToJob }, { $set: { status: 'assigned', updatedAt: now } });
        }
        return res.status(200).json({ ok: true, activeWorkSecs, isOvertime, overtimeSecs });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    // ── ASSIGN ───────────────────────────────────────────────────────────────
    if (resource === 'assign') {
      if (!id) return res.status(400).json({ error: 'id required' });
      let jobId;
      try { jobId = new ObjectId(id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

      if (req.method === 'DELETE') {
        await jobsCol.deleteOne({ _id: jobId });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'PATCH') {
        const { action, staffId, bayNumber, status, nextJobId, extraMins } = req.body;
        const now = new Date();

        if (action === 'assign_staff') {
          let sid;
          try { sid = new ObjectId(staffId); } catch { return res.status(400).json({ error: 'Invalid staffId' }); }
          await jobsCol.updateOne({ _id: jobId }, { $set: { staffId: sid, status: 'assigned', updatedAt: now } });
          // Note: 'assigned' doesn't change booking status — booking stays Pending until timer starts
        } else if (action === 'add_time') {
          if (!extraMins || extraMins <= 0) return res.status(400).json({ error: 'extraMins must be positive' });
          await jobsCol.updateOne({ _id: jobId }, { $inc: { allocatedMins: extraMins }, $set: { updatedAt: now } });
        } else if (action === 'assign_bay') {
          await jobsCol.updateOne({ _id: jobId }, { $set: { bayNumber: bayNumber ?? null, updatedAt: now } });
          // Keep staff_day_status in sync so Staff Management bay map reflects this assignment
          const assignedJob = await jobsCol.findOne({ _id: jobId });
          if (assignedJob?.staffId && assignedJob?.branch && assignedJob?.date) {
            const statusCol = db.collection('staff_day_status');
            await statusCol.updateOne(
              { staffId: assignedJob.staffId, branch: assignedJob.branch, date: assignedJob.date },
              { $set: { bayNumber: bayNumber ?? null } },
              { upsert: true },
            );
          }
        } else if (action === 'unassign') {
          await jobsCol.updateOne({ _id: jobId }, { $set: { staffId: null, bayNumber: null, status: 'unassigned', updatedAt: now } });
        } else if (action === 'chain_next') {
          let nid;
          try { nid = new ObjectId(nextJobId); } catch { return res.status(400).json({ error: 'Invalid nextJobId' }); }
          await jobsCol.updateOne({ _id: jobId }, { $set: { chainedToJob: nid, updatedAt: now } });
          await jobsCol.updateOne({ _id: nid },   { $set: { chainedFromJob: jobId, updatedAt: now } });
        } else if (action === 'set_status' && status) {
          await jobsCol.updateOne({ _id: jobId }, { $set: { status, updatedAt: now } });
        } else if (action === 'unchain') {
          const job = await jobsCol.findOne({ _id: jobId });
          if (job?.chainedToJob)   await jobsCol.updateOne({ _id: job.chainedToJob },   { $set: { chainedFromJob: null, updatedAt: now } });
          if (job?.chainedFromJob) await jobsCol.updateOne({ _id: job.chainedFromJob }, { $set: { chainedToJob: null,   updatedAt: now } });
          await jobsCol.updateOne({ _id: jobId }, { $set: { chainedToJob: null, chainedFromJob: null, updatedAt: now } });
        } else {
          return res.status(400).json({ error: 'Unknown action' });
        }
        return res.status(200).json({ ok: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ── GET JOB LIST ─────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      if (!branch || !date) return res.status(400).json({ error: 'branch and date required' });
      await syncBookingsToJobs(db, branch, date);
      const allJobs = await jobsCol.aggregate([
        { $match: { branch, date } },
        { $lookup: { from: 'staff',      localField: 'staffId', foreignField: '_id', as: 'staffInfo' } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId',   as: 'timerInfo' } },
        { $sort:  { timeSlot: 1, order: 1, createdAt: 1 } },
      ]).toArray();
      return res.status(200).json(allJobs.map(j => ({
        ...j,
        staffName: j.staffInfo[0]?.name || null,
        timer:     j.timerInfo[0]       || null,
        staffInfo: undefined,
        timerInfo: undefined,
      })));
    }

    // ── CREATE MANUAL JOB ─────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { branch: b, date: d, vehiclePlate, customerName, customerPhone, service, timeSlot } = req.body;
      if (!b || !d || !service) return res.status(400).json({ error: 'branch, date, service required' });
      const result = await jobsCol.insertOne({
        bookingId: null, bookingRef: null, branch: b, date: d,
        timeSlot: timeSlot || '', vehiclePlate: vehiclePlate || '',
        customerName: customerName || '', customerPhone: customerPhone || '',
        service, allocatedMins: getAllocatedMins(service),
        staffId: null, bayNumber: null, status: 'unassigned',
        chainedFromJob: null, chainedToJob: null, order: 0,
        source: 'manual', createdAt: new Date(), updatedAt: new Date(),
      });
      return res.status(201).json({ id: result.insertedId });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('jobs.js error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};