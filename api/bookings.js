import { connectToDatabase } from "../lib/mongodb.js";
import Booking from "../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../lib/cors.js";

function generateBookingId() {
  const timestamp = Date.now().toString().slice(-4);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `BK-${random}${timestamp}`.slice(0, 10);
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);

  if (handleOptionsRequest(req, res)) return;

  try {
    await connectToDatabase();

    if (req.method === 'GET') {
      const { status, search, date, limit = 50 } = req.query;
      let query = {};

      if (status && status !== 'all') {
        query.status = status;
      }

      if (search) {
        query.$or = [
          { bookingId: { $regex: search, $options: 'i' } },
          { 'customer.name': { $regex: search, $options: 'i' } },
          { 'customer.email': { $regex: search, $options: 'i' } }
        ];
      }

      //  Date filter support
      if (date) {
        // Sri Lanka is UTC+5:30 — midnight LK = 18:30 previous day UTC
        // So search from 18:30 day-before to 18:30 on the date (full local day)
        const start = new Date(`${date}T00:00:00.000Z`);
        start.setMinutes(start.getMinutes() - 330); // subtract 5h30m → 18:30 prev day UTC
        const end = new Date(`${date}T23:59:59.999Z`);
        end.setMinutes(end.getMinutes() - 330);     // subtract 5h30m → 18:29 same day UTC
        query.date = { $gte: start, $lte: end };
      }

      const bookings = await Booking.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      return res.status(200).json({
        success: true,
        count: bookings.length,
        bookings: bookings.map(b => ({
          id: b.bookingId,          // ✅ always the BK-XXXX string, no fullData
          date: b.date ? (() => { const d = new Date(b.date); d.setMinutes(d.getMinutes() + 330); return d.toISOString().split('T')[0]; })() : '',
          customer: b.customer?.name || '',
          vehicle: b.customer?.vehicleNo || 'N/A',
          service: b.services?.map(s => s.name).join(', ') || '',
          status: b.status,
          amount: b.amount,
          email: b.customer?.email || '',
          phone: b.customer?.phone || '',
          branch: b.branch?.name || '',
          timeSlot: b.timeSlot || '',
        }))
      });
    }

    if (req.method === 'POST') {
      const bookingId = generateBookingId();
      const booking = new Booking({
        bookingId,
        ...req.body,
        status: 'Pending'
      });
      await booking.save();

      console.log('📧 Booking Created:', bookingId);

      return res.status(201).json({
        success: true,
        message: 'Booking created successfully',
        booking: {
          bookingId: booking.bookingId,
          customer: booking.customer,
          date: booking.date,
          timeSlot: booking.timeSlot,
          branch: booking.branch
        }
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
}