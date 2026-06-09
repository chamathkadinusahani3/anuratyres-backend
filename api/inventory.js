// /api/inventory — consolidated inventory endpoint.
//
// Vercel's Hobby plan caps a deployment at 12 serverless functions, and every
// file under api/**/*.js counts as one. This single file folds in everything
// that used to live under api/inventory/** (item CRUD + restock, CSV export,
// CSV template, stock movements, and the whole CSV-import workflow) and
// dispatches internally on the URL path + method/query — mirroring the
// parsePath()/?action= patterns already used elsewhere in this codebase
// (the old /api/inventory/[id].js and /api/inventory/import/[jobId].js, and
// the ?type= dispatch in /api/jobs).
//
//   GET    /api/inventory                              list (search/filter/paginate)
//   POST   /api/inventory                              create item
//   GET    /api/inventory/export                       CSV export
//   GET    /api/inventory/template                     CSV import template
//   GET    /api/inventory/movements                    stock movement history
//   POST   /api/inventory/import                       upload CSV (preview + validate)
//   GET    /api/inventory/import                       import history
//   GET    /api/inventory/import/:jobId(?action=status|rows|failed-rows)
//   POST   /api/inventory/import/:jobId?action=process|rollback
//   GET    /api/inventory/:id                          fetch item
//   PUT|PATCH /api/inventory/:id                       update item
//   DELETE /api/inventory/:id                          delete item
//   POST   /api/inventory/:id/restock                  adjust stock
import mongoose from 'mongoose';
import InventoryItem from '../models/InventoryItem.js';
import StockMovement from '../models/StockMovement.js';
import InventoryAuditLog from '../models/InventoryAuditLog.js';
import InventoryImportJob from '../models/InventoryImportJob.js';
import InventoryImportRow from '../models/InventoryImportRow.js';
import { toCsv } from '../lib/csv.js';
import {
  parseAndValidateCsv,
  createImportJob,
  processNextBatch,
  rollbackImport,
  IMPORT_MODES,
  MAX_ROWS,
  TEMPLATE_COLUMNS,
} from '../lib/inventoryImport.js';
import {
  withInventoryHandler,
  requireInventoryWrite,
  requireImportPermission,
  readJsonBody,
  performedByOf,
} from '../lib/inventoryApiUtils.js';
import { cloudinaryEnabled, signUpload, deleteFromCloudinary } from '../lib/cloudinaryHelper.js';

const PREVIEW_ROWS = 50;

// ── Serialization ───────────────────────────────────────────────────────────
function serializeItem(doc) {
  const item = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
  return {
    id: item._id.toString(),
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    category: item.category,
    quantity: item.quantity,
    buyPrice: item.buyPrice,
    sellPrice: item.sellPrice,
    minimumStock: item.minimumStock,
    tyre: item.tyre,
    barcode: item.barcode,
    location: item.location,
    status: item.status,
    stockStatus: item.quantity <= 0 ? 'Out of Stock' : item.quantity <= item.minimumStock ? 'Low Stock' : 'In Stock',
    source: item.source,
    images: (item.images || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((img) => ({
        id: img._id?.toString() || img.id,
        url: img.url,
        publicId: img.publicId,
        featured: img.featured,
        sortOrder: img.sortOrder,
        alt: img.alt || '',
        uploadedAt: img.uploadedAt,
      })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

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

function toExportRecord(item) {
  return {
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    category: item.category,
    quantity: item.quantity,
    buy_price: item.buyPrice,
    sell_price: item.sellPrice,
    tyre_size: item.tyre?.size || '',
    width: item.tyre?.width ?? '',
    profile: item.tyre?.profile ?? '',
    rim_size: item.tyre?.rimSize ?? '',
    load_index: item.tyre?.loadIndex || '',
    speed_rating: item.tyre?.speedRating || '',
    season: item.tyre?.season || '',
    barcode: item.barcode,
    minimum_stock: item.minimumStock,
    location: item.location,
    pattern: item.tyre?.pattern || '',
  };
}

const TEMPLATE_SAMPLE_ROWS = [
  {
    sku: 'TYRE001', name: 'Michelin Pilot Sport 4', brand: 'Michelin', category: 'Tyres',
    quantity: 12, buy_price: 120, sell_price: 180, tyre_size: '225/45R17',
    width: 225, profile: 45, rim_size: 17, load_index: '94', speed_rating: 'W',
    season: 'Summer', barcode: '8901234567001', minimum_stock: 4, location: 'Pannipitiya - Rack A1',
    pattern: 'Pilot Sport 4',
  },
  {
    sku: 'TYRE002', name: 'Bridgestone Turanza', brand: 'Bridgestone', category: 'Tyres',
    quantity: 8, buy_price: 100, sell_price: 150, tyre_size: '205/55R16',
    width: 205, profile: 55, rim_size: 16, load_index: '91', speed_rating: 'V',
    season: 'All-Season', barcode: '8901234567002', minimum_stock: 4, location: 'Pannipitiya - Rack A2',
    pattern: 'Turanza T005',
  },
];

// ── URL helpers ──────────────────────────────────────────────────────────────
// Returns the path segments after "inventory", e.g.
//   /api/inventory                  -> []
//   /api/inventory/export           -> ['export']
//   /api/inventory/import/507f...   -> ['import', '507f...']
//   /api/inventory/507f.../restock  -> ['507f...', 'restock']
function pathSegments(req) {
  const path = (req.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean); // ['api','inventory', ...rest]
  const idx = parts.indexOf('inventory');
  return parts.slice(idx + 1);
}

async function loadItem(id) {
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error('Invalid inventory item id');
    err.statusCode = 400;
    throw err;
  }
  const item = await InventoryItem.findById(id);
  if (!item) {
    const err = new Error('Inventory item not found');
    err.statusCode = 404;
    throw err;
  }
  return item;
}

async function loadImportJob(jobId) {
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

// ── List / Create ────────────────────────────────────────────────────────────
async function handleList(req, res) {
  const {
    search = '', category = 'all', status = 'all', stockStatus = 'all',
    page = '1', limit = '50', sort = '-createdAt',
  } = req.query;

  const filter = {};
  if (status !== 'all') filter.status = status;
  if (category !== 'all') filter.category = category;
  if (search) {
    filter.$or = [
      { sku: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } },
      { brand: { $regex: search, $options: 'i' } },
      { barcode: { $regex: search, $options: 'i' } },
    ];
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));

  let query = InventoryItem.find(filter).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum);
  const [docs, total] = await Promise.all([query.lean({ virtuals: true }), InventoryItem.countDocuments(filter)]);

  let items = docs.map(serializeItem);

  if (stockStatus !== 'all') items = items.filter((i) => i.stockStatus === stockStatus);

  const [totalValueAgg, alertCount] = await Promise.all([
    InventoryItem.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: null, value: { $sum: { $multiply: ['$quantity', '$sellPrice'] } } } },
    ]),
    InventoryItem.countDocuments({ status: 'active', $expr: { $lte: ['$quantity', '$minimumStock'] } }),
  ]);

  res.status(200).json({
    success: true,
    items,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    stats: {
      totalItems: total,
      totalStockValue: totalValueAgg[0]?.value || 0,
      stockAlerts: alertCount,
    },
  });
}

async function handleCreate(req, res, { user }) {
  requireInventoryWrite(user);
  const body = await readJsonBody(req);

  const sku = (body.sku || '').trim().toUpperCase();
  const name = (body.name || '').trim();
  if (!sku) return res.status(400).json({ success: false, message: 'SKU is required' });
  if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

  const existing = await InventoryItem.findOne({ sku });
  if (existing) {
    return res.status(409).json({ success: false, message: `An item with SKU "${sku}" already exists`, duplicate: true });
  }

  const performedBy = performedByOf(user);
  const quantity = Math.max(0, parseInt(body.quantity, 10) || 0);

  const doc = await InventoryItem.create({
    sku,
    name,
    brand: (body.brand || '').trim(),
    category: (body.category || 'Tyres').trim(),
    quantity,
    buyPrice: Math.max(0, Number(body.buyPrice) || 0),
    sellPrice: Math.max(0, Number(body.sellPrice) || 0),
    minimumStock: Math.max(0, parseInt(body.minimumStock, 10) || 0),
    tyre: {
      size: (body.tyre?.size || '').trim(),
      width: body.tyre?.width ?? null,
      profile: body.tyre?.profile ?? null,
      rimSize: body.tyre?.rimSize ?? null,
      loadIndex: (body.tyre?.loadIndex || '').trim(),
      speedRating: (body.tyre?.speedRating || '').trim(),
      season: (body.tyre?.season || '').trim(),
      pattern: (body.tyre?.pattern || '').trim(),
    },
    barcode: (body.barcode || '').trim(),
    location: (body.location || '').trim(),
    status: 'active',
    source: 'manual',
    createdBy: performedBy,
    updatedBy: performedBy,
  });

  if (quantity > 0) {
    await StockMovement.create({
      itemId: doc._id, sku: doc.sku, name: doc.name,
      type: 'initial_stock', source: 'manual',
      quantityBefore: 0, quantityChange: quantity, quantityAfter: quantity,
      reason: 'Item created manually',
      performedBy,
    });
  }

  await InventoryAuditLog.create({
    action: 'item_created', entityType: 'inventory_item', entityId: doc._id, sku: doc.sku,
    details: { name: doc.name, quantity: doc.quantity },
    performedBy,
  });

  res.status(201).json({ success: true, message: 'Inventory item created', item: serializeItem(doc) });
}

// ── Item: get / update / delete / restock ───────────────────────────────────
async function handleGetItem(req, res, item) {
  res.status(200).json({ success: true, item: serializeItem(item) });
}

async function handleUpdateItem(req, res, { user, item }) {
  requireInventoryWrite(user);
  const body = await readJsonBody(req);
  const performedBy = performedByOf(user);

  if (body.sku !== undefined) {
    const newSku = String(body.sku).trim().toUpperCase();
    if (newSku && newSku !== item.sku) {
      const dup = await InventoryItem.findOne({ sku: newSku, _id: { $ne: item._id } });
      if (dup) return res.status(409).json({ success: false, message: `An item with SKU "${newSku}" already exists`, duplicate: true });
      item.sku = newSku;
    }
  }

  const fieldMap = {
    name: 'name', brand: 'brand', category: 'category', barcode: 'barcode', location: 'location',
  };
  for (const [key, field] of Object.entries(fieldMap)) {
    if (body[key] !== undefined) item[field] = String(body[key]).trim();
  }
  if (body.buyPrice !== undefined) item.buyPrice = Math.max(0, Number(body.buyPrice) || 0);
  if (body.sellPrice !== undefined) item.sellPrice = Math.max(0, Number(body.sellPrice) || 0);
  if (body.minimumStock !== undefined) item.minimumStock = Math.max(0, parseInt(body.minimumStock, 10) || 0);
  if (body.tyre && typeof body.tyre === 'object') {
    item.tyre = {
      size: (body.tyre.size ?? item.tyre?.size ?? '').toString().trim(),
      width: body.tyre.width ?? item.tyre?.width ?? null,
      profile: body.tyre.profile ?? item.tyre?.profile ?? null,
      rimSize: body.tyre.rimSize ?? item.tyre?.rimSize ?? null,
      loadIndex: (body.tyre.loadIndex ?? item.tyre?.loadIndex ?? '').toString().trim(),
      speedRating: (body.tyre.speedRating ?? item.tyre?.speedRating ?? '').toString().trim(),
      season: (body.tyre.season ?? item.tyre?.season ?? '').toString().trim(),
      pattern: (body.tyre.pattern ?? item.tyre?.pattern ?? '').toString().trim(),
    };
  }

  // Direct quantity edits are logged as manual adjustments.
  if (body.quantity !== undefined) {
    const newQty = Math.max(0, parseInt(body.quantity, 10) || 0);
    if (newQty !== item.quantity) {
      const before = item.quantity;
      item.quantity = newQty;
      await StockMovement.create({
        itemId: item._id, sku: item.sku, name: item.name,
        type: 'manual_adjustment', source: 'manual',
        quantityBefore: before, quantityChange: newQty - before, quantityAfter: newQty,
        reason: body.adjustmentReason || 'Manual stock adjustment',
        performedBy,
      });
    }
  }

  if (body.status && ['active', 'inactive'].includes(body.status)) item.status = body.status;

  item.updatedBy = performedBy;
  await item.save();

  await InventoryAuditLog.create({
    action: 'item_updated', entityType: 'inventory_item', entityId: item._id, sku: item.sku,
    details: { changedFields: Object.keys(body) },
    performedBy,
  });

  res.status(200).json({ success: true, message: 'Inventory item updated', item: serializeItem(item) });
}

async function handleDeleteItem(req, res, { user, item }) {
  requireInventoryWrite(user);
  const performedBy = performedByOf(user);

  await InventoryItem.deleteOne({ _id: item._id });

  if (item.quantity > 0) {
    await StockMovement.create({
      itemId: item._id, sku: item.sku, name: item.name,
      type: 'manual_adjustment', source: 'manual',
      quantityBefore: item.quantity, quantityChange: -item.quantity, quantityAfter: 0,
      reason: 'Item deleted',
      performedBy,
    });
  }

  await InventoryAuditLog.create({
    action: 'item_deleted', entityType: 'inventory_item', entityId: item._id, sku: item.sku,
    details: { name: item.name },
    performedBy,
  });

  res.status(200).json({ success: true, message: 'Inventory item deleted' });
}

async function handleRestock(req, res, { user, item }) {
  requireInventoryWrite(user);
  const body = await readJsonBody(req);
  const qty = parseInt(body.quantity, 10);
  if (!Number.isFinite(qty) || qty === 0) {
    return res.status(400).json({ success: false, message: 'A non-zero quantity is required' });
  }

  const before = item.quantity;
  const after = Math.max(0, before + qty);
  item.quantity = after;
  item.updatedBy = performedByOf(user);
  await item.save();

  const performedBy = performedByOf(user);
  await StockMovement.create({
    itemId: item._id, sku: item.sku, name: item.name,
    type: 'manual_restock', source: 'manual',
    quantityBefore: before, quantityChange: after - before, quantityAfter: after,
    reason: body.reason || (qty > 0 ? 'Manual restock' : 'Manual stock reduction'),
    performedBy,
  });

  await InventoryAuditLog.create({
    action: 'stock_adjusted', entityType: 'inventory_item', entityId: item._id, sku: item.sku,
    details: { quantityBefore: before, quantityChange: after - before, quantityAfter: after },
    performedBy,
  });

  res.status(200).json({ success: true, message: 'Stock updated', item: serializeItem(item) });
}

// ── Export / Template / Movements ───────────────────────────────────────────
async function handleExport(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const { search = '', category = 'all', status = 'active' } = req.query;
  const filter = {};
  if (status !== 'all') filter.status = status;
  if (category !== 'all') filter.category = category;
  if (search) {
    filter.$or = [
      { sku: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } },
      { brand: { $regex: search, $options: 'i' } },
    ];
  }

  const items = await InventoryItem.find(filter).sort({ sku: 1 }).lean();
  const csv = toCsv(TEMPLATE_COLUMNS, items.map(toExportRecord));

  const stamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventory-export-${stamp}.csv"`);
  res.status(200).send(csv);
}

async function handleTemplate(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const csv = toCsv(TEMPLATE_COLUMNS, TEMPLATE_SAMPLE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory-import-template.csv"');
  res.status(200).send(csv);
}

async function handleMovements(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const { sku = '', itemId = '', type = '', source = '', page = '1', limit = '50' } = req.query;
  const filter = {};
  if (sku) filter.sku = sku.toUpperCase();
  if (itemId) filter.itemId = itemId;
  if (type) filter.type = type;
  if (source) filter.source = source;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const [docs, total] = await Promise.all([
    StockMovement.find(filter).sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    StockMovement.countDocuments(filter),
  ]);

  const movements = docs.map((m) => ({
    id: m._id.toString(),
    itemId: m.itemId?.toString() || null,
    sku: m.sku,
    name: m.name,
    type: m.type,
    quantityBefore: m.quantityBefore,
    quantityChange: m.quantityChange,
    quantityAfter: m.quantityAfter,
    reason: m.reason,
    source: m.source,
    importJobId: m.importJobId?.toString() || null,
    performedBy: m.performedBy,
    createdAt: m.createdAt,
  }));

  res.status(200).json({
    success: true,
    movements,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
}

// ── Import: upload / history ─────────────────────────────────────────────────
async function handleImportUpload(req, res, { user }) {
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

async function handleImportHistory(req, res) {
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

// ── Import job: status / rows / failed-rows / process / rollback ─────────────
// Sub-actions are dispatched via ?action= because Vercel's static route table
// makes deeply-nested dynamic segments unwieldy (mirrors the ?type= pattern
// used by /api/jobs for its report endpoints):
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
async function handleJobStatus(req, res, job) {
  res.status(200).json({ success: true, job: serializeJob(job) });
}

async function handleJobRows(req, res, job) {
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

async function handleJobFailedRows(req, res, job) {
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

async function handleJobProcess(req, res, { user, job }) {
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

async function handleJobRollback(req, res, { user, job }) {
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

async function dispatchImportJob(req, res, ctx, jobId) {
  if (!jobId) return res.status(400).json({ success: false, message: 'Import job id is required' });
  const job = await loadImportJob(jobId);
  const action = (req.query.action || (req.method === 'GET' ? 'status' : '')).toString();

  if (req.method === 'GET') {
    if (action === 'rows') return handleJobRows(req, res, job);
    if (action === 'failed-rows') return handleJobFailedRows(req, res, job);
    return handleJobStatus(req, res, job);
  }

  if (req.method === 'POST') {
    if (action === 'process') return handleJobProcess(req, res, { ...ctx, job });
    if (action === 'rollback') return handleJobRollback(req, res, { ...ctx, job });
    return res.status(400).json({ success: false, message: 'Unknown action — use ?action=process or ?action=rollback' });
  }

  return res.status(405).json({ success: false, message: 'Method not allowed' });
}

// ── Product images ───────────────────────────────────────────────────────────
function handleImagesGet(res, item) {
  const images = (item.images || [])
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((img) => ({
      id: img._id?.toString() || img.id,
      url: img.url,
      publicId: img.publicId,
      featured: img.featured,
      sortOrder: img.sortOrder,
      alt: img.alt || '',
      uploadedAt: img.uploadedAt,
    }));
  return res.status(200).json({ success: true, images });
}

function handleImageSign(req, res, { user }) {
  requireInventoryWrite(user);
  if (!cloudinaryEnabled()) {
    return res.status(503).json({
      success: false,
      notConfigured: true,
      message: 'Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in your Vercel environment variables.',
    });
  }
  return res.status(200).json({ success: true, ...signUpload() });
}

async function handleImageSave(req, res, { user }, item) {
  requireInventoryWrite(user);
  const { url, publicId, alt = '' } = await readJsonBody(req);
  if (!url || !publicId) {
    return res.status(400).json({ success: false, message: 'url and publicId are required' });
  }

  const isFirst = (item.images || []).length === 0;
  item.images = item.images || [];
  item.images.push({
    url,
    publicId,
    featured: isFirst,
    sortOrder: item.images.length,
    alt: (alt || '').toString().slice(0, 200),
    uploadedAt: new Date(),
  });
  await item.save();

  const saved = item.images[item.images.length - 1];
  return res.status(201).json({
    success: true,
    image: {
      id: saved._id.toString(),
      url: saved.url,
      publicId: saved.publicId,
      featured: saved.featured,
      sortOrder: saved.sortOrder,
      alt: saved.alt,
      uploadedAt: saved.uploadedAt,
    },
  });
}

async function handleImageDelete(req, res, { user }, item, imageId) {
  requireInventoryWrite(user);
  if (!mongoose.isValidObjectId(imageId)) {
    return res.status(400).json({ success: false, message: 'Invalid image id' });
  }

  const idx = (item.images || []).findIndex((img) => img._id.toString() === imageId);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Image not found' });

  const [removed] = item.images.splice(idx, 1);
  const wasFeatured = removed.featured;

  // Re-number sortOrder and set a new featured if needed
  item.images.forEach((img, i) => { img.sortOrder = i; });
  if (wasFeatured && item.images.length > 0) item.images[0].featured = true;

  await item.save();
  deleteFromCloudinary(removed.publicId).catch(() => {});

  return res.status(200).json({ success: true });
}

async function handleImageFeatured(req, res, { user }, item, imageId) {
  requireInventoryWrite(user);
  if (!mongoose.isValidObjectId(imageId)) {
    return res.status(400).json({ success: false, message: 'Invalid image id' });
  }

  let found = false;
  (item.images || []).forEach((img) => {
    img.featured = img._id.toString() === imageId;
    if (img.featured) found = true;
  });
  if (!found) return res.status(404).json({ success: false, message: 'Image not found' });

  await item.save();
  return res.status(200).json({ success: true });
}

async function handleImageReorder(req, res, { user }, item) {
  requireInventoryWrite(user);
  const { order } = await readJsonBody(req); // [{id, sortOrder}]
  if (!Array.isArray(order)) {
    return res.status(400).json({ success: false, message: 'order must be an array of {id, sortOrder}' });
  }

  const map = new Map(order.map((o) => [o.id, Number(o.sortOrder)]));
  (item.images || []).forEach((img) => {
    const s = map.get(img._id.toString());
    if (s !== undefined) img.sortOrder = s;
  });
  await item.save();
  return res.status(200).json({ success: true });
}

function dispatchImages(req, res, ctx, item, third, fourth) {
  if (!third) {
    if (req.method === 'GET') return handleImagesGet(res, item);
    if (req.method === 'POST') return handleImageSave(req, res, ctx, item);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  if (third === 'sign') return handleImageSign(req, res, ctx);
  if (third === 'reorder') {
    if (req.method === 'PATCH' || req.method === 'POST') return handleImageReorder(req, res, ctx, item);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  // third is an imageId
  if (!fourth) {
    if (req.method === 'DELETE') return handleImageDelete(req, res, ctx, item, third);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  if (fourth === 'featured') {
    if (req.method === 'PATCH' || req.method === 'POST') return handleImageFeatured(req, res, ctx, item, third);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
  return res.status(404).json({ success: false, message: 'Unknown image action' });
}

// ── Main dispatch ────────────────────────────────────────────────────────────
export default withInventoryHandler(async (req, res, ctx) => {
  const [first, second, third, fourth] = pathSegments(req);

  if (!first) {
    if (req.method === 'GET') return handleList(req, res, ctx);
    if (req.method === 'POST') return handleCreate(req, res, ctx);
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  if (first === 'export') return handleExport(req, res, ctx);
  if (first === 'template') return handleTemplate(req, res, ctx);
  if (first === 'movements') return handleMovements(req, res, ctx);

  if (first === 'import') {
    if (!second) {
      if (req.method === 'POST') return handleImportUpload(req, res, ctx);
      if (req.method === 'GET') return handleImportHistory(req, res, ctx);
      return res.status(405).json({ success: false, message: 'Method not allowed' });
    }
    return dispatchImportJob(req, res, ctx, second);
  }

  // Anything else is /api/inventory/:id (+ optional sub-routes).
  const item = await loadItem(first);
  if (second === 'restock' && req.method === 'POST') return handleRestock(req, res, { ...ctx, item });
  if (second === 'images') return dispatchImages(req, res, ctx, item, third, fourth);
  if (second) return res.status(404).json({ success: false, message: 'Unknown action' });

  if (req.method === 'GET') return handleGetItem(req, res, item);
  if (req.method === 'PUT' || req.method === 'PATCH') return handleUpdateItem(req, res, { ...ctx, item });
  if (req.method === 'DELETE') return handleDeleteItem(req, res, { ...ctx, item });
  return res.status(405).json({ success: false, message: 'Method not allowed' });
});
