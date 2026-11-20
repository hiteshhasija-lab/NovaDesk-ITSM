// What this workspace uses and what it is allowed (src/limits.js), for the administrator. Read only: the limits are set by the people who run the service.
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');
const limits = require('../limits');
const tenancy = require('../tenancy');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

router.get('/', async (req, res) => {
  const u = await limits.usage(tenancy.currentId());
  const rows = [
    { label: 'Active people', used: u.users.used, limit: u.users.limit, unit: '', detail: `${u.users.all - u.users.used} more switched off` },
    { label: 'Records', used: u.records.used, limit: u.records.limit, unit: '', detail: Object.entries(u.records.parts).map(([k, v]) => `${v} ${k}`).join(', ') },
    { label: 'Attached files', used: u.storage.usedMb, limit: u.storage.limit, unit: ' MB', detail: 'the files attached to incidents, requests, changes, problems and configuration items' },
  ].map((r) => ({ ...r, percent: limits.percent(r.used, r.limit) }));
  res.render('usage/index', { title: 'Plan and usage', rows });
});

module.exports = router;
