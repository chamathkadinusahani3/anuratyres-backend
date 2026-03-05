import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
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
    const companies = await db.collection('corporate_companies')
      .find({})
      .sort({ registeredDate: -1 })
      .toArray();

    res.status(200).json({
      success: true,
      companies
    });
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch companies',
      message: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
}