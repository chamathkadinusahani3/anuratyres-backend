// /api/inventory/import/:jobId
//
// Sub-actions are dispatched via ?action= because Vercel's static route table
// makes deeply-nested dynamic segments unwieldy (mirrors the ?type= pattern
// already used by /api/jobs for its report endpoints):
//
//   GET  ?action=status        (default) — job status / progress
//   GET  ?action=rows          — paginated parsed rows (preview / review table)
//   GET  ?action=failed-rows   — CSV download of rows that failed validation
//   POST ?action=process       — commit the next batch of rows (drives the
//                                progress bar; call repeatedly until done=true)
//   POST ?action=rollback      — revert a completed import to its pre-import state
//
// Why "process" is called repeatedly instead of queued on a worker:
// Vercel serverless functions have execution-time limits and there is no
// long-lived worker process in this deployment. Processing one bounded batch
// per request — driven by the browser in a loop — is the practical
// serverless-native equivalent of a queue: it keeps each invocation fast,
// naturally yields real-time progress, and survives page refreshes because
// state lives in MongoDB rather than in-memory.
import mongoose from 'mongoose';
import InventoryImportJob from '../../../models/InventoryImportJob.js';
import InventoryImportRow from '../../../models/InventoryImportRow.js';
import { toCsv } from '../../../lib/csv.js';
import { processNextBatch, rollbackImport, TEMPLATE_COLUMNS } from '../../../lib/inventoryImport.js';
import {
  withInventoryHandler,
  requireImportPermission,
  performedByOf,
} from '../../../lib/inventoryApiUtils.js';
import { serializeJob } from '../import.js';

function parseJobId(req) {
  const path = (req.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean); // ['api','inventory','import',':jobId']
  const idx = parts.indexOf('import') + 1;
  return parts[idx];
}

async function loadJob(jobId) {
  if (!mongoose.isValidObjectId(jobId)) {
    const err = new Error('Invalid import job id');
    err.statusCode = 400;
    throw err;
  }
  const job = await InventoryImportJob.findById(jobId);
  if (!job) {
    const err = new Error('Import job not found');
    err.statusCode = 404;
    throw err;
  }
  return job;
}

// ── GET ?action=status ───────────────────────────────────────────────────────
async function handleStatus(req, res, job) {
  res.status(200).json({ success: true, job: serializeJob(job) });
}

// ── GET ?action=rows ─────────────────────────────────────────────────────────
async function handleRows(req, res, job) {
  const { page = '1', limit = '50', filter = 'all' } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const query = { jobId: job._id };
  if (filter === 'valid') query.valid = true;
  else if (filter === 'invalid') query.valid = false;
  else if (filter === 'duplicates') query.isDuplicateInFile = true;
  else if (filter === 'create') { query.valid = true; query.action = 'create'; }
  else if (filter === 'update') { query.valid = true; query.action = 'update'; }

  const [docs, total] = await Promise.all([
    InventoryImportRow.find(query).sort({ rowNumber: 1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    InventoryImportRow.countDocuments(query),
  ]);

  res.status(200).json({
    success: true,
    rows: docs.map((r) => ({
      rowNumber: r.rowNumber,
      sku: r.data?.sku,
      name: r.data?.name,
      quantity: r.data?.quantity,
      action: r.action,
      valid: r.valid,
      errors: r.errors,
      isDuplicateInFile: r.isDuplicateInFile,
      processed: r.processed,
      processResult: r.processResult,
      processError: r.processError,
    })),
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
}

// ── GET ?action=failed-rows ──────────────────────────────────────────────────
async function handleFailedRows(req, res, job) {
  const rows = await InventoryImportRow.find({
    jobId: job._id,
    $or: [{ valid: false }, { processResult: 'failed' }],
  }).sort({ rowNumber: 1 }).lean();

  const records = rows.map((r) => ({
    row: r.rowNumber,
    sku: r.raw?.sku || r.data?.sku || '',
    name: r.raw?.name || r.data?.name || '',
    reason: r.processError || r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    ...r.raw,
  }));
  const columns = ['row', 'sku', 'name', 'reason', ...TEMPLATE_COLUMNS.filter((c) => !['sku', 'name'].includes(c))];
  const csv = toCsv(columns, records);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${job._id}-failed-rows.csv"`);
  res.status(200).send(csv);
}

// ── POST ?action=process ─────────────────────────────────────────────────────
async function handleProcess(req, res, { user, job }) {
  requireImportPermission(user);

  if (['completed', 'completed_with_errors', 'rolled_back', 'failed'].includes(job.status)) {
    return res.status(200).json({ success: true, done: true, job: serializeJob(job) });
  }
  if (job.status !== 'pending_review' && job.status !== 'processing') {
    return res.status(409).json({ success: false, message: `Cannot process a job in status "${job.status}"` });
  }

  try {
    const result = await processNextBatch(job);
    res.status(200).json({
      success: true,
      done: result.done,
      processed: result.processed || 0,
      job: serializeJob(result.job),
    });
  } catch (err) {
    job.status = 'failed';
    job.completedAt = new Date();
    await job.save().catch(() => {});
    throw err;
  }
}

// ── POST ?action=rollback ────────────────────────────────────────────────────
async function handleRollback(req, res, { user, job }) {
  requireImportPermission(user);
  const performedBy = performedByOf(user);
  const result = await rollbackImport(job, performedBy);
  const fresh = await InventoryImportJob.findById(job._id);
  res.status(200).json({
    success: true,
    message: `Import rolled back — ${result.restoredCount} item(s) restored, ${result.deletedCount} item(s) removed.`,
    ...result,
    job: serializeJob(fresh),
  });
}

export default withInventoryHandler(async (req, res, ctx) => {
  const jobId = parseJobId(req);
  if (!jobId) return res.status(400).json({ success: false, message: 'Import job id is required' });
  const job = await loadJob(jobId);
  const action = (req.query.action || (req.method === 'GET' ? 'status' : '')).toString();

  if (req.method === 'GET') {
    if (action === 'rows') return handleRows(req, res, job);
    if (action === 'failed-rows') return handleFailedRows(req, res, job);
    return handleStatus(req, res, job);
  }

  if (req.method === 'POST') {
    if (action === 'process') return handleProcess(req, res, { ...ctx, job });
    if (action === 'rollback') return handleRollback(req, res, { ...ctx, job });
    return res.status(400).json({ success: false, message: 'Unknown action — use ?action=process or ?action=rollback' });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
});
