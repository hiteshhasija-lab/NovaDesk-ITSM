// Required text fields for the create and edit forms. The forms mark them `required` in the
// browser; this is the same rule on the server, so a missing one is a clear 400 and not a database
// error (a 500) on a NOT NULL column.
function requireFields(req, res, fields) {
  const body = req.body || {};
  const missing = fields.filter(([name]) => typeof body[name] !== 'string' || !body[name].trim()).map(([, label]) => label);
  if (!missing.length) return true;
  res.status(400).render('error', { title: 'Missing Information', message: `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.` });
  return false;
}

module.exports = { requireFields };
