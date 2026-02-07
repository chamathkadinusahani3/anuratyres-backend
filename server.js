const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected (Atlas)'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Booking Schema
const bookingSchema = new mongoose.Schema({
  bookingId: {
    type: String,
    unique: true,
    required: true
  },
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
  services: [{
    id: String,
    name: String,
    category: String
  }],
  date: {
    type: Date,
    required: true
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
      required: true
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
    default: 'Pending'
  },
  amount: {
    type: String,
    default: '$0'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

const Booking = mongoose.model('Booking', bookingSchema);

// Generate Booking ID
function generateBookingId() {
  const timestamp = Date.now().toString().slice(-4);
  const random = Math.floor(Math.random() * 9000) + 1000;
  return `BK-${random}${timestamp}`.slice(0, 10);
}

// Routes

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Create Booking (Website)
app.post('/api/bookings', async (req, res) => {
  try {
    const bookingId = generateBookingId();
    
    const booking = new Booking({
      bookingId,
      ...req.body,
      status: 'Pending'
    });

    await booking.save();

    // Here you can add email notification logic
    console.log('📧 Booking Created:', bookingId);

    res.status(201).json({
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
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message
    });
  }
});

// Get All Bookings (Dashboard)
app.get('/api/bookings', async (req, res) => {
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

    res.json({
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
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
});

// Get Single Booking
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findOne({ bookingId: req.params.id });
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.json({
      success: true,
      booking
    });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking',
      error: error.message
    });
  }
});

// Update Booking Status
app.patch('/api/bookings/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const booking = await Booking.findOneAndUpdate(
      { bookingId: req.params.id },
      { 
        status,
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.json({
      success: true,
      message: 'Booking status updated',
      booking
    });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update booking',
      error: error.message
    });
  }
});

// Delete Booking
app.delete('/api/bookings/:id', async (req, res) => {
  try {
    const booking = await Booking.findOneAndDelete({ bookingId: req.params.id });
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.json({
      success: true,
      message: 'Booking deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete booking',
      error: error.message
    });
  }
});

// Get Booking Statistics
app.get('/api/bookings/stats/summary', async (req, res) => {
  try {
    const total = await Booking.countDocuments();
    const pending = await Booking.countDocuments({ status: 'Pending' });
    const inProgress = await Booking.countDocuments({ status: 'In Progress' });
    const completed = await Booking.countDocuments({ status: 'Completed' });
    const cancelled = await Booking.countDocuments({ status: 'Cancelled' });

    res.json({
      success: true,
      stats: {
        total,
        pending,
        inProgress,
        completed,
        cancelled
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 API URL: http://localhost:${PORT}/api`);
});

module.exports = app;