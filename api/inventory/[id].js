// /api/inventory/:id — fetch, update, delete a single item; /api/inventory/:id/restock to adjust stock.
import mongoose from 'mongoose';
import InventoryItem from '../../models/InventoryItem.js';
import StockMovement from '../../models/StockMovement.js';
import InventoryAuditLog from '../../models/InventoryAuditLog.js';
import {
  withInventoryHandler,
  requireInventoryWrite,
  readJsonBody,
  performedByOf,
} from '../../lib/inventoryApiUtils.js';

function serializeItem(item) {
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

function parsePath(req) {
  // /api/inventory/:id or /api/inventory/:id/restock
  const path = (req.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean); // ['api','inventory',':id', maybe 'restock']
  const idIdx = parts.indexOf('inventory') + 1;
  const id = parts[idIdx];
  const action = parts[idIdx + 1] || null;
  return { id, action };
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

async function handleGet(req, res, item) {
  res.status(200).json({ success: true, item: serializeItem(item) });
}

async function handleUpdate(req, res, { user, item }) {
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

async function handleDelete(req, res, { user, item }) {
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

export default withInventoryHandler(async (req, res, ctx) => {
  const { id, action } = parsePath(req);
  if (!id) return res.status(400).json({ success: false, message: 'Inventory item id is required' });
  const item = await loadItem(id);

  if (action === 'restock' && req.method === 'POST') return handleRestock(req, res, { ...ctx, item });
  if (action) return res.status(404).json({ success: false, message: 'Unknown action' });

  if (req.method === 'GET') return handleGet(req, res, item);
  if (req.method === 'PUT' || req.method === 'PATCH') return handleUpdate(req, res, { ...ctx, item });
  if (req.method === 'DELETE') return handleDelete(req, res, { ...ctx, item });
  return res.status(405).json({ success: false, message: 'Method not allowed' });
});
