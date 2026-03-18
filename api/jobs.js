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
const { setCorsHeaders } = require('./cors');

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
let cachedClient = null;
async function getDb() {
  if (!cachedClient) cachedClient = await MongoClient.connect(MONGODB_URI);
  return cachedClient.db('anura-tyres');
}

// ─── Pull today's bookings → job_assignments ──────────────────────────────────
// Bookings schema: { branch: { name }, date: Date, services: [{name}],
//                   customer: { name, vehicleNo }, status, timeSlot }
async function syncBookingsToJobs(db, branch, dateStr) {
  const jobsCol = db.collection('job_assignments');

  // Build date range for the full day (bookings store date as Date object)
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const dayEnd   = new Date(`${dateStr}T23:59:59.999Z`);

  // Query bookings for this branch and date
  // Exclude Cancelled and Completed — only actionable ones
  const bookings = await db.collection('bookings').find({
    'branch.name': branch,
    date: { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['Cancelled', 'Completed'] },
  }).toArray();

  for (const booking of bookings) {
    const bookingIdStr = booking._id.toString();

    // Each service in the booking becomes a separate job card
    const services = Array.isArray(booking.services)
      ? booking.services.map(s => (typeof s === 'string' ? s : s.name)).filter(Boolean)
      : [booking.services || 'General Service'];

    for (const serviceName of services) {
      // Only create if not already in job_assignments
      const exists = await jobsCol.findOne({
        bookingId: bookingIdStr,
        service:   serviceName,
      });

      if (!exists) {
        await jobsCol.insertOne({
          bookingId:    bookingIdStr,
          bookingRef:   booking.bookingId || '',   // human-readable BK-XXXX
          branch,
          date:         dateStr,
          timeSlot:     booking.timeSlot  || '',
          vehiclePlate: booking.customer?.vehicleNo || '',
          customerName: booking.customer?.name      || '',
          customerPhone:booking.customer?.phone     || '',
          service:      serviceName,
          allocatedMins:getAllocatedMins(serviceName),
          staffId:      null,
          bayNumber:    null,
          status:       'unassigned',
          chainedFromJob: null,
          chainedToJob:   null,
          order:          0,
          source:         'website',             // 'website' or 'manual'
          createdAt:      new Date(),
          updatedAt:      new Date(),
        });
      }
    }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const db        = await getDb();
    const jobsCol   = db.collection('job_assignments');
    const timersCol = db.collection('job_timers');
    const { resource, id, branch, date } = req.query;

    // ══════════════════════════════════════════════════════════════════════
    // LOBBY — GET ?resource=lobby&branch=X&date=Y
    // ══════════════════════════════════════════════════════════════════════
    if (resource === 'lobby') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      if (!branch || !date)    return res.status(400).json({ error: 'branch and date required' });
      const now = new Date();

      const jobs = await jobsCol.aggregate([
        { $match: { branch, date, status: { $in: ['in_progress', 'paused', 'done', 'assigned'] } } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId', as: 'timer' } },
        { $lookup: { from: 'staff',      localField: 'staffId', foreignField: '_id', as: 'staff' } },
      ]).toArray();

      const byPlate = {};
      for (const job of jobs) {
        const plate = job.vehiclePlate || 'Unknown';
        if (!byPlate[plate]) {
          byPlate[plate] = {
            vehiclePlate:  plate,
            customerName:  job.customerName,
            timeSlot:      job.timeSlot,
            services:      [],
            overallStatus: 'assigned',
            remainingSecs: 0,
            isOvertime:    false,
          };
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
          const active = elapsed - paused;
          remainingSecs = Math.max(0, job.allocatedMins * 60 - active);
          isOvertime    = active > job.allocatedMins * 60;
        } else if (timer?.stoppedAt) {
          isOvertime = timer.isOvertime;
        } else {
          remainingSecs = job.allocatedMins * 60;
        }

        byPlate[plate].services.push({
          service:      job.service,
          status:       job.status,
          staffName:    job.staff[0]?.name || null,
          remainingSecs,
          allocatedMins:job.allocatedMins,
          isOvertime,
        });

        byPlate[plate].remainingSecs += remainingSecs;
        if (isOvertime) byPlate[plate].isOvertime = true;
        if (job.status === 'in_progress') byPlate[plate].overallStatus = 'in_progress';
        else if (job.status === 'paused' && byPlate[plate].overallStatus !== 'in_progress') {
          byPlate[plate].overallStatus = 'paused';
        }
        if (byPlate[plate].services.every(s => s.status === 'done')) {
          byPlate[plate].overallStatus = 'done';
        }
      }
      return res.status(200).json(Object.values(byPlate));
    }

    // ══════════════════════════════════════════════════════════════════════
    // REPORT — GET ?resource=report&branch=X&date=Y
    // ══════════════════════════════════════════════════════════════════════
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
        if (!staffMap[sid]) {
          staffMap[sid] = {
            staffId: sid, name: member.name, role: member.role,
            totalJobs: 0, completedJobs: 0,
            allocatedMins: 0, activeWorkMins: 0, overtimeMins: 0, pauseMins: 0,
            jobs: [],
          };
        }

        const s = staffMap[sid];
        s.totalJobs++;
        s.completedJobs++;
        s.allocatedMins  += job.allocatedMins || 0;
        s.activeWorkMins += Math.round((timer.activeWorkSecs  || 0) / 60);
        s.overtimeMins   += Math.round((timer.overtimeSecs    || 0) / 60);
        s.pauseMins      += Math.round((timer.totalPausedSecs || 0) / 60);
        s.jobs.push({
          jobId:         job._id,
          service:       job.service,
          vehiclePlate:  job.vehiclePlate,
          bookingRef:    job.bookingRef,
          allocatedMins: job.allocatedMins,
          activeWorkMins:Math.round((timer.activeWorkSecs  || 0) / 60),
          overtimeMins:  Math.round((timer.overtimeSecs    || 0) / 60),
          isOvertime:    timer.isOvertime,
          pauseLogs:     timer.pauseLogs || [],
        });
      }

      const report = Object.values(staffMap).map(s => ({
        ...s,
        efficiencyPct: s.allocatedMins > 0
          ? Math.round((s.allocatedMins / Math.max(s.activeWorkMins, 1)) * 100)
          : 0,
        overtimeFlag: s.overtimeMins > 0,
      })).sort((a, b) => b.overtimeMins - a.overtimeMins);

      return res.status(200).json({
        branch, date,
        generatedAt:      new Date(),
        totalJobsDone:    jobs.length,
        totalStaffWorked: report.length,
        staff:            report,
      });
    }

    // ══════════════════════════════════════════════════════════════════════
    // TIMER — POST ?resource=timer
    // ══════════════════════════════════════════════════════════════════════
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
          jobId: jid, staffId: sid,
          startedAt: now, stoppedAt: null,
          pauseLogs: [],
          totalElapsedSecs: 0, totalPausedSecs: 0, activeWorkSecs: 0,
          isOvertime: false, overtimeSecs: 0,
          supervisorApproved: false, approvedBy: null, approvedAt: null,
        });
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'in_progress', updatedAt: now } });
        return res.status(200).json({ ok: true, startedAt: now });
      }

      if (action === 'pause') {
        if (!reason) return res.status(400).json({ error: 'reason required' });
        const timer = await timersCol.findOne({ jobId: jid });
        if (!timer) return res.status(404).json({ error: 'Timer not found' });
        if (timer.pauseLogs.find(p => !p.resumedAt)) return res.status(409).json({ error: 'Already paused' });
        await timersCol.updateOne(
          { jobId: jid },
          { $push: { pauseLogs: { reason, pausedAt: now, resumedAt: null, approvedBy: null } } }
        );
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'paused', updatedAt: now } });
        return res.status(200).json({ ok: true });
      }

      if (action === 'approve_resume') {
        let supId = null;
        if (supervisorId) { try { supId = new ObjectId(supervisorId); } catch {} }
        await timersCol.updateOne(
          { jobId: jid, 'pauseLogs.resumedAt': null },
          { $set: {
            'pauseLogs.$.resumedAt':  now,
            'pauseLogs.$.approvedBy': supId,
            supervisorApproved: true, approvedBy: supId, approvedAt: now,
          }}
        );
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'in_progress', updatedAt: now } });
        return res.status(200).json({ ok: true });
      }

      if (action === 'stop') {
        const timer = await timersCol.findOne({ jobId: jid });
        if (!timer) return res.status(404).json({ error: 'Timer not found' });
        const job = await jobsCol.findOne({ _id: jid });

        const totalElapsedSecs = Math.floor((now - new Date(timer.startedAt)) / 1000);
        let totalPausedSecs = 0;
        for (const p of timer.pauseLogs) {
          if (p.resumedAt) totalPausedSecs += Math.floor((new Date(p.resumedAt) - new Date(p.pausedAt)) / 1000);
        }
        const activeWorkSecs = totalElapsedSecs - totalPausedSecs;
        const allocatedSecs  = (job?.allocatedMins || 30) * 60;
        const isOvertime     = activeWorkSecs > allocatedSecs;
        const overtimeSecs   = isOvertime ? activeWorkSecs - allocatedSecs : 0;

        await timersCol.updateOne(
          { jobId: jid },
          { $set: { stoppedAt: now, totalElapsedSecs, totalPausedSecs, activeWorkSecs, isOvertime, overtimeSecs } }
        );
        await jobsCol.updateOne({ _id: jid }, { $set: { status: 'done', updatedAt: now } });

        // Auto-activate next chained job
        if (job?.chainedToJob) {
          await jobsCol.updateOne(
            { _id: job.chainedToJob },
            { $set: { status: 'assigned', updatedAt: now } }
          );
        }
        return res.status(200).json({ ok: true, activeWorkSecs, isOvertime, overtimeSecs });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    // ══════════════════════════════════════════════════════════════════════
    // ASSIGN — PATCH/DELETE ?resource=assign&id=X
    // ══════════════════════════════════════════════════════════════════════
    if (resource === 'assign') {
      if (!id) return res.status(400).json({ error: 'id required' });
      let jobId;
      try { jobId = new ObjectId(id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

      if (req.method === 'DELETE') {
        await jobsCol.deleteOne({ _id: jobId });
        return res.status(200).json({ ok: true });
      }

      if (req.method === 'PATCH') {
        const { action, staffId, bayNumber, status, nextJobId } = req.body;
        const now = new Date();

        if (action === 'assign_staff') {
          let sid;
          try { sid = new ObjectId(staffId); } catch { return res.status(400).json({ error: 'Invalid staffId' }); }
          await jobsCol.updateOne({ _id: jobId }, { $set: { staffId: sid, status: 'assigned', updatedAt: now } });

        } else if (action === 'assign_bay') {
          await jobsCol.updateOne({ _id: jobId }, { $set: { bayNumber: bayNumber ?? null, updatedAt: now } });

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
          // Remove this job's chainedToJob link, and clear the next job's chainedFromJob
          const job = await jobsCol.findOne({ _id: jobId });
          if (job?.chainedToJob) {
            await jobsCol.updateOne({ _id: job.chainedToJob }, { $set: { chainedFromJob: null, updatedAt: now } });
          }
          if (job?.chainedFromJob) {
            await jobsCol.updateOne({ _id: job.chainedFromJob }, { $set: { chainedToJob: null, updatedAt: now } });
          }
          await jobsCol.updateOne({ _id: jobId }, {
            $set: { chainedToJob: null, chainedFromJob: null, updatedAt: now },
          });

        } else {
          return res.status(400).json({ error: 'Unknown action' });
        }

        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ══════════════════════════════════════════════════════════════════════
    // JOB LIST — GET ?branch=X&date=YYYY-MM-DD
    // ══════════════════════════════════════════════════════════════════════
    if (req.method === 'GET') {
      if (!branch || !date) return res.status(400).json({ error: 'branch and date required' });

      // Pull today's website bookings into job_assignments (idempotent)
      await syncBookingsToJobs(db, branch, date);

      // Return all jobs for this branch+date with staff + timer info joined
      const allJobs = await jobsCol.aggregate([
        { $match: { branch, date } },
        { $lookup: { from: 'staff',      localField: 'staffId', foreignField: '_id', as: 'staffInfo' } },
        { $lookup: { from: 'job_timers', localField: '_id', foreignField: 'jobId',   as: 'timerInfo' } },
        { $sort: { timeSlot: 1, order: 1, createdAt: 1 } },
      ]).toArray();

      return res.status(200).json(allJobs.map(j => ({
        ...j,
        staffName: j.staffInfo[0]?.name || null,
        timer:     j.timerInfo[0]       || null,
        staffInfo: undefined,
        timerInfo: undefined,
      })));
    }

    // ══════════════════════════════════════════════════════════════════════
    // CREATE MANUAL JOB — POST
    // ══════════════════════════════════════════════════════════════════════
    if (req.method === 'POST') {
      const { branch: b, date: d, vehiclePlate, customerName, customerPhone, service, timeSlot } = req.body;
      if (!b || !d || !service) return res.status(400).json({ error: 'branch, date, service required' });

      const result = await jobsCol.insertOne({
        bookingId:     null,
        bookingRef:    null,
        branch:        b,
        date:          d,
        timeSlot:      timeSlot || '',
        vehiclePlate:  vehiclePlate  || '',
        customerName:  customerName  || '',
        customerPhone: customerPhone || '',
        service,
        allocatedMins: getAllocatedMins(service),
        staffId:       null,
        bayNumber:     null,
        status:        'unassigned',
        chainedFromJob:null,
        chainedToJob:  null,
        order:         0,
        source:        'manual',
        createdAt:     new Date(),
        updatedAt:     new Date(),
      });
      return res.status(201).json({ id: result.insertedId });
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('jobs.js error:', err);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};