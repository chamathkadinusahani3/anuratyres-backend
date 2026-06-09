// /api/products — public-facing product catalog from the inventory database.
//
// No authentication required. All routes are GET-only.
// Uses the same path-segment dispatch pattern as api/inventory.js.
//
//   GET  /api/products                  list (search/filter/sort/paginate)
//   GET  /api/products/meta             brands, categories, price range, stock counts
//   GET  /api/products/featured         12 newest in-stock items
//   GET  /api/products/:id              single product + 6 related (same category)
import mongoose from 'mongoose';
import { connectToDatabase } from '../lib/mongodb.js';
import InventoryItem from '../models/InventoryItem.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Returns segments after "products": /api/products/meta -> ['meta']
function pathSegments(req) {
  const path = (req.url || '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  const idx = parts.indexOf('products');
  return parts.slice(idx + 1);
}

// buyPrice is intentionally excluded from the public API.
function serializeProduct(item) {
  const qty = item.quantity ?? 0;
  const min = item.minimumStock ?? 0;
  return {
    id: item._id.toString(),
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    category: item.category,
    price: item.sellPrice,
    quantity: item.quantity,
    minimumStock: item.minimumStock,
    stockStatus: qty <= 0 ? 'Out of Stock' : qty <= min ? 'Low Stock' : 'In Stock',
    tyre: item.tyre,
    barcode: item.barcode,
    location: item.location,
    images: (item.images || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((img) => ({
        id: img._id?.toString() || img.id,
        url: img.url,
        publicId: img.publicId,
        featured: img.featured,
        sortOrder: img.sortOrder,
        alt: img.alt || '',
      })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ── GET /api/products ────────────────────────────────────────────────────────
async function handleList(req, res) {
  const {
    search = '', category = '', brand = '', stockStatus = '',
    minPrice = '', maxPrice = '', tyreSize = '',
    sort = '-createdAt', page = '1', limit = '24',
  } = req.query;

  const filter = { status: 'active' };
  if (category) filter.category = category;
  if (brand) filter.brand = { $regex: brand, $options: 'i' };
  if (tyreSize) filter['tyre.size'] = { $regex: tyreSize, $options: 'i' };
  if (minPrice !== '' || maxPrice !== '') {
    filter.sellPrice = {};
    if (minPrice !== '') filter.sellPrice.$gte = Number(minPrice);
    if (maxPrice !== '') filter.sellPrice.$lte = Number(maxPrice);
  }
  if (search) {
    filter.$or = [
      { sku: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } },
      { brand: { $regex: search, $options: 'i' } },
      { 'tyre.size': { $regex: search, $options: 'i' } },
      { 'tyre.pattern': { $regex: search, $options: 'i' } },
    ];
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));

  const SORT_MAP = {
    '-createdAt': { createdAt: -1 }, 'createdAt': { createdAt: 1 },
    'sellPrice': { sellPrice: 1 }, '-sellPrice': { sellPrice: -1 },
    'name': { name: 1 }, '-name': { name: -1 },
  };
  const sortObj = SORT_MAP[sort] ?? { createdAt: -1 };

  const [docs, total] = await Promise.all([
    InventoryItem.find(filter).sort(sortObj).skip((pageNum - 1) * limitNum).limit(limitNum).lean(),
    InventoryItem.countDocuments(filter),
  ]);

  let products = docs.map(serializeProduct);
  if (stockStatus) products = products.filter((p) => p.stockStatus === stockStatus);

  res.status(200).json({
    success: true,
    products,
    pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
  });
}

// ── GET /api/products/meta ───────────────────────────────────────────────────
async function handleMeta(req, res) {
  const base = { status: 'active' };
  const [brands, categories, priceAgg, countAgg] = await Promise.all([
    InventoryItem.distinct('brand', base),
    InventoryItem.distinct('category', base),
    InventoryItem.aggregate([
      { $match: base },
      { $group: { _id: null, minPrice: { $min: '$sellPrice' }, maxPrice: { $max: '$sellPrice' } } },
    ]),
    InventoryItem.aggregate([
      { $match: base },
      { $group: {
        _id: null,
        total: { $sum: 1 },
        inStock: { $sum: { $cond: [{ $gt: ['$quantity', '$minimumStock'] }, 1, 0] } },
        lowStock: { $sum: { $cond: [{ $and: [{ $gt: ['$quantity', 0] }, { $lte: ['$quantity', '$minimumStock'] }] }, 1, 0] } },
        outOfStock: { $sum: { $cond: [{ $lte: ['$quantity', 0] }, 1, 0] } },
      }},
    ]),
  ]);

  const pr = priceAgg[0] ?? { minPrice: 0, maxPrice: 0 };
  const ct = countAgg[0] ?? { total: 0, inStock: 0, lowStock: 0, outOfStock: 0 };

  res.status(200).json({
    success: true,
    brands: brands.filter(Boolean).sort(),
    categories: categories.filter(Boolean).sort(),
    priceRange: { min: pr.minPrice ?? 0, max: pr.maxPrice ?? 0 },
    stockCounts: { total: ct.total, inStock: ct.inStock, lowStock: ct.lowStock, outOfStock: ct.outOfStock },
  });
}

// ── GET /api/products/featured ───────────────────────────────────────────────
async function handleFeatured(req, res) {
  const docs = await InventoryItem.find({ status: 'active', quantity: { $gt: 0 } })
    .sort({ createdAt: -1 }).limit(12).lean();
  res.status(200).json({ success: true, products: docs.map(serializeProduct) });
}

// ── GET /api/products/:id ────────────────────────────────────────────────────
async function handleGetProduct(req, res, id) {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ success: false, message: 'Invalid product id' });
  }
  const item = await InventoryItem.findOne({ _id: id, status: 'active' }).lean();
  if (!item) return res.status(404).json({ success: false, message: 'Product not found' });

  const related = await InventoryItem.find({ status: 'active', category: item.category, _id: { $ne: item._id } })
    .sort({ createdAt: -1 }).limit(6).lean();

  res.status(200).json({
    success: true,
    product: serializeProduct(item),
    related: related.map(serializeProduct),
  });
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  try {
    await connectToDatabase();
    const [first] = pathSegments(req);
    if (!first) return handleList(req, res);
    if (first === 'meta') return handleMeta(req, res);
    if (first === 'featured') return handleFeatured(req, res);
    return handleGetProduct(req, res, first);
  } catch (err) {
    console.error('[products api]', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
