const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/', requireAuth, requireRole('admin', 'agent'), async (req, res) => {
  const uid = req.session.user.id;

  const myIncidents = await db.prepare(`
    SELECT i.*, u.full_name AS caller_name, c.name AS ci_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.caller_id
    LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
    WHERE i.assigned_to = ? AND i.status NOT IN ('resolved','closed','cancelled')
    ORDER BY i.priority ASC, i.created_at DESC
  `).all(uid);

  const myChanges = await db.prepare(`
    SELECT c.*, ci.name AS ci_name
    FROM changes c
    LEFT JOIN cmdb_ci ci ON ci.id = c.affected_ci_id
    WHERE c.assigned_to = ? AND c.status NOT IN ('closed','cancelled','rejected')
    ORDER BY c.planned_start ASC, c.created_at DESC
  `).all(uid);

  const pendingApprovals = await db.prepare(`
    SELECT c.*, u.full_name AS requester_name
    FROM changes c
    LEFT JOIN users u ON u.id = c.requested_by
    WHERE c.approval_status = 'pending' AND c.status NOT IN ('cancelled','rejected')
    ORDER BY c.created_at ASC
  `).all();

  res.render('mywork', { title: 'My Work', myIncidents, myChanges, pendingApprovals });
});

module.exports = router;
