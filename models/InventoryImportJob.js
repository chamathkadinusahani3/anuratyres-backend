import mongoose from 'mongoose';

// NOTE: parsed CSV rows and rollback snapshots are stored in their own
// collections (InventoryImportRow / InventoryImportBackup) rather than
// embedded here — a large CSV (tens of thousands of rows) would otherwise
// blow past MongoDB's 16MB per-document limit. This document only tracks
// job metadata, mode, status and running counters.
const importJobSchema = new mongoose.Schema({
  filename: { type: String, default: 'import.csv' },
  mode: {
    type: String,
    enum: ['add_stock', 'replace_stock', 'full_sync'],
    required: true,
  },

  status: {
    type: String,
    enum: [
      'pending_review',        // parsed & validated, waiting for admin to confirm commit
      'processing',            // commit in progress (batched)
      'completed',             // finished, no row failures
      'completed_with_errors', // finished, some rows failed/skipped
      'failed',                // aborted before completion
      'rolled_back',           // admin reverted the import
    ],
    default: 'pending_review',
    index: true,
  },

  columns:        [String], // headers detected in the uploaded CSV
  missingColumns: [String], // expected columns absent from the upload (warning, not fatal)

  totalRows:     { type: Number, default: 0 },
  validRows:     { type: Number, default: 0 },
  invalidRows:   { type: Number, default: 0 },
  duplicateSkus: [String],

  // Running progress — updated as batches commit. processedCount counts
  // VALID rows only (invalid rows are never sent to the database).
  processedCount: { type: Number, default: 0 },
  createdCount:   { type: Number, default: 0 },
  updatedCount:   { type: Number, default: 0 },
  skippedCount:   { type: Number, default: 0 },
  failedCount:    { type: Number, default: 0 },

  // Rollback bookkeeping
  backupTaken:     { type: Boolean, default: false },
  createdIds:      [{ type: mongoose.Schema.Types.ObjectId }],
  syncRemovedSkus: [String], // full-sync mode: SKUs present in DB but absent from CSV

  startedAt:    { type: Date, default: null },
  completedAt:  { type: Date, default: null },
  rolledBackAt: { type: Date, default: null },

  performedBy: {
    username: String,
    role: String,
  },
}, {
  timestamps: true,
});

importJobSchema.index({ createdAt: -1 });

importJobSchema.virtual('progressPercent').get(function () {
  if (!this.validRows) return this.status === 'pending_review' ? 0 : 100;
  return Math.min(100, Math.round((this.processedCount / this.validRows) * 100));
});

importJobSchema.set('toJSON', { virtuals: true });
importJobSchema.set('toObject', { virtuals: true });

export default mongoose.models.InventoryImportJob
  || mongoose.model('InventoryImportJob', importJobSchema);
