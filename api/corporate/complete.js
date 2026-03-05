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
    
    // Get all companies
    const companies = await db.collection('corporate_companies')
      .find({})
      .sort({ registeredDate: -1 })
      .toArray();

    // Get all employees
    const employees = await db.collection('employees')
      .find({})
      .toArray();

    // Combine data
    const companiesWithEmployees = companies.map(company => ({
      ...company,
      employees: employees.filter(emp => emp.corporateCode === company.corporateCode),
      employeeCount: employees.filter(emp => emp.corporateCode === company.corporateCode).length
    }));

    res.status(200).json({
      success: true,
      companies: companiesWithEmployees
    });
  } catch (error) {
    console.error('Error fetching complete data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch data',
      message: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
}