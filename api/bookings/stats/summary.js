import { connectToDatabase } from "../../../lib/mongodb.js";
import Booking from "../../../models/Booking.js";

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    await connectToDatabase();

    const [total, pending, inProgress, completed, cancelled] = await Promise.all([
      Booking.countDocuments(),
      Booking.countDocuments({ status: 'Pending' }),
      Booking.countDocuments({ status: 'In Progress' }),
      Booking.countDocuments({ status: 'Completed' }),
      Booking.countDocuments({ status: 'Cancelled' })
    ]);

    return res.status(200).json({
      success: true,
      stats: { total, pending, inProgress, completed, cancelled }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch statistics', 
      error: error.message 
    });
  }
}