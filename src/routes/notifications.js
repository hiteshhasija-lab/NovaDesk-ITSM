const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const notifications = await db.prepare(`
    SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100
  `).all();

  res.render('notifications/list', { title: 'Notifications', notifications });
});

module.exports = router;
