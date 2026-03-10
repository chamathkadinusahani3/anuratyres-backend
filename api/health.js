import { setCorsHeaders, handleOptionsRequest } from "../lib/cors.js";

export default async function handler(req, res) {
  setCorsHeaders(req, res); // ✅ Fixed: req AND res

  if (handleOptionsRequest(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  res.status(200).json({
    status: 'OK',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
}