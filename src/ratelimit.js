'use strict';

/**
 * A small in-memory rate limiter: at most `limit` requests per `windowMs` for each key
 * (the client IP by default). Counts live in this process, so with more than one server
 * instance each one counts separately.
 *
 * `onlyFailures` gives the request back when it succeeds, so a correct password never
 * uses up the allowance.
 */
function rateLimit({ windowMs, limit, message = 'Too many requests. Wait a few minutes and try again.', onlyFailures = false, key = (req) => req.ip }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  const limiter = (req, res, next) => {
    const k = String(key(req) || 'unknown');
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    if (entry.count >= limit) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    // Counted up front, so requests sent in parallel can't all slip past the check.
    entry.count += 1;
    if (onlyFailures) {
      res.on('finish', () => { if (res.statusCode < 400 && entry.count > 0) entry.count -= 1; });
    }
    next();
  };
  limiter.reset = () => hits.clear();
  return limiter;
}

module.exports = { rateLimit };
