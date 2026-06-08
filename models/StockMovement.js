import mongoose from 'mongoose';

const stockMovementSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', required: true, index: true },
  sku:    { type: String, required: true, index: true },
  name:   { type: String, default: '' },

  type: {
    type: String,
    enum: [
      'initial_stock',     // item created (incl. via CSV import)
      'import_add',        // CSV import — Add Stock mode
      'import_replace',    // CSV import — Replace Stock mode
      'import_sync',       // CSV import — Full Sync mode (update)
      'import_sync_remove',// CSV import — Full Sync mode (item removed/deactivated)
      'manual_restock',    // manual "Restock" action
      'manual_adjustment', // manual edit changing quantity
      'rollback',          // import rollback restoring previous quantity
    ],
    required: true,
  },

  quantityBefore: { type: Number, required: true },
  quantityChange: { type: Number, required: true }, // signed delta
  quantityAfter:  { type: Number, required: true },

  reason: { type: String, default: '' },

  source: {
    type: String,
    enum: ['manual', 'csv_import', 'system'],
    default: 'manual',
  },
  importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryImportJob', default: null, index: true },

  performedBy: {
    username: String,
    role: String,
  },
}, {
  timestamps: true,
});

stockMovementSchema.index({ createdAt: -1 });

export default mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
