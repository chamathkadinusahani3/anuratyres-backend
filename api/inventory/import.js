// /api/inventory/import
//   POST — upload a CSV, parse + validate it, persist a "pending_review" job
//          and return a preview (first N rows + validation summary) for the
//          admin to confirm before anything is written to the database.
//   GET  — paginated import history / activity log.
import InventoryImportJob from '../../models/InventoryImportJob.js';
import {
  parseAndValidateCsv,
  createImportJob,
  IMPORT_MODES,
  MAX_ROWS,
} from '../../lib/inventoryImport.js';
import {
  withInventoryHandler,
  requireImportPermission,
  readJsonBody,
  performedByOf,
} from '../../lib/inventoryApiUtils.js';

const PREVIEW_ROWS = 50;

function serializeJob(job) {
  const j = job.toObject ? job.toObject({ virtuals: true }) : job;
  return {
    id: j._id.toString(),
    filename: j.filename,
    mode: j.mode,
    status: j.status,
    columns: j.columns,
    missingColumns: j.missingColumns,
    totalRows: j.totalRows,
    validRows: j.validRows,
    invalidRows: j.invalidRows,
    duplicateSkus: j.duplicateSkus,
    processedCount: j.processedCount,
    createdCount: j.createdCount,
    updatedCount: j.updatedCount,
    skippedCount: j.skippedCount,
    failedCount: j.failedCount,
    progressPercent: j.progressPercent ?? (j.validRows ? Math.round((j.processedCount / j.validRows) * 100) : 0),
    syncRemovedSkus: j.syncRemovedSkus,
    backupTaken: j.backupTaken,
    startedAt: j.startedAt,
    completedAt: j.completedAt,
    rolledBackAt: j.rolledBackAt,
    performedBy: j.performedBy,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

async function handleUpload(req, res, { user }) {
  requireImportPermission(user);
  const body = await readJsonBody(req);

  const mode = body.mode;
  if (!IMPORT_MODES.includes(mode)) {
    return res.status(400).json({ success: false, message: `mode must be one of: ${IMPORT_MODES.join(', ')}` });
  }
  const csvText = body.csv;
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ success: false, message: 'CSV file content (csv) is required' });
  }
  if (csvText.length > 60 * 1024 * 1024) {
    return res.status(413).json({ success: false, message: 'File is too large (max 60MB). Split it into smaller files.' });
  }

  const parsed = await parseAndValidateCsv(csvText);
  const performedBy = performedByOf(user);
  const job = await createImportJob({
    filename: (body.filename || 'import.csv').toString().slice(0, 255),
    mode,
    performedBy,
    parsed,
  });

  const previewRows = parsed.rows.slice(0, PREVIEW_ROWS).map((r) => ({
    rowNumber: r.rowNumber,
    sku: r.data.sku,
    name: r.data.name,
    quantity: r.data.quantity,
    action: r.action,
    valid: r.valid,
    errors: r.errors,
    isDuplicateInFile: r.isDuplicateInFile,
  }));
  const errorRows = parsed.rows.filter((r) => !r.valid).slice(0, PREVIEW_ROWS).map((r) => ({
    rowNumber: r.rowNumber,
    sku: r.data.sku,
    name: r.data.name,
    errors: r.errors,
  }));

  res.status(201).json({
    success: true,
    message: 'CSV parsed and validated. Review the preview, then confirm to import.',
    job: serializeJob(job),
    preview: previewRows,
    errorRows,
    previewTruncated: parsed.rows.length > PREVIEW_ROWS,
    maxRows: MAX_ROWS,
  });
}

async function handleHistory(req, res) {
  const { page = '1', limit = '20', status = '' } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const [docs, total] = await Promise.all([
    InventoryImportJob.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum),
    InventoryImportJob.countDocuments(filter),
  ]);

  res.status(200).json({
    success: true,
    imports: docs.map(serializeJob),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
}

export default withInventoryHandler(async (req, res, ctx) => {
  if (req.method === 'POST') return handleUpload(req, res, ctx);
  if (req.method === 'GET') return handleHistory(req, res, ctx);
  return res.status(405).json({ success: false, message: 'Method not allowed' });
});

export { serializeJob, PREVIEW_ROWS };
