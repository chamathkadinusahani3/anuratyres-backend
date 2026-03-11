// api/corporate/register.js
// POST /api/corporate/register  — saves a new corporate company to MongoDB

import { MongoClient } from 'mongodb';
import { setCorsHeaders, handleOptionsRequest } from '../../lib/cors.js';

const uri = process.env.MONGODB_URI;

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  if (handleOptionsRequest(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let client;
  try {
    const {
      companyName, contactPerson, email, phone,
      businessType, taxId, address, employees,
    } = req.body;

    // Basic validation
    if (!companyName?.trim()) {
      return res.status(400).json({ success: false, message: 'Company name is required' });
    }
    if (!email?.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }
    if (!phone?.trim()) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }

    client = new MongoClient(uri);
    await client.connect();
    const db = client.db('anura_tyres');

    // Check for duplicate email
    const existing = await db.collection('corporate_companies').findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'A company with this email is already registered.',
        corporateCode: existing.corporateCode, // return existing code
      });
    }

    // Generate a unique, readable corporate code
    const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
    const corporateCode = `CORP-${randomPart}`;

    const corporateData = {
      companyName:    companyName.trim(),
      contactPerson:  contactPerson?.trim() || '',
      email:          email.toLowerCase().trim(),
      phone:          phone.trim(),
      businessType:   businessType || '',
      taxId:          taxId || '',
      address:        address || '',
      employees:      employees || '',
      corporateCode,
      discount:       10,
      status:         'active',
      registeredDate: new Date().toISOString(),
      bookingCount:   0,
      createdAt:      new Date(),
    };

    await db.collection('corporate_companies').insertOne(corporateData);

    console.log(`✅ Corporate registered: ${companyName} → ${corporateCode}`);

    return res.status(201).json({
      success: true,
      message: 'Corporate registration successful',
      corporateCode,
    });

  } catch (error) {
    console.error('[corporate/register] error:', error);
    return res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message,
    });
  } finally {
    if (client) await client.close();
  }
}