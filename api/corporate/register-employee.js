// api/corporate/register-employee.js
// POST /api/corporate/register-employee — saves employee to MongoDB

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
      employeeName, employeeEmail, employeePhone,
      corporateCode, vehicleNo, department, employeeId,
    } = req.body;

    // Basic validation
    if (!employeeName?.trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (!employeeEmail?.includes('@')) {
      return res.status(400).json({ success: false, message: 'Valid email is required' });
    }
    if (!employeePhone?.trim()) {
      return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    if (!corporateCode?.trim()) {
      return res.status(400).json({ success: false, message: 'Corporate code is required' });
    }

    client = new MongoClient(uri);
    await client.connect();
    const db = client.db('anura_tyres');

    // Validate the corporate code exists and is active
    const company = await db.collection('corporate_companies').findOne({
      corporateCode: corporateCode.trim().toUpperCase(),
      status: 'active',
    });

    if (!company) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or inactive corporate code. Please check with your HR department.',
      });
    }

    // Check for duplicate employee email under same company
    const existingEmployee = await db.collection('employees').findOne({
      employeeEmail: employeeEmail.toLowerCase(),
      corporateCode: corporateCode.trim().toUpperCase(),
    });
    if (existingEmployee) {
      return res.status(409).json({
        success: false,
        message: 'You are already registered for this company\'s discount program.',
        employeeDiscountId: existingEmployee.employeeDiscountId,
      });
    }

    // Generate unique employee discount ID
    const randomPart = Math.random().toString(36).substring(2, 7).toUpperCase();
    const employeeDiscountId = `EMP-${randomPart}`;

    const employeeData = {
      employeeName:       employeeName.trim(),
      employeeEmail:      employeeEmail.toLowerCase().trim(),
      employeePhone:      employeePhone.trim(),
      corporateCode:      corporateCode.trim().toUpperCase(),
      companyName:        company.companyName,
      vehicleNo:          vehicleNo?.toUpperCase().trim() || '',
      department:         department?.trim() || '',
      employeeId:         employeeId?.trim() || '',
      employeeDiscountId,
      discount:           10,
      status:             'active',
      registeredDate:     new Date().toISOString(),
      usageCount:         0,
      createdAt:          new Date(),
    };

    await db.collection('employees').insertOne(employeeData);

    console.log(`✅ Employee registered: ${employeeName} → ${employeeDiscountId} (${company.companyName})`);

    return res.status(201).json({
      success: true,
      message: 'Employee registration successful',
      employeeDiscountId,
      companyName: company.companyName,
    });

  } catch (error) {
    console.error('[corporate/register-employee] error:', error);
    return res.status(500).json({
      success: false,
      message: 'Registration failed',
      error: error.message,
    });
  } finally {
    if (client) await client.close();
  }
}