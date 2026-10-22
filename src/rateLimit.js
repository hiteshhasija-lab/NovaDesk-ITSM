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

module.exports = { createLimiter };
