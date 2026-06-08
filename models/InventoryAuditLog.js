import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: [
      'item_created',
      'item_updated',
      'item_deleted',
      'stock_adjusted',
      'import_uploaded',
      'import_committed',
      'import_completed',
      'import_failed',
      'import_rolled_back',
    ],
    required: true,
    index: true,
  },
  entityType: { type: String, enum: ['inventory_item', 'inventory_import'], required: true },
  entityId:   { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  sku:        { type: String, default: '' },

  details: { type: mongoose.Schema.Types.Mixed, default: {} },

  performedBy: {
    username: String,
    role: String,
  },
}, {
  timestamps: true,
});

auditLogSchema.index({ createdAt: -1 });

export default mongoose.models.InventoryAuditLog
  || mongoose.model('InventoryAuditLog', auditLogSchema);
