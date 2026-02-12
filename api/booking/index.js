import { connectToDatabase } from "../../../lib/mongodb";
import Booking from "../../../models/Booking";

function generateBookingId() {
  const timestamp = Date.now().toString().slice(-4);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `BK-${random}${timestamp}`.slice(0, 10);
}

export default async function handler(req, res) {
  const { method } = req;

  await connectToDatabase(process.env.MONGODB_URI);

  if (method === "GET") {
    const bookings = await Booking.find().sort({ createdAt: -1 }).limit(50);
    return res.status(200).json(bookings);
  }

  if (method === "POST") {
    const bookingId = generateBookingId();
    const booking = new Booking({ bookingId, ...req.body });
    await booking.save();
    return res.status(201).json({ success: true, booking });
  }

  res.setHeader("Allow", ["GET", "POST"]);
  res.status(405).end(`Method ${method} Not Allowed`);
}