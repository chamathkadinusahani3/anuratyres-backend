import mongoose from 'mongoose';

const inventoryItemSchema = new mongoose.Schema({
  sku: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true,
  },
  name:     { type: String, required: true, trim: true },
  brand:    { type: String, default: '', trim: true },
  category: { type: String, default: 'Tyres', trim: true, index: true },

  quantity:     { type: Number, default: 0, min: 0 },
  buyPrice:     { type: Number, default: 0, min: 0 },
  sellPrice:    { type: Number, default: 0, min: 0 },
  minimumStock: { type: Number, default: 0, min: 0 },

  // ── Tyre-specific details (optional for non-tyre items) ──────────────────
  tyre: {
    size:        { type: String, default: '' },   // e.g. "225/45R17"
    width:       { type: Number, default: null }, // e.g. 225
    profile:     { type: Number, default: null }, // e.g. 45
    rimSize:     { type: Number, default: null }, // e.g. 17
    loadIndex:   { type: String, default: '' },   // e.g. "94"
    speedRating: { type: String, default: '' },   // e.g. "W"
    season:      { type: String, default: '' },   // e.g. "Summer"
    pattern:     { type: String, default: '' },
  },

  barcode:  { type: String, default: '', trim: true, index: true },
  location: { type: String, default: '', trim: true },

  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
    index: true,
  },

  source: {
    type: String,
    enum: ['manual', 'csv_import'],
    default: 'manual',
  },

  lastImportJobId: { type: mongoose.Schema.Types.ObjectId, default: null },

  createdBy: {
    username: String,
    role: String,
  },
  updatedBy: {
    username: String,
    role: String,
  },
}, {
  timestamps: true,
});

inventoryItemSchema.index({ name: 'text', brand: 'text', sku: 'text', barcode: 'text' });

inventoryItemSchema.virtual('stockStatus').get(function () {
  if (this.quantity <= 0) return 'Out of Stock';
  if (this.quantity <= this.minimumStock) return 'Low Stock';
  return 'In Stock';
});

inventoryItemSchema.set('toJSON', { virtuals: true });
inventoryItemSchema.set('toObject', { virtuals: true });

export default mongoose.models.InventoryItem || mongoose.model('InventoryItem', inventoryItemSchema);
