import { connectToDatabase } from "../lib/mongodb.js";
import Booking from "../models/Booking.js";

function generateBookingId() {
  const timestamp = Date.now().toString().slice(-4);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `BK-${random}${timestamp}`.slice(0, 10);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  await connectToDatabase();

  if (req.method === 'GET') {
    try {
      const { status, search, limit = 50 } = req.query;
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

      const bookings = await Booking.find(query)
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      return res.status(200).json({
        success: true,
        count: bookings.length,
        bookings: bookings.map(b => ({
          id: b.bookingId,
          date: b.date.toISOString().split('T')[0],
          customer: b.customer.name,
          vehicle: b.customer.vehicleNo || 'N/A',
          service: b.services.map(s => s.name).join(', '),
          status: b.status,
          amount: b.amount,
          email: b.customer.email,
          phone: b.customer.phone,
          branch: b.branch.name,
          timeSlot: b.timeSlot,
          fullData: b
        }))
      });
    } catch (error) {
      console.error('Error fetching bookings:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch bookings', 
        error: error.message 
      });
    }
  }

  if (req.method === 'POST') {
    try {
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
    } catch (error) {
      console.error('Error creating booking:', error);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to create booking', 
        error: error.message 
      });
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}