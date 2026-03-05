import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let client;

  try {
    client = new MongoClient(uri);
    await client.connect();
    
    const db = client.db('anura_tyres');
    
    const companies = await db.collection('corporate_companies').find({}).toArray();
    const employees = await db.collection('employees').find({}).toArray();

    const stats = {
      totalCompanies: companies.length,
      activeCompanies: companies.filter(c => c.status === 'active').length,
      totalEmployees: employees.length,
      activeEmployees: employees.filter(e => e.status === 'active').length,
      totalBookings: companies.reduce((sum, c) => sum + (c.bookingCount || 0), 0),
      totalDiscountGiven: 0, // Calculate based on your logic
      topCompanies: companies
        .map(c => ({
          companyName: c.companyName,
          employeeCount: employees.filter(e => e.corporateCode === c.corporateCode).length,
          bookingCount: c.bookingCount || 0
        }))
        .sort((a, b) => b.employeeCount - a.employeeCount)
        .slice(0, 5)
    };

    res.status(200).json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
      message: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
}