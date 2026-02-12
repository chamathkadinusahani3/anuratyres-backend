import { connectToDatabase } from "../../../lib/mongodb";
import Booking from "../../../models/Booking";

export default async function handler(req, res) {
  const { id } = req.query;
  const { method } = req;

  await connectToDatabase(process.env.MONGODB_URI);

  const booking = await Booking.findOne({ bookingId: id });
  if (!booking) return res.status(404).json({ message: "Booking not found" });

  if (method === "GET") return res.status(200).json(booking);

  if (method === "PATCH") {
    const { status } = req.body;
    if (status) booking.status = status;
    booking.updatedAt = new Date();
    await booking.save();
    return res.status(200).json(booking);
  }

  if (method === "DELETE") {
    await booking.remove();
    return res.status(200).json({ message: "Booking deleted" });
  }

  res.setHeader("Allow", ["GET", "PATCH", "DELETE"]);
  res.status(405).end(`Method ${method} Not Allowed`);
}