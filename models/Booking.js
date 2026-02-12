import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema({
  bookingId: { type: String, unique: true, required: true },
  branch: { id: String, name: String, address: String, phone: String },
  category: String,
  services: [{ id: String, name: String, category: String }],
  date: { type: Date, required: true },
  timeSlot: String,
  customer: { name: String, email: String, phone: String, vehicleNo: String },
  status: { type: String, enum: ['Pending','In Progress','Completed','Cancelled'], default: 'Pending' },
  amount: { type: String, default: '$0' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

export default mongoose.models.Booking || mongoose.model("Booking", bookingSchema);