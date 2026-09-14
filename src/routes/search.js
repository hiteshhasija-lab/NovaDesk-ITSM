const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;

  let incidents = [];
  let changes = [];
  let cis = [];

  if (q) {
    const like = `%${q}%`;

    const incidentParams = isEndUser ? [like, like, uid] : [like, like];
    incidents = db.prepare(`
      SELECT i.*, c.name AS ci_name
      FROM incidents i
      LEFT JOIN cmdb_ci c ON c.id = i.affected_ci_id
      WHERE (i.number LIKE ? OR i.short_description LIKE ?) ${isEndUser ? 'AND i.caller_id = ?' : ''}
      ORDER BY i.created_at DESC LIMIT 15
    `).all(...incidentParams);

    const changeParams = isEndUser ? [like, like, uid] : [like, like];
    changes = db.prepare(`
      SELECT c.*
      FROM changes c
      WHERE (c.number LIKE ? OR c.short_description LIKE ?) ${isEndUser ? 'AND c.requested_by = ?' : ''}
      ORDER BY c.created_at DESC LIMIT 15
    `).all(...changeParams);

    cis = db.prepare(`
      SELECT * FROM cmdb_ci
      WHERE name LIKE ? OR ci_number LIKE ? OR ip_address LIKE ? OR serial_number LIKE ?
      ORDER BY name LIMIT 15
    `).all(like, like, like, like);
  }

  res.render('search', { title: q ? `Search: ${q}` : 'Search', q, incidents, changes, cis });
});

module.exports = router;
