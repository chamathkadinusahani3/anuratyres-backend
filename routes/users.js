// routes/users.js
// Place this file at: backend/routes/users.js
// Then register it in server.js with: app.use('/api/users', require('./routes/users'));

const express = require('express');
const router  = express.Router();
const mongoose = require('mongoose');

// ─── Mongoose Schema ──────────────────────────────────────────────────────────
const VehicleSchema = new mongoose.Schema({
  plate:           { type: String, required: true },
  make:            { type: String, default: '' },
  model:           { type: String, default: '' },
  year:            { type: String, default: '' },
  tyreSize:        { type: String, default: '' },
  insuranceExpiry: { type: String, default: '' },
  revenueExpiry:   { type: String, default: '' },
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  name:        { type: String, default: '' },
  email:       { type: String, required: true, lowercase: true },
  phone:       { type: String, default: '' },
  vehicles:    [VehicleSchema],
}, { timestamps: true });

// Use existing model if already compiled (avoids Vercel hot-reload errors)
const User = mongoose.models.User || mongoose.model('User', UserSchema);

// ─── POST /api/users/sync ─────────────────────────────────────────────────────
// Called by frontend right after Firebase login or registration.
// Creates the user document if it doesn't exist yet (upsert).
// Safe to call on every login — won't overwrite existing data.
router.post('/sync', async (req, res) => {
  try {
    const { firebaseUid, name, email, phone, vehiclePlate } = req.body;

    if (!firebaseUid || !email) {
      return res.status(400).json({ success: false, message: 'firebaseUid and email are required.' });
    }

    // Try to find existing user
    let user = await User.findOne({ firebaseUid });

    if (!user) {
      // First login — create the user document
      const initialVehicles = vehiclePlate
        ? [{ plate: vehiclePlate.toUpperCase() }]
        : [];

      user = await User.create({
        firebaseUid,
        name:     name  || '',
        email:    email.toLowerCase(),
        phone:    phone || '',
        vehicles: initialVehicles,
      });

      return res.status(201).json({ success: true, isNewUser: true, user });
    }

    // Returning user — optionally update name/phone if they were blank
    let changed = false;
    if (!user.name  && name)  { user.name  = name;  changed = true; }
    if (!user.phone && phone) { user.phone = phone; changed = true; }
    if (changed) await user.save();

    return res.status(200).json({ success: true, isNewUser: false, user });

  } catch (err) {
    console.error('POST /api/users/sync error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /api/users/:uid ──────────────────────────────────────────────────────
// Returns full user profile including vehicles array.
router.get('/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, user });
  } catch (err) {
    console.error('GET /api/users/:uid error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/users/:uid ──────────────────────────────────────────────────────
// Update name / phone.
router.put('/:uid', async (req, res) => {
  try {
    const { name, phone } = req.body;
    const user = await User.findOneAndUpdate(
      { firebaseUid: req.params.uid },
      { $set: { name, phone } },
      { new: true }
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, user });
  } catch (err) {
    console.error('PUT /api/users/:uid error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST /api/users/:uid/vehicles ───────────────────────────────────────────
// Add a new vehicle to the user's vehicles array.
router.post('/:uid/vehicles', async (req, res) => {
  try {
    const { plate, make, model, year, tyreSize, insuranceExpiry, revenueExpiry } = req.body;

    if (!plate) {
      return res.status(400).json({ success: false, message: 'Vehicle plate is required.' });
    }

    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    user.vehicles.push({ plate: plate.toUpperCase(), make, model, year, tyreSize, insuranceExpiry, revenueExpiry });
    await user.save();

    res.status(201).json({ success: true, vehicles: user.vehicles });
  } catch (err) {
    console.error('POST /api/users/:uid/vehicles error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PUT /api/users/:uid/vehicles/:vehicleId ──────────────────────────────────
// Update an existing vehicle.
router.put('/:uid/vehicles/:vehicleId', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const vehicle = user.vehicles.id(req.params.vehicleId);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found.' });

    // Update only provided fields
    const fields = ['plate', 'make', 'model', 'year', 'tyreSize', 'insuranceExpiry', 'revenueExpiry'];
    fields.forEach(f => {
      if (req.body[f] !== undefined) vehicle[f] = f === 'plate' ? req.body[f].toUpperCase() : req.body[f];
    });

    await user.save();
    res.json({ success: true, vehicles: user.vehicles });
  } catch (err) {
    console.error('PUT /api/users/:uid/vehicles/:vehicleId error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── DELETE /api/users/:uid/vehicles/:vehicleId ───────────────────────────────
// Remove a vehicle from the array.
router.delete('/:uid/vehicles/:vehicleId', async (req, res) => {
  try {
    const user = await User.findOne({ firebaseUid: req.params.uid });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    user.vehicles = user.vehicles.filter(
      v => v._id.toString() !== req.params.vehicleId
    );
    await user.save();

    res.json({ success: true, vehicles: user.vehicles });
  } catch (err) {
    console.error('DELETE /api/users/:uid/vehicles/:vehicleId error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;