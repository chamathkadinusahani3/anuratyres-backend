// backend/lib/inventoryImport.js
//
// Core CSV-import engine for the Inventory Management module.
//
// Flow:
//   1. parseAndValidateCsv()  — parse + validate raw CSV text (no DB writes)
//   2. createImportJob()      — persist the job + parsed rows ("upload" step,
//                               returns a preview the admin reviews/confirms)
//   3. processNextBatch()     — commit one batch (BATCH_SIZE rows) of valid
//                               rows; called repeatedly by the API/UI to drive
//                               a progress bar without hitting serverless
//                               execution-time limits — this is the
//                               serverless-appropriate stand-in for a worker
//                               queue (see notes in api/inventory/import/[jobId].js)
//   4. rollbackImport()       — restore the database to its pre-import state
//
// All batch mutations run inside a MongoDB session/transaction where the
// deployment supports it (replica sets / Atlas), and fall back gracefully to
// sequential writes on standalone MongoDB instances.

import mongoose from 'mongoose';
import { parseCsv, rowsToObjects } from './csv.js';
import InventoryItem from '../models/InventoryItem.js';
import StockMovement from '../models/StockMovement.js';
import InventoryImportJob from '../models/InventoryImportJob.js';
import InventoryImportRow from '../models/InventoryImportRow.js';
import InventoryImportBackup from '../models/InventoryImportBackup.js';
import InventoryAuditLog from '../models/InventoryAuditLog.js';

// ── Spec ──────────────────────────────────────────────────────────────────
export const REQUIRED_CSV_COLUMNS = [
  'sku', 'name', 'brand', 'category', 'quantity', 'buy_price', 'sell_price',
  'tyre_size', 'width', 'profile', 'rim_size', 'load_index', 'speed_rating',
  'season', 'barcode', 'minimum_stock', 'location',
];
export const OPTIONAL_CSV_COLUMNS = ['pattern'];
export const TEMPLATE_COLUMNS = [...REQUIRED_CSV_COLUMNS, ...OPTIONAL_CSV_COLUMNS];

export const IMPORT_MODES = ['add_stock', 'replace_stock', 'full_sync'];
export const MODE_LABELS = {
  add_stock: 'Add Stock',
  replace_stock: 'Replace Stock',
  full_sync: 'Full Sync',
};

const MANDATORY_FIELDS = ['sku', 'name', 'quantity'];
const NUMERIC_FIELDS = ['quantity', 'buy_price', 'sell_price', 'width', 'profile', 'rim_size', 'minimum_stock'];
const INTEGER_FIELDS = ['quantity', 'minimum_stock'];

export const BATCH_SIZE = 200;
export const MAX_ROWS = 50000;
const CHUNK_SIZE = 1000; // for bulk inserts of rows/backups

// ── helpers ───────────────────────────────────────────────────────────────
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeHeaderKey(h) {
  return h.trim().toLowerCase().replace(/\s+/g, '_');
}

async function insertInChunks(Model, docs, options = {}) {
  for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
    const chunk = docs.slice(i, i + CHUNK_SIZE);
    if (chunk.length) await Model.insertMany(chunk, { ordered: false, ...options });
  }
}

/** Runs `work(session)` inside a transaction when the MongoDB deployment
 *  supports it; falls back to `work(null)` (no session) on standalone
 *  instances where multi-document transactions aren't available. */
async function runMaybeInTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
    } catch (err) {
      const unsupported =
        err?.code === 20 ||
        /Transaction numbers are only allowed|IllegalOperation|Transactions are not supported/i.test(err?.message || '');
      if (!unsupported) throw err;
      result = await work(null);
    }
    return result;
  } finally {
    await session.endSession();
  }
}

// ── 1. Parse + validate (no DB writes except read-only SKU lookup) ───────────
export async function parseAndValidateCsv(csvText) {
  const { headers, rows: rawRows } = parseCsv(csvText);

  if (!headers.length) {
    const err = new Error('The CSV file is empty or could not be read.');
    err.statusCode = 400;
    throw err;
  }
  if (rawRows.length > MAX_ROWS) {
    const err = new Error(
      `This file has ${rawRows.length.toLocaleString()} data rows, which exceeds the ` +
      `${MAX_ROWS.toLocaleString()}-row limit per import. Split it into smaller files and import them separately.`
    );
    err.statusCode = 413;
    throw err;
  }

  const normalizedHeaders = headers.map(normalizeHeaderKey);
  const missingColumns = REQUIRED_CSV_COLUMNS.filter((c) => !normalizedHeaders.includes(c));

  const objects = rowsToObjects(headers, rawRows);
  const seenSkus = new Map();
  const parsedRows = [];

  objects.forEach((raw, idx) => {
    const rowNumber = idx + 1;
    const errors = [];
    const sku = (raw.sku || '').trim().toUpperCase();

    for (const field of MANDATORY_FIELDS) {
      if (!raw[field] || String(raw[field]).trim() === '') {
        errors.push({ field, message: `"${field}" is required` });
      }
    }

    const numbers = {};
    for (const field of NUMERIC_FIELDS) {
      const rawVal = raw[field];
      if (rawVal === '' || rawVal === undefined || rawVal === null) { numbers[field] = null; continue; }
      const n = toNumber(rawVal);
      if (Number.isNaN(n)) {
        errors.push({ field, message: `"${field}" must be a number (got "${rawVal}")` });
        numbers[field] = null;
      } else if (n < 0) {
        errors.push({ field, message: `"${field}" cannot be negative (got "${rawVal}")` });
        numbers[field] = null;
      } else if (INTEGER_FIELDS.includes(field) && !Number.isInteger(n)) {
        errors.push({ field, message: `"${field}" must be a whole number (got "${rawVal}")` });
        numbers[field] = null;
      } else {
        numbers[field] = n;
      }
    }

    let isDuplicateInFile = false;
    if (sku) {
      if (seenSkus.has(sku)) {
        isDuplicateInFile = true;
        errors.push({ field: 'sku', message: `Duplicate SKU within file — also appears on row ${seenSkus.get(sku)}` });
      } else {
        seenSkus.set(sku, rowNumber);
      }
    }

    const data = {
      sku,
      name: (raw.name || '').trim(),
      brand: (raw.brand || '').trim(),
      category: (raw.category || '').trim() || 'Tyres',
      quantity: numbers.quantity ?? 0,
      buyPrice: numbers.buy_price ?? 0,
      sellPrice: numbers.sell_price ?? 0,
      tyre: {
        size: (raw.tyre_size || '').trim(),
        width: numbers.width,
        profile: numbers.profile,
        rimSize: numbers.rim_size,
        loadIndex: (raw.load_index || '').trim(),
        speedRating: (raw.speed_rating || '').trim(),
        season: (raw.season || '').trim(),
        pattern: (raw.pattern || '').trim(),
      },
      barcode: (raw.barcode || '').trim(),
      minimumStock: numbers.minimum_stock ?? 0,
      location: (raw.location || '').trim(),
    };

    parsedRows.push({
      rowNumber,
      raw,
      data,
      valid: errors.length === 0,
      errors,
      isDuplicateInFile,
      action: 'skip',
    });
  });

  // Resolve create vs. update against current DB state (read-only).
  const candidateSkus = [...new Set(parsedRows.filter((r) => r.valid && r.data.sku).map((r) => r.data.sku))];
  const existing = candidateSkus.length
    ? await InventoryItem.find({ sku: { $in: candidateSkus } }, { sku: 1 }).lean()
    : [];
  const existingSet = new Set(existing.map((e) => e.sku));
  for (const row of parsedRows) {
    if (row.valid) row.action = existingSet.has(row.data.sku) ? 'update' : 'create';
  }

  const validRows = parsedRows.filter((r) => r.valid);
  const invalidRows = parsedRows.filter((r) => !r.valid);
  const duplicateSkus = [...new Set(parsedRows.filter((r) => r.isDuplicateInFile).map((r) => r.data.sku))];

  return {
    columns: headers,
    missingColumns,
    totalRows: parsedRows.length,
    validRows: validRows.length,
    invalidRows: invalidRows.length,
    toCreate: validRows.filter((r) => r.action === 'create').length,
    toUpdate: validRows.filter((r) => r.action === 'update').length,
    duplicateSkus,
    rows: parsedRows,
  };
}

// ── 2. Persist the job + parsed rows ("upload"/preview step) ─────────────────
export async function createImportJob({ filename, mode, performedBy, parsed }) {
  const job = await InventoryImportJob.create({
    filename,
    mode,
    status: 'pending_review',
    columns: parsed.columns,
    missingColumns: parsed.missingColumns,
    totalRows: parsed.totalRows,
    validRows: parsed.validRows,
    invalidRows: parsed.invalidRows,
    duplicateSkus: parsed.duplicateSkus,
    performedBy,
  });

  await insertInChunks(InventoryImportRow, parsed.rows.map((r) => ({
    jobId: job._id,
    rowNumber: r.rowNumber,
    raw: r.raw,
    data: r.data,
    action: r.action,
    valid: r.valid,
    errors: r.errors,
    isDuplicateInFile: r.isDuplicateInFile,
  })));

  await InventoryAuditLog.create({
    action: 'import_uploaded',
    entityType: 'inventory_import',
    entityId: job._id,
    details: {
      filename, mode,
      totalRows: parsed.totalRows,
      validRows: parsed.validRows,
      invalidRows: parsed.invalidRows,
      toCreate: parsed.toCreate,
      toUpdate: parsed.toUpdate,
      duplicateSkus: parsed.duplicateSkus.length,
    },
    performedBy,
  });

  return job;
}

// ── 3a. Snapshot affected items before the first batch runs ──────────────────
async function prepareBackup(job) {
  if (job.backupTaken) return job;

  const updateSkus = await InventoryImportRow.distinct('data.sku', { jobId: job._id, valid: true, action: 'update' });

  const backupDocs = [];
  if (updateSkus.length) {
    const items = await InventoryItem.find({ sku: { $in: updateSkus } }).lean();
    for (const item of items) backupDocs.push({ jobId: job._id, sku: item.sku, snapshot: item });
  }

  let syncRemovedSkus = [];
  if (job.mode === 'full_sync') {
    const csvSkus = await InventoryImportRow.distinct('data.sku', { jobId: job._id, valid: true });
    const removed = await InventoryItem.find({ sku: { $nin: csvSkus }, status: 'active' }).lean();
    syncRemovedSkus = removed.map((r) => r.sku);
    for (const item of removed) backupDocs.push({ jobId: job._id, sku: item.sku, snapshot: item });
  }

  await insertInChunks(InventoryImportBackup, backupDocs);

  job.backupTaken = true;
  job.syncRemovedSkus = syncRemovedSkus;
  job.status = 'processing';
  job.startedAt = job.startedAt || new Date();
  await job.save();
  return job;
}

function buildNewItemDoc(data, performedBy) {
  return {
    sku: data.sku,
    name: data.name,
    brand: data.brand,
    category: data.category,
    quantity: data.quantity,
    buyPrice: data.buyPrice,
    sellPrice: data.sellPrice,
    tyre: data.tyre,
    barcode: data.barcode,
    minimumStock: data.minimumStock,
    location: data.location,
    status: 'active',
    source: 'csv_import',
    createdBy: performedBy,
    updatedBy: performedBy,
  };
}

/** Resolves the new quantity + which fields to overwrite, per import mode. */
function computeUpdate(mode, currentQuantity, data) {
  let quantityAfter;
  let movementType;
  if (mode === 'add_stock') {
    quantityAfter = currentQuantity + data.quantity;
    movementType = 'import_add';
  } else if (mode === 'replace_stock') {
    quantityAfter = data.quantity;
    movementType = 'import_replace';
  } else {
    quantityAfter = data.quantity; // full_sync — mirror the CSV exactly
    movementType = 'import_sync';
  }
  const setFields = {
    name: data.name,
    brand: data.brand,
    category: data.category,
    buyPrice: data.buyPrice,
    sellPrice: data.sellPrice,
    tyre: data.tyre,
    barcode: data.barcode,
    minimumStock: data.minimumStock,
    location: data.location,
    source: 'csv_import',
  };
  return { quantityAfter, setFields, movementType };
}

// ── 3b. Commit one batch ──────────────────────────────────────────────────────
export async function processNextBatch(job) {
  if (job.status === 'pending_review') await prepareBackup(job);
  if (job.status !== 'processing') return { done: true, job, processed: 0 };

  const batch = await InventoryImportRow.find({ jobId: job._id, valid: true, processed: false })
    .sort({ rowNumber: 1 })
    .limit(BATCH_SIZE)
    .lean();

  if (!batch.length) return finalizeImportJob(job);

  const createRows = batch.filter((r) => r.action === 'create');
  const updateRows = batch.filter((r) => r.action === 'update');
  const movementDocs = [];
  const rowOutcomes = []; // { rowId, result: 'created'|'updated'|'failed', error? }

  await runMaybeInTransaction(async (session) => {
    movementDocs.length = 0;
    rowOutcomes.length = 0;

    // ── creates ──────────────────────────────────────────────────────────
    if (createRows.length) {
      const docs = createRows.map((r) => buildNewItemDoc(r.data, job.performedBy));
      let inserted = [];
      try {
        inserted = await InventoryItem.insertMany(docs, { session, ordered: false });
      } catch (err) {
        inserted = err?.insertedDocs || err?.results || [];
      }
      const insertedBySku = new Map(inserted.filter(Boolean).map((d) => [d.sku, d]));
      for (const row of createRows) {
        const doc = insertedBySku.get(row.data.sku);
        if (!doc) {
          rowOutcomes.push({ rowId: row._id, result: 'failed', error: 'Could not create item — SKU may already exist' });
          continue;
        }
        job.createdIds.push(doc._id);
        rowOutcomes.push({ rowId: row._id, result: 'created' });
        movementDocs.push({
          itemId: doc._id, sku: doc.sku, name: doc.name,
          type: 'initial_stock', source: 'csv_import', importJobId: job._id,
          quantityBefore: 0, quantityChange: doc.quantity, quantityAfter: doc.quantity,
          reason: `Created via CSV import (${MODE_LABELS[job.mode]})`,
          performedBy: job.performedBy,
        });
      }
    }

    // ── updates ──────────────────────────────────────────────────────────
    if (updateRows.length) {
      const skus = updateRows.map((r) => r.data.sku);
      const current = await InventoryItem.find({ sku: { $in: skus } }, null, { session }).lean();
      const currentBySku = new Map(current.map((c) => [c.sku, c]));

      const ops = [];
      for (const row of updateRows) {
        const existing = currentBySku.get(row.data.sku);
        if (!existing) {
          rowOutcomes.push({ rowId: row._id, result: 'failed', error: 'Item no longer exists in the database' });
          continue;
        }
        const { quantityAfter, setFields, movementType } = computeUpdate(job.mode, existing.quantity, row.data);
        ops.push({
          updateOne: {
            filter: { _id: existing._id },
            update: { $set: { ...setFields, quantity: quantityAfter, status: 'active', lastImportJobId: job._id, updatedBy: job.performedBy } },
          },
        });
        rowOutcomes.push({ rowId: row._id, result: 'updated' });
        movementDocs.push({
          itemId: existing._id, sku: existing.sku, name: row.data.name || existing.name,
          type: movementType, source: 'csv_import', importJobId: job._id,
          quantityBefore: existing.quantity, quantityChange: quantityAfter - existing.quantity, quantityAfter,
          reason: `Updated via CSV import (${MODE_LABELS[job.mode]})`,
          performedBy: job.performedBy,
        });
      }
      if (ops.length) await InventoryItem.bulkWrite(ops, { session, ordered: false });
    }

    if (movementDocs.length) await StockMovement.insertMany(movementDocs, { session, ordered: false });

    const rowUpdateOps = rowOutcomes.map(({ rowId, result, error }) => ({
      updateOne: {
        filter: { _id: rowId },
        update: { $set: { processed: true, processResult: result, processError: error || '' } },
      },
    }));
    if (rowUpdateOps.length) await InventoryImportRow.bulkWrite(rowUpdateOps, { session, ordered: false });
  });

  job.processedCount += batch.length;
  job.createdCount += rowOutcomes.filter((r) => r.result === 'created').length;
  job.updatedCount += rowOutcomes.filter((r) => r.result === 'updated').length;
  job.failedCount += rowOutcomes.filter((r) => r.result === 'failed').length;
  await job.save();

  return { done: false, job, processed: batch.length };
}

// ── 3c. Finalize (handles full-sync removals, then closes the job) ───────────
async function finalizeImportJob(job) {
  let syncRemovedCount = 0;

  if (job.mode === 'full_sync' && job.syncRemovedSkus.length) {
    const items = await InventoryItem.find({ sku: { $in: job.syncRemovedSkus }, status: 'active' }).lean();
    if (items.length) {
      await InventoryItem.bulkWrite(items.map((item) => ({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { status: 'inactive', quantity: 0, lastImportJobId: job._id, updatedBy: job.performedBy } },
        },
      })), { ordered: false });

      await insertInChunks(StockMovement, items.map((item) => ({
        itemId: item._id, sku: item.sku, name: item.name,
        type: 'import_sync_remove', source: 'csv_import', importJobId: job._id,
        quantityBefore: item.quantity, quantityChange: -item.quantity, quantityAfter: 0,
        reason: 'Deactivated — absent from Full Sync CSV (set to 0 stock, marked inactive)',
        performedBy: job.performedBy,
      })));
      syncRemovedCount = items.length;
    }
  }

  job.skippedCount = job.invalidRows;
  job.status = (job.failedCount > 0 || job.invalidRows > 0) ? 'completed_with_errors' : 'completed';
  job.completedAt = new Date();
  await job.save();

  await InventoryAuditLog.create({
    action: 'import_completed',
    entityType: 'inventory_import',
    entityId: job._id,
    sku: '',
    details: {
      mode: job.mode,
      created: job.createdCount,
      updated: job.updatedCount,
      failed: job.failedCount,
      skipped: job.skippedCount,
      syncRemoved: syncRemovedCount,
    },
    performedBy: job.performedBy,
  });

  return { done: true, job, processed: 0 };
}

// ── 4. Rollback ───────────────────────────────────────────────────────────────
export async function rollbackImport(job, performedBy) {
  if (!['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
    const err = new Error(`Cannot roll back an import with status "${job.status}".`);
    err.statusCode = 409;
    throw err;
  }
  if (!job.backupTaken) {
    const err = new Error('No backup snapshot was captured for this import — rollback is unavailable.');
    err.statusCode = 409;
    throw err;
  }

  let restoredCount = 0;
  let deletedCount = 0;

  await runMaybeInTransaction(async (session) => {
    const movementDocs = [];

    // 1. Remove items this import created.
    if (job.createdIds.length) {
      const created = await InventoryItem.find({ _id: { $in: job.createdIds } }, null, { session }).lean();
      if (created.length) {
        await InventoryItem.deleteMany({ _id: { $in: job.createdIds } }, { session });
        deletedCount = created.length;
        for (const item of created) {
          movementDocs.push({
            itemId: item._id, sku: item.sku, name: item.name,
            type: 'rollback', source: 'csv_import', importJobId: job._id,
            quantityBefore: item.quantity, quantityChange: -item.quantity, quantityAfter: 0,
            reason: `Rolled back — item deleted (was created by import ${job._id})`,
            performedBy,
          });
        }
      }
    }

    // 2. Restore prior state of every item the import updated or removed.
    const backups = await InventoryImportBackup.find({ jobId: job._id }, null, { session }).lean();
    if (backups.length) {
      const skus = backups.map((b) => b.sku);
      const current = await InventoryItem.find({ sku: { $in: skus } }, null, { session }).lean();
      const currentBySku = new Map(current.map((c) => [c.sku, c]));

      const ops = [];
      for (const b of backups) {
        const snap = b.snapshot || {};
        const restoreDoc = { ...snap };
        delete restoreDoc._id;
        delete restoreDoc.__v;
        delete restoreDoc.createdAt;
        ops.push({ updateOne: { filter: { sku: b.sku }, update: { $set: restoreDoc } } });

        const curr = currentBySku.get(b.sku);
        const restoredQty = typeof snap.quantity === 'number' ? snap.quantity : 0;
        if (curr) {
          movementDocs.push({
            itemId: curr._id, sku: b.sku, name: snap.name || curr.name,
            type: 'rollback', source: 'csv_import', importJobId: job._id,
            quantityBefore: curr.quantity, quantityChange: restoredQty - curr.quantity, quantityAfter: restoredQty,
            reason: `Rolled back — restored to pre-import state (import ${job._id})`,
            performedBy,
          });
        }
      }
      if (ops.length) {
        await InventoryItem.bulkWrite(ops, { session, ordered: false });
        restoredCount = ops.length;
      }
    }

    if (movementDocs.length) await StockMovement.insertMany(movementDocs, { session, ordered: false });
  });

  job.status = 'rolled_back';
  job.rolledBackAt = new Date();
  await job.save();

  await InventoryAuditLog.create({
    action: 'import_rolled_back',
    entityType: 'inventory_import',
    entityId: job._id,
    details: { restoredCount, deletedCount },
    performedBy,
  });

  return { restoredCount, deletedCount };
}

export default {
  REQUIRED_CSV_COLUMNS,
  OPTIONAL_CSV_COLUMNS,
  TEMPLATE_COLUMNS,
  IMPORT_MODES,
  MODE_LABELS,
  BATCH_SIZE,
  MAX_ROWS,
  parseAndValidateCsv,
  createImportJob,
  processNextBatch,
  rollbackImport,
};
