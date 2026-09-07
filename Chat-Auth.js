// Chat-Auth.js — verifies that incoming HTTP requests really come from Google Chat.
//
// Google Chat sends a Bearer token (OpenID Connect ID token) in the Authorization
// header of every event POST. We verify:
//   1. the token signature (via Google's public certs)
//   2. the audience  = our own public endpoint URL (CHAT_APP_AUDIENCE in .env)
//   3. the issuer email = chat@system.gserviceaccount.com
//
// Docs: https://developers.google.com/workspace/chat/verify-requests-from-chat
//
// For local testing you can set SKIP_CHAT_VERIFICATION=1 in .env — NEVER do that
// on the live Render deployment.

const { OAuth2Client } = require('google-auth-library');

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const client = new OAuth2Client();

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
  if (!bearer) return false;

  try {
    const ticket = await client.verifyIdToken({ idToken: bearer, audience });
    const payload = ticket.getPayload();
    return payload.email_verified && payload.email === CHAT_ISSUER;
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
