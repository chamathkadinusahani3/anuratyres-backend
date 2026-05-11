// ─── notify.lk SMS helper (FIXED VERSION) ───────────────────────────────────
async function sendNotifyLkSMS(to: string, message: string): Promise<void> {
  const userId   = process.env.NOTIFY_USER_ID;
  const apiKey   = process.env.NOTIFY_API_KEY;
  const senderId = process.env.NOTIFY_SENDER_ID ?? 'NotifyDEMO';

  if (!userId || !apiKey) {
    throw new Error('NOTIFY_USER_ID or NOTIFY_API_KEY env vars are not set.');
  }

  // ── Normalise phone ──────────────────────────────────────────────────────
  let normalised = to.replace(/[\s\-]/g, '');
  if (normalised.startsWith('+')) normalised = normalised.slice(1);
  if (normalised.startsWith('0')) normalised = '94' + normalised.slice(1);
  if (!normalised.startsWith('94')) normalised = '94' + normalised;

  const params = new URLSearchParams({
    user_id: userId,
    api_key: apiKey,
    sender_id: senderId,
    to: normalised,
    message,
  });

  const url = `https://app.notify.lk/api/v1/send?${params.toString()}`;

  console.log('[notify.lk] Sending SMS →', normalised);

  const res = await fetch(url, { method: 'GET' });

  let body: any;
  try {
    body = await res.json();
  } catch {
    throw new Error('Invalid JSON response from notify.lk');
  }

  // 🔴 LOG FULL RESPONSE (IMPORTANT FOR DEBUG)
  console.log('[notify.lk] Response:', body);

  // 🔴 CHECK HTTP STATUS
  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }

  // 🔴 CHECK API STATUS
  if (body.status !== 'success') {
    throw new Error(body.message || JSON.stringify(body));
  }

  console.log(`✅ SMS sent successfully → ${normalised}`);
}