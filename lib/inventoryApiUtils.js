// backend/lib/inventoryApiUtils.js
// Shared helpers for the /api/inventory* serverless handlers: CORS, DB
// connection, user/role extraction and permission checks, and request-body
// reading. Mirrors the conventions already used in api/bookings.js.

import { connectToDatabase } from './mongodb.js';

const VALID_ROLES = ['Super Admin', 'Admin', 'Manager', 'Cashier'];

// Roles allowed to manage inventory (create/edit/delete/restock).
const INVENTORY_WRITE_ROLES = ['Super Admin', 'Admin', 'Manager'];
// Roles allowed to run CSV imports / rollbacks — admin-level only, per spec.
const IMPORT_ROLES = ['Super Admin', 'Admin'];

export function setCors(res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Role, X-User-Branch, X-User-Name');
}

export function getUserFromHeaders(req) {
  const role     = req.headers['x-user-role']?.toString().trim()   || 'Cashier';
  const branch   = req.headers['x-user-branch']?.toString().trim() || '';
  const username = req.headers['x-user-name']?.toString().trim()   || 'unknown';

  if (!VALID_ROLES.includes(role)) {
    const err = new Error(`Invalid role: ${role}`);
    err.statusCode = 400;
    throw err;
  }

  return { role, branch, username, canManageInventory: INVENTORY_WRITE_ROLES.includes(role), canImport: IMPORT_ROLES.includes(role) };
}

export function requireInventoryWrite(user) {
  if (!user.canManageInventory) {
    const err = new Error('You do not have permission to modify inventory.');
    err.statusCode = 403;
    throw err;
  }
}

export function requireImportPermission(user) {
  if (!user.canImport) {
    const err = new Error('CSV import is restricted to Admin and Super Admin roles.');
    err.statusCode = 403;
    throw err;
  }
}

export function performedByOf(user) {
  return { username: user.username, role: user.role };
}

/** Reads the full request body as a UTF-8 string (handles large CSV payloads
 *  that bypass Vercel's default JSON body parsing when sent as text/plain,
 *  and JSON bodies forwarded as Buffers). */
export async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Request body must be valid JSON.');
    err.statusCode = 400;
    throw err;
  }
}

/** Wraps a handler with CORS, OPTIONS short-circuit, DB connection and
 *  centralised error formatting so each route file only contains routing logic. */
export function withInventoryHandler(handler) {
  return async function wrapped(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }

    try {
      await connectToDatabase();
      const user = getUserFromHeaders(req);
      await handler(req, res, { user });
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('[inventory api]', err);
      res.status(status).json({
        success: false,
        message: err.message || 'Server error',
      });
    }
  };
}

export default {
  setCors,
  getUserFromHeaders,
  requireInventoryWrite,
  requireImportPermission,
  performedByOf,
  readRawBody,
  readJsonBody,
  withInventoryHandler,
};
