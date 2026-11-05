// Custom fields, for the administrator: define the extra fields that incidents, service requests, changes, problems and
// configuration items carry. How a value is checked and stored is in src/customFields.js. Everything here is audited.
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const { audit } = require('../audit');
const cf = require('../customFields');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

async function listView(extra = {}) {
  const fields = {};
  for (const e of Object.keys(cf.ENTITIES)) fields[e] = await cf.definitions(e, { includeInactive: true });
  return { title: 'Custom fields', entities: cf.ENTITIES, types: cf.TYPES, fields, usage: await cf.usage(), limits: cf.LIMITS, form: {}, error: null, notice: null, ...extra };
}

router.get('/', async (req, res) => res.render('fields/index', await listView()));

router.post('/', async (req, res) => {
  const again = async (error) => res.status(400).render('fields/index', await listView({ error, form: req.body }));
  let clean;
  try { clean = await cf.validateNew(req.body); } catch (err) { if (err instanceof cf.FieldError) return again(err.message); throw err; }
  let id;
  try { id = await cf.create(clean); } catch (err) { if (err instanceof cf.FieldError) return again(err.message); throw err; }
  await audit(req, req.session.user, 'customfield.created', { targetType: 'custom_field', targetId: id, targetName: `${clean.entity}:${clean.key}`, detail: `${clean.label} (${clean.type}${clean.required ? ', required' : ''}${clean.audience === 'staff' ? ', staff only' : ''})` });
  res.render('fields/index', await listView({ notice: `The field "${clean.label}" was added to ${cf.ENTITIES[clean.entity].label.toLowerCase()}.` }));
});

async function editView(field, extra = {}) {
  const used = (await cf.usage()).get(field.id) || 0;
  return { title: `Custom field: ${field.label}`, field, entities: cf.ENTITIES, types: cf.TYPES, used, optionLines: cf.optionsToLines(field.options), error: null, notice: null, limits: cf.LIMITS, ...extra };
}
const find = async (req, res) => {
  const id = Number(req.params.id);
  const field = Number.isInteger(id) && id > 0 ? await cf.definition(id) : null;
  if (!field) res.status(404).render('error', { title: 'Not Found', message: 'Custom field not found.' });
  return field;
};

router.get('/:id', async (req, res) => { const f = await find(req, res); if (f) res.render('fields/edit', await editView(f)); });

router.post('/:id', async (req, res) => {
  const f = await find(req, res); if (!f) return;
  let changed;
  // A form sends nothing for a box that is not ticked, so on this form "required" and "on" are exactly whether they are ticked.
  const wanted = { label: req.body.label, help: req.body.help, audience: req.body.audience, options: req.body.options, required: req.body.required === 'on', active: req.body.active === 'on' };
  try { changed = await cf.update(f.id, wanted); } catch (err) {
    if (err instanceof cf.FieldError) return res.status(400).render('fields/edit', await editView(f, { error: err.message }));
    throw err;
  }
  if (changed.length) await audit(req, req.session.user, 'customfield.updated', { targetType: 'custom_field', targetId: f.id, targetName: `${f.entityType}:${f.key}`, detail: changed.join('; ') });
  res.render('fields/edit', await editView(await cf.definition(f.id), { notice: changed.length ? 'Saved.' : 'Nothing changed.' }));
});

router.post('/:id/move', async (req, res) => {
  const f = await find(req, res); if (!f) return;
  const dir = req.body.direction === 'up' ? 'up' : 'down';
  if (await cf.move(f.id, dir)) await audit(req, req.session.user, 'customfield.moved', { targetType: 'custom_field', targetId: f.id, targetName: `${f.entityType}:${f.key}`, detail: `moved ${dir}` });
  res.redirect(`/settings/fields#${f.entityType}`);
});

router.post('/:id/delete', async (req, res) => {
  const f = await find(req, res); if (!f) return;
  const n = await cf.remove(f.id);
  await audit(req, req.session.user, 'customfield.deleted', { targetType: 'custom_field', targetId: f.id, targetName: `${f.entityType}:${f.key}`, detail: `${f.label}; ${n} value${n === 1 ? '' : 's'} removed` });
  res.render('fields/index', await listView({ notice: `The field "${f.label}" and its ${n} stored value${n === 1 ? '' : 's'} were deleted.` }));
});

module.exports = router;
