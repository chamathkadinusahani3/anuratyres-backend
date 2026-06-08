import mongoose from 'mongoose';

// Stored separately (not embedded in InventoryImportJob) so that imports of
// tens of thousands of rows never approach MongoDB's 16MB document limit,
// and so batches can be paged efficiently with an index.
const importRowSchema = new mongoose.Schema({
  jobId:     { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryImportJob', required: true, index: true },
  rowNumber: { type: Number, required: true }, // 1-based, header row excluded

  raw:  { type: mongoose.Schema.Types.Mixed, default: {} }, // original CSV cell values, keyed by column
  data: { type: mongoose.Schema.Types.Mixed, default: {} }, // normalised/typed values ready for the DB

  action: { type: String, enum: ['create', 'update', 'skip'], default: 'skip' },
  valid:  { type: Boolean, default: true },
  errors: [{ field: String, message: String }],
  isDuplicateInFile: { type: Boolean, default: false },

  // Set once the commit step has handled this row.
  processed:      { type: Boolean, default: false },
  processResult:  { type: String, enum: ['created', 'updated', 'failed', null], default: null },
  processError:   { type: String, default: '' },
}, {
  timestamps: true,
});

importRowSchema.index({ jobId: 1, valid: 1, processed: 1, rowNumber: 1 });
importRowSchema.index({ jobId: 1, rowNumber: 1 }, { unique: true });

export default mongoose.models.InventoryImportRow
  || mongoose.model('InventoryImportRow', importRowSchema);
