// /api/inventory/template — downloadable CSV template matching the required import columns.
import { toCsv } from '../../lib/csv.js';
import { TEMPLATE_COLUMNS } from '../../lib/inventoryImport.js';
import { withInventoryHandler } from '../../lib/inventoryApiUtils.js';

const SAMPLE_ROWS = [
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

export default withInventoryHandler(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

  const csv = toCsv(TEMPLATE_COLUMNS, SAMPLE_ROWS);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory-import-template.csv"');
  res.status(200).send(csv);
});
