import mongoose from 'mongoose';

// Pre-mutation snapshot of every InventoryItem an import is about to touch
// (updates AND full-sync removals — items the import CREATES are tracked via
// job.createdIds instead, since rollback simply deletes those). Stored
// separately from the job document for the same reason as
// InventoryImportRow — large imports could otherwise exceed the 16MB
// per-document limit. Used exclusively to power rollback.
const importBackupSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryImportJob', required: true, index: true },
  sku:   { type: String, required: true },

  // Full prior document, captured before any field was modified.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
}, {
  timestamps: true,
});

importBackupSchema.index({ jobId: 1, sku: 1 }, { unique: true });

export default mongoose.models.InventoryImportBackup
  || mongoose.model('InventoryImportBackup', importBackupSchema);
