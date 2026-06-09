// Cloudinary helper — signs uploads and deletes images without the full SDK.
// Uses Node.js built-in crypto for SHA-1 and the Cloudinary REST API via fetch.
//
// Required env vars (set in Vercel dashboard):
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET

import crypto from 'crypto';

const CLOUD  = process.env.CLOUDINARY_CLOUD_NAME;
const KEY    = process.env.CLOUDINARY_API_KEY;
const SECRET = process.env.CLOUDINARY_API_SECRET;
const FOLDER = 'anura-tyres';

export function cloudinaryEnabled() {
  return !!(CLOUD && KEY && SECRET);
}

/** Returns the params the frontend needs to upload directly to Cloudinary. */
export function signUpload() {
  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `folder=${FOLDER}&timestamp=${timestamp}`;
  const signature = crypto.createHash('sha1').update(paramsToSign + SECRET).digest('hex');
  return { signature, timestamp, apiKey: KEY, cloudName: CLOUD, folder: FOLDER };
}

/** Deletes an image from Cloudinary by publicId. Fire-and-forget friendly. */
export async function deleteFromCloudinary(publicId) {
  if (!cloudinaryEnabled()) return;
  const timestamp = Math.round(Date.now() / 1000);
  const str = `public_id=${publicId}&timestamp=${timestamp}${SECRET}`;
  const signature = crypto.createHash('sha1').update(str).digest('hex');

  try {
    await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_id: publicId, api_key: KEY, timestamp, signature }),
    });
  } catch {
    // Non-fatal — the image may already be gone
  }
}
