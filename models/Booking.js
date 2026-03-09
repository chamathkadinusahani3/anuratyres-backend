import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema({
  bookingId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  // ── NEW: links MongoDB booking to Firebase user ──────────────────────────
  firebaseUid: {
    type: String,
    default: null,   // null = guest booking (not logged in)
    index: true
  },
  // ────────────────────────────────────────────────────────────────────────
  branch: {
    id: String,
    name: String,
    address: String,
    phone: String
  },
  category: {
    type: String,
    required: true
  },
  services: [
    {
      id: String,
      name: String,
      category: String
    }
  ],
  date: {
    type: Date,
    required: true,
    index: true
  },
  timeSlot: {
    type: String,
    required: true
  },
  customer: {
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true,
      lowercase: true
    },
    phone: {
      type: String,
      required: true
    },
    vehicleNo: String
  },
  status: {
    type: String,
    enum: ['Pending', 'In Progress', 'Completed', 'Cancelled'],
    default: 'Pending',
    index: true
  },
  amount: {
    type: String,
    default: '$0'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.models.Booking || mongoose.model('Booking', bookingSchema);