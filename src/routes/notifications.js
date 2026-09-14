const express = require('express');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, requireRole('admin', 'agent'), (req, res) => {
  const notifications = db.prepare(`
    SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100
  `).all();

  res.render('notifications/list', { title: 'Notifications', notifications });
});

module.exports = router;
