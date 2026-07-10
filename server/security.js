// Anti-spam for auth endpoints: per-IP rate limiting (in-memory — fine for a
// single instance) and optional Google reCAPTCHA v2 verification that switches
// on when RECAPTCHA_SECRET / RECAPTCHA_SITE_KEY app settings are present.

const buckets = new Map(); // "name:ip" -> [timestamps]

// Sliding-window limiter: allow `limit` hits per `windowSec` per IP.
function rateLimit(name, limit, windowSec) {
  return (req, res, next) => {
    const key = name + ':' + req.ip;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter(t => now - t < windowSec * 1000);
    if (hits.length >= limit) {
      return res.status(429).json({ error: 'Slow down, git. Too many tries — come back later.' });
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

// prune idle buckets so memory can't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    const live = hits.filter(t => now - t < 3600 * 1000);
    if (live.length === 0) buckets.delete(key);
    else buckets.set(key, live);
  }
}, 10 * 60 * 1000).unref();

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '';
const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || '';

// Returns true when the captcha passes, or when reCAPTCHA isn't configured
// (rate limiting + honeypot still apply either way). Handles both v3
// (score-based, what the club's keys are) and v2 (no score field).
const MIN_SCORE = 0.3; // v3 scores: ~0.9 human, ~0.1 bot

async function verifyCaptcha(token, ip) {
  if (!RECAPTCHA_SECRET) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: ip || '' }),
    });
    const data = await res.json();
    if (!data.success) return false;
    if (typeof data.score === 'number' && data.score < MIN_SCORE) return false;
    if (data.action && data.action !== 'register') return false;
    return true;
  } catch {
    return false; // Google unreachable -> fail closed on signups
  }
}

module.exports = { rateLimit, verifyCaptcha, RECAPTCHA_SITE_KEY };
