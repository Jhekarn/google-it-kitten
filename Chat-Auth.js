// Chat-Auth.js — verifies that incoming HTTP requests really come from Google Chat.
//
// Google sends a Bearer token (OpenID Connect ID token) in the Authorization
// header of every event POST. We verify:
//   1. the token signature (via Google's public certs)
//   2. the audience = our own public endpoint URL (CHAT_APP_AUDIENCE in .env)
//   3. the issuer email = a known Google system account
//
// NOTE: apps configured in the NEW add-on style are signed by a per-project
// service account (service-<projectnumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com)
// instead of the classic chat@system.gserviceaccount.com — we accept both.
// You can pin it exactly by setting CHAT_ISSUER_EMAIL in the env.
//
// For local testing set SKIP_CHAT_VERIFICATION=1 — NEVER on the live Render deployment.

const { OAuth2Client } = require('google-auth-library');

const CLASSIC_ISSUER = 'chat@system.gserviceaccount.com';
const ADDON_ISSUER_RE = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;

const client = new OAuth2Client();

function isAllowedIssuer(email) {
  if (process.env.CHAT_ISSUER_EMAIL) return email === process.env.CHAT_ISSUER_EMAIL;
  return email === CLASSIC_ISSUER || ADDON_ISSUER_RE.test(email || '');
}

async function verifyChatRequest(req) {
  if (process.env.SKIP_CHAT_VERIFICATION === '1') {
    console.warn('⚠️  Chat request verification is SKIPPED (SKIP_CHAT_VERIFICATION=1).');
    return true;
  }

  const audience = process.env.CHAT_APP_AUDIENCE; // e.g. https://google-it-kitten.onrender.com/chat
  if (!audience) {
    console.error('❌ CHAT_APP_AUDIENCE is not set in env. Rejecting request.');
    return false;
  }

  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!bearer) {
    console.error('❌ No Bearer token on request.');
    return false;
  }

  try {
    const ticket = await client.verifyIdToken({ idToken: bearer, audience });
    const payload = ticket.getPayload();
    if (payload.email_verified && isAllowedIssuer(payload.email)) return true;
    console.error(`❌ Token issuer not allowed: ${payload.email}`);
    return false;
  } catch (err) {
    console.error('❌ Chat token verification failed:', err.message);
    return false;
  }
}

// Express middleware wrapper
function chatAuthMiddleware() {
  return async (req, res, next) => {
    const ok = await verifyChatRequest(req);
    if (!ok) return res.status(401).send('Unauthorized');
    next();
  };
}

module.exports = { verifyChatRequest, chatAuthMiddleware };
