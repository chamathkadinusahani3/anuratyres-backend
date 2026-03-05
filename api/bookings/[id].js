import { connectToDatabase } from "../../lib/mongodb.js";
import Booking from "../../models/Booking.js";
import { setCorsHeaders, handleOptionsRequest } from "../../lib/cors.js";

export default async function handler(req, res) {
  const { id } = req.query;

  setCorsHeaders(res);
  
  if (handleOptionsRequest(req, res)) return;

  try {
    await connectToDatabase();

    if (req.method === 'GET') {
      const booking = await Booking.findOne({ bookingId: id });
      if (!booking) {
        return res.status(404).json({ 
          success: false, 
          message: 'Booking not found' 
        });
      }
      return res.status(200).json({ success: true, booking });
    }

    if (req.method === 'PATCH') {
      const { status } = req.body;
      
      if (status && !['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(status)) {
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid status' 
        });
      }

      const booking = await Booking.findOneAndUpdate(
        { bookingId: id },
        { status, updatedAt: new Date() },
        { new: true }
      );
      
      if (!booking) {
        return res.status(404).json({ 
          success: false, 
          message: 'Booking not found' 
        });
      }
      return res.status(200).json({ 
        success: true, 
        message: 'Booking status updated', 
        booking 
      });
    }

    if (req.method === 'DELETE') {
      const booking = await Booking.findOneAndDelete({ bookingId: id });
      if (!booking) {
        return res.status(404).json({ 
          success: false, 
          message: 'Booking not found' 
        });
      }
      return res.status(200).json({ 
        success: true, 
        message: 'Booking deleted successfully' 
      });
    }

    res.setHeader('Allow', ['GET', 'PATCH', 'DELETE']);
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