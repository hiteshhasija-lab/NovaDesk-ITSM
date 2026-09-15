const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const isEndUser = req.session.user.role === 'user';
  const uid = req.session.user.id;

  const isStaff = ['admin', 'agent'].includes(req.session.user.role);

  let incidents = [];
  let changes = [];
  let cis = [];
  let problems = [];
  let requests = [];
  let articles = [];

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
      WHERE name LIKE ? OR ci_number LIKE ? OR ip_address LIKE ?
      ORDER BY name LIMIT 15
    `).all(like, like, like);

    if (isStaff) {
      problems = db.prepare(`
        SELECT p.*, c.name AS ci_name
        FROM problems p
        LEFT JOIN cmdb_ci c ON c.id = p.affected_ci_id
        WHERE p.number LIKE ? OR p.short_description LIKE ? OR c.name LIKE ? OR c.ci_number LIKE ?
        ORDER BY p.created_at DESC LIMIT 15
      `).all(like, like, like, like);
    }

    const requestParams = isEndUser ? [like, like, uid] : [like, like];
    requests = db.prepare(`
      SELECT r.*, ci.name AS item_name, ci.icon AS item_icon
      FROM service_requests r
      LEFT JOIN catalog_items ci ON ci.id = r.catalog_item_id
      WHERE (r.number LIKE ? OR ci.name LIKE ?) ${isEndUser ? 'AND r.requested_by = ?' : ''}
      ORDER BY r.created_at DESC LIMIT 15
    `).all(...requestParams);

    articles = db.prepare(`
      SELECT * FROM kb_articles
      WHERE (title LIKE ? OR body LIKE ?) ${isStaff ? '' : "AND status = 'published'"}
      ORDER BY updated_at DESC LIMIT 15
    `).all(like, like);
  }

  res.render('search', { title: q ? `Search: ${q}` : 'Search', q, incidents, changes, cis, problems, requests, articles, isStaff });
});

module.exports = router;
