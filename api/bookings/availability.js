// api/bookings/availability.js
// GET /api/bookings/availability?branch=Pannipitiya Branch&date=2025-03-25
// Returns which time slots are full for a given branch + date

import { connectToDatabase } from "../../lib/mongodb.js";
import Booking from "../../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../../lib/cors.js";

// Must match exactly what the frontend sends as branch name
const BRANCH_CAPACITY = {
  'Pannipitiya Branch': 3,
  'Ratnapura Branch':   2,
  'Kalawana Branch':    2,
  'Nivithigala Branch': 2,
};

const ALL_TIME_SLOTS = [
  '08:30','09:00','09:30','10:00','10:30','11:00','11:30','12:00',
  '13:00','13:30','14:00','14:30','15:00','15:30','16:00','16:30',
  '17:00','17:30','18:00','18:30','19:00',
];

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handleOptionsRequest(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { branch, date } = req.query;

  if (!branch || !date) {
    return res.status(400).json({
      success: false,
      message: 'branch and date query params are required',
    });
  }

  try {
    await connectToDatabase();

    const capacity = BRANCH_CAPACITY[branch] ?? 2;

    // Find all active bookings for this branch + date
    // Exclude cancelled bookings — they free up the slot
    const bookings = await Booking.find({
      'branch.name': branch,
      date: {
        // Match the full day regardless of time component
        $gte: new Date(`${date}T00:00:00.000Z`),
        $lte: new Date(`${date}T23:59:59.999Z`),
      },
      status: { $nin: ['Cancelled'] },
    }).select('timeSlot status');

    console.log(`[availability] branch="${branch}" date="${date}" found ${bookings.length} bookings`);

    // Count bookings per time slot
    const slotCounts = {};
    for (const b of bookings) {
      if (b.timeSlot) {
        slotCounts[b.timeSlot] = (slotCounts[b.timeSlot] || 0) + 1;
      }
    }

    // Build slot availability map
    const slots = ALL_TIME_SLOTS.map(time => ({
      time,
      booked:    slotCounts[time] || 0,
      capacity,
      available: (slotCounts[time] || 0) < capacity,
    }));

    return res.status(200).json({
      success: true,
      branch,
      date,
      capacity,
      slots,
    });

  } catch (error) {
    console.error('[availability] error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
}