// A small in-memory limiter for the sign-in and sign-up forms (no dependency, one process).
// `countSuccess: false` counts only refused attempts (status >= 400), so a good sign-in never
// uses up the allowance of everyone behind the same office address.
function createLimiter({ windowMs, max, countSuccess = false, message }) {
  const hits = new Map();                       // key -> [timestamps]
  const recent = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return function limiter(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    if (recent(key, now).length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).render('error', { title: 'Too Many Attempts', message: message || 'Too many attempts. Please wait a few minutes and try again.' });
    }
    res.on('finish', () => {
      if (res.statusCode === 429) return;
      if (countSuccess || res.statusCode >= 400) {
        const list = recent(key, Date.now());
        list.push(Date.now());
        hits.set(key, list);
      }
    });
    next();
  };
}

// A fixed-window counter per key, with the numbers an API needs to tell a client how it is doing.
//   const w = createWindowCounter({ windowMs: 60000, max: 300 });  w.hit(key) -> { allowed, limit, remaining, resetSeconds }
// A max of 0 means "no limit". Old windows are dropped as time passes, so memory stays small.
function createWindowCounter({ windowMs, max }) {
  const windows = new Map();                      // key -> { count, resetAt }
  const timer = setInterval(() => { const now = Date.now(); for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k); }, Math.max(windowMs, 1000));
  if (timer.unref) timer.unref();
  return {
    hit(key, now = Date.now()) {
      if (!max) return { allowed: true, limit: 0, remaining: 0, resetSeconds: 0 };
      let w = windows.get(key);
      if (!w || now >= w.resetAt) { w = { count: 0, resetAt: now + windowMs }; windows.set(key, w); }
      w.count += 1;
      return { allowed: w.count <= max, limit: max, remaining: Math.max(0, max - w.count), resetSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
    },
    size: () => windows.size,
  };
}

// Every route, per address: a safety net against a runaway client or a flood. Static files and /health are left
// out. RATE_LIMIT_IP_PER_MIN sets the allowance (0 turns it off).
const UNLIMITED = /^\/(health|css\/|js\/|img\/|fonts\/|favicon)/;
function createIpLimiter({ perMinute }) {
  const counter = createWindowCounter({ windowMs: 60 * 1000, max: perMinute });
  return function ipLimiter(req, res, next) {
    if (!perMinute || UNLIMITED.test(req.path)) return next();
    const r = counter.hit(req.ip);
    if (r.allowed) return next();
    res.set('Retry-After', String(r.resetSeconds));
    if (req.path.startsWith('/scim/')) {
      return res.status(429).type('application/scim+json').send(JSON.stringify({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '429', detail: `Too many requests from this address. Try again in ${r.resetSeconds} seconds.` }));
    }
    if (req.path.startsWith('/api/')) {
      return res.status(429).json({ error: { code: 'rate_limited', message: `Too many requests from this address. Try again in ${r.resetSeconds} seconds.` } });
    }
    res.status(429).render('error', { title: 'Too Many Requests', message: 'Too many requests from this address. Please wait a moment and try again.' });
  };
}

module.exports = { createLimiter, createWindowCounter, createIpLimiter };
