// api/corporate.js
// Single handler for ALL corporate routes — replaces 6 separate files:
//   GET  /api/corporate/companies
//   GET  /api/corporate/complete
//   GET  /api/corporate/employees
//   GET  /api/corporate/stats
//   GET  /api/corporate/validate
//   POST /api/corporate/register
//   POST /api/corporate/register-employee
//   PATCH /api/corporate/company-status
//   PATCH /api/corporate/employee-status

import { MongoClient, ObjectId } from 'mongodb';

const uri = process.env.MONGODB_URI;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
}

let cachedClient = null;
async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  return cachedClient.db('anura_tyres');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Parse the sub-route from the URL
  // e.g. /api/corporate/register  → action = "register"
  //      /api/corporate/companies → action = "companies"
  const url    = req.url || '';
  const parts  = url.replace(/\?.*$/, '').split('/').filter(Boolean);
  // parts = ["api", "corporate", "register"] or ["api", "corporate", "validate"]
  const action = parts[parts.length - 1]; // last segment

  try {
    const db = await getDb();

    // ── GET /api/corporate/companies ─────────────────────────────────────────
    if (req.method === 'GET' && action === 'companies') {
      const companies = await db.collection('corporate_companies')
        .find({}).sort({ registeredDate: -1 }).toArray();
      return res.status(200).json({ success: true, companies });
    }

    // ── GET /api/corporate/complete ──────────────────────────────────────────
    if (req.method === 'GET' && action === 'complete') {
      const companies = await db.collection('corporate_companies')
        .find({}).sort({ registeredDate: -1 }).toArray();
      const employees = await db.collection('employees').find({}).toArray();
      const companiesWithEmployees = companies.map(c => ({
        ...c,
        employees:     employees.filter(e => e.corporateCode === c.corporateCode),
        employeeCount: employees.filter(e => e.corporateCode === c.corporateCode).length,
      }));
      return res.status(200).json({ success: true, companies: companiesWithEmployees });
    }

    // ── GET /api/corporate/employees ─────────────────────────────────────────
    if (req.method === 'GET' && action === 'employees') {
      const { corporateCode } = req.query;
      const filter = corporateCode ? { corporateCode } : {};
      const employees = await db.collection('employees')
        .find(filter).sort({ registeredDate: -1 }).toArray();
      return res.status(200).json({ success: true, employees });
    }

    // ── GET /api/corporate/stats ─────────────────────────────────────────────
    if (req.method === 'GET' && action === 'stats') {
      const companies = await db.collection('corporate_companies').find({}).toArray();
      const employees = await db.collection('employees').find({}).toArray();
      const stats = {
        totalCompanies:    companies.length,
        activeCompanies:   companies.filter(c => c.status === 'active').length,
        totalEmployees:    employees.length,
        activeEmployees:   employees.filter(e => e.status === 'active').length,
        totalBookings:     companies.reduce((s, c) => s + (c.bookingCount || 0), 0),
        totalDiscountGiven: 0,
        topCompanies: companies
          .map(c => ({
            companyName:   c.companyName,
            employeeCount: employees.filter(e => e.corporateCode === c.corporateCode).length,
            bookingCount:  c.bookingCount || 0,
          }))
          .sort((a, b) => b.employeeCount - a.employeeCount)
          .slice(0, 5),
      };
      return res.status(200).json({ success: true, stats });
    }

    // ── GET /api/corporate/validate?code=CORP-XXXXX ──────────────────────────
    if (req.method === 'GET' && action === 'validate') {
      const { code } = req.query;
      if (!code) return res.status(400).json({ success: false, message: 'code param required' });

      const company = await db.collection('corporate_companies').findOne({
        corporateCode: code.trim().toUpperCase(),
      });

      if (!company) {
        return res.status(200).json({ success: true, valid: false, message: 'Invalid corporate code' });
      }
      if (company.status !== 'active') {
        return res.status(200).json({
          success: true, valid: false,
          message: `This code is currently ${company.status}. Contact your HR department.`,
        });
      }
      return res.status(200).json({
        success: true, valid: true,
        companyName: company.companyName,
        discount:    company.discount || 10,
      });
    }

    // ── POST /api/corporate/register ─────────────────────────────────────────
    if (req.method === 'POST' && action === 'register') {
      const { companyName, contactPerson, email, phone, businessType, taxId, address, employees } = req.body;

      if (!companyName?.trim()) return res.status(400).json({ success: false, message: 'Company name is required' });
      if (!email?.includes('@')) return res.status(400).json({ success: false, message: 'Valid email is required' });
      if (!phone?.trim())        return res.status(400).json({ success: false, message: 'Phone number is required' });

      const existing = await db.collection('corporate_companies').findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A company with this email is already registered.',
          corporateCode: existing.corporateCode,
        });
      }

      const corporateCode = `CORP-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      await db.collection('corporate_companies').insertOne({
        companyName: companyName.trim(), contactPerson: contactPerson?.trim() || '',
        email: email.toLowerCase().trim(), phone: phone.trim(),
        businessType: businessType || '', taxId: taxId || '',
        address: address || '', employees: employees || '',
        corporateCode, discount: 10, status: 'active',
        registeredDate: new Date().toISOString(), bookingCount: 0, createdAt: new Date(),
      });

      console.log(`✅ Corporate registered: ${companyName} → ${corporateCode}`);
      return res.status(201).json({ success: true, message: 'Corporate registration successful', corporateCode });
    }

    // ── POST /api/corporate/register-employee ────────────────────────────────
    if (req.method === 'POST' && action === 'register-employee') {
      const { employeeName, employeeEmail, employeePhone, corporateCode, vehicleNo, department, employeeId } = req.body;

      if (!employeeName?.trim())         return res.status(400).json({ success: false, message: 'Name is required' });
      if (!employeeEmail?.includes('@')) return res.status(400).json({ success: false, message: 'Valid email is required' });
      if (!employeePhone?.trim())        return res.status(400).json({ success: false, message: 'Phone is required' });
      if (!corporateCode?.trim())        return res.status(400).json({ success: false, message: 'Corporate code is required' });

      const company = await db.collection('corporate_companies').findOne({
        corporateCode: corporateCode.trim().toUpperCase(), status: 'active',
      });
      if (!company) {
        return res.status(400).json({ success: false, message: 'Invalid or inactive corporate code.' });
      }

      const existingEmp = await db.collection('employees').findOne({
        employeeEmail: employeeEmail.toLowerCase(),
        corporateCode: corporateCode.trim().toUpperCase(),
      });
      if (existingEmp) {
        return res.status(409).json({
          success: false,
          message: 'You are already registered for this company\'s discount program.',
          employeeDiscountId: existingEmp.employeeDiscountId,
        });
      }

      const employeeDiscountId = `EMP-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      await db.collection('employees').insertOne({
        employeeName: employeeName.trim(), employeeEmail: employeeEmail.toLowerCase().trim(),
        employeePhone: employeePhone.trim(), corporateCode: corporateCode.trim().toUpperCase(),
        companyName: company.companyName, vehicleNo: vehicleNo?.toUpperCase().trim() || '',
        department: department?.trim() || '', employeeId: employeeId?.trim() || '',
        employeeDiscountId, discount: 10, status: 'active',
        registeredDate: new Date().toISOString(), usageCount: 0, createdAt: new Date(),
      });

      console.log(`✅ Employee registered: ${employeeName} → ${employeeDiscountId} (${company.companyName})`);
      return res.status(201).json({
        success: true, message: 'Employee registration successful',
        employeeDiscountId, companyName: company.companyName,
      });
    }

    // ── PATCH /api/corporate/company-status ──────────────────────────────────
    if (req.method === 'PATCH' && action === 'company-status') {
      const { id, status } = req.body;
      if (!id || !status) return res.status(400).json({ success: false, message: 'id and status required' });

      await db.collection('corporate_companies').updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      return res.status(200).json({ success: true });
    }

    // ── PATCH /api/corporate/employee-status ─────────────────────────────────
    if (req.method === 'PATCH' && action === 'employee-status') {
      const { id, status } = req.body;
      if (!id || !status) return res.status(400).json({ success: false, message: 'id and status required' });

      await db.collection('employees').updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      return res.status(200).json({ success: true });
    }

    // ── 404 fallback ──────────────────────────────────────────────────────────
    return res.status(404).json({ success: false, message: `Unknown corporate action: ${action}` });

  } catch (error) {
    console.error(`[corporate/${action}] error:`, error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
}