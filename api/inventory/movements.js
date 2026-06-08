// /api/inventory/movements — stock movement history (filterable by item/sku/type/source).
import StockMovement from '../../models/StockMovement.js';
import { withInventoryHandler } from '../../lib/inventoryApiUtils.js';

export default withInventoryHandler(async (req, res) => {
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
});
