// lib/cors.js

const ALLOWED_ORIGINS = [
  'https://anuratyressystem.vercel.app',  // admin dashboard
  'https://chamathkadinusahani3.github.io/anuratyrespvtltd', // customer site
  'http://localhost:5173/anuratyrespvtltd',  // local dev (Vite default)
  'http://localhost:3000',  // local dev (alternate)
  'http://localhost:5174',  // Vite preview
];

export function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  // Allow the request origin if it's in our whitelist
  // Also allow if origin starts with our GitHub Pages base (covers any sub-path)
  if (
    origin &&
    (ALLOWED_ORIGINS.includes(origin) ||
      origin.startsWith('https://chamathkadinusahani3.github.io'))
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // Fallback — allow all during development; tighten in production if needed
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '3600');
}

export function handleOptionsRequest(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(req, res);
    res.status(200).end();
    return true;
  }
  return false;
}