// /api/inventory — list inventory items (with search/filter/pagination) and create new items.
import InventoryItem from '../models/InventoryItem.js';
import StockMovement from '../models/StockMovement.js';
import InventoryAuditLog from '../models/InventoryAuditLog.js';
import {
  withInventoryHandler,
  requireInventoryWrite,
  readJsonBody,
  performedByOf,
} from '../lib/inventoryApiUtils.js';

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
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

const serializeLean = serializeItem;

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

  let items = docs.map(serializeLean);

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

export default withInventoryHandler(async (req, res, ctx) => {
  if (req.method === 'GET') return handleList(req, res, ctx);
  if (req.method === 'POST') return handleCreate(req, res, ctx);
  return res.status(405).json({ success: false, message: 'Method not allowed' });
});
