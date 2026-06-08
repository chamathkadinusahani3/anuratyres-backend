// /api/inventory/export — export current inventory (optionally filtered) as CSV.
import InventoryItem from '../../models/InventoryItem.js';
import { toCsv } from '../../lib/csv.js';
import { TEMPLATE_COLUMNS } from '../../lib/inventoryImport.js';
import { withInventoryHandler } from '../../lib/inventoryApiUtils.js';

function toRecord(item) {
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

export default withInventoryHandler(async (req, res) => {
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
  const csv = toCsv(TEMPLATE_COLUMNS, items.map(toRecord));

  const stamp = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="inventory-export-${stamp}.csv"`);
  res.status(200).send(csv);
});
