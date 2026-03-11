// api/corporate/validate.js
// GET /api/corporate/validate?code=CORP-XXXXX
// Used by EmployeeRegistration to check if a code is valid before showing the form

import { MongoClient } from 'mongodb';
import { setCorsHeaders, handleOptionsRequest } from '../../lib/cors.js';

const uri = process.env.MONGODB_URI;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handleOptionsRequest(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ success: false, message: 'code query param is required' });
  }

  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db('anura_tyres');

    const company = await db.collection('corporate_companies').findOne({
      corporateCode: code.trim().toUpperCase(),
    });

    if (!company) {
      return res.status(200).json({ success: true, valid: false, message: 'Invalid corporate code' });
    }

    if (company.status !== 'active') {
      return res.status(200).json({
        success: true,
        valid: false,
        message: `This corporate code is currently ${company.status}. Please contact your HR department.`,
      });
    }

    return res.status(200).json({
      success: true,
      valid: true,
      companyName: company.companyName,
      discount: company.discount || 10,
    });

  } catch (error) {
    console.error('[corporate/validate] error:', error);
    return res.status(500).json({
      success: false,
      message: 'Validation failed',
      error: error.message,
    });
  } finally {
    if (client) await client.close();
  }
}