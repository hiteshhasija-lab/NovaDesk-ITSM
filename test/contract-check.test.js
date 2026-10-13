'use strict';
// The contract check has to flag the mismatches it exists for and stay quiet on a consistent
// tree. Run with:  node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'contract-check.js');
function run(root, other) {
  const env = { ...process.env, NOVACONNECT_REPO: other || path.join(os.tmpdir(), 'no-such-novaconnect') };
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--json'], { encoding: 'utf8', env });
  assert.ok(r.stdout, r.stderr);
  return { status: r.status, report: JSON.parse(r.stdout) };
}
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-contract-'));
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}
const SERVER = `
const express = require('express');
const app = express();
const itemRoutes = require('./routes/items');
app.use('/items', itemRoutes);
`;
const ITEMS = `
const router = require('express').Router();
const { attachRoutes } = require('../collab');
router.get('/', (req, res) => res.render('items/list', { title: 'Items', items: [] }));
router.get('/new', (req, res) => res.render('items/form', { title: 'New', item: null }));
router.post('/', (req, res) => { const { name } = req.body; res.redirect('/items'); });
router.post('/:id/update', (req, res) => { const { name } = req.body; res.redirect('/items/' + req.params.id); });
router.get('/:id', (req, res) => res.render('items/show', { title: 'Item', item: { id: 1 } }));
router.delete('/:id', (req, res) => res.redirect('/items'));
attachRoutes(router, 'items');
module.exports = router;
`;
const COLLAB = `
function attachRoutes(router, entityType) {
  router.post('/:id/attachments', (req, res) => res.redirect('/items'));
  router.get('/:id/attachments/:attId/download', (req, res) => res.send('x'));
}
module.exports = { attachRoutes };
`;
const base = (over = {}) => ({
  'src/server.js': SERVER,
  'src/routes/items.js': ITEMS,
  'src/collab.js': COLLAB,
  'views/partials/head.ejs': '<head><title><%= title %></title></head>',
  'views/items/list.ejs': `<%- include('../partials/head') %><a href="/items/new">New</a><% items.forEach(function(i){ %><a href="/items/<%= i.id %>"><%= i.name %></a><% }) %>`,
  'views/items/form.ejs': `<%- include('../partials/head') %><form method="POST" action="<%= item ? '/items/' + item.id + '/update' : '/items' %>"><input name="name"></form>`,
  'views/items/show.ejs': `<%- include('../partials/head') %><form method="POST" action="/items/<%= item.id %>?_method=DELETE"></form>
<form method="POST" action="/items/<%= item.id %>/attachments" enctype="multipart/form-data"><input type="file" name="file"></form>
<a href="/items/<%= item.id %>/attachments/1/download">file</a><%= typeof q !== 'undefined' ? q : '' %>`,
  ...over,
});

test('a consistent tree passes (helper-registered routes, ?_method override, typeof guards)', () => {
  const { status, report } = run(tree(base()));
  assert.deepStrictEqual(report.errors, []);
  assert.strictEqual(status, 0);
  assert.ok(report.checked.routes >= 8 && report.checked.forms >= 3);
});

test('flags a form posting to a route that does not exist', () => {
  const { report } = run(tree(base({ 'views/items/form.ejs': `<%- include('../partials/head') %><form method="POST" action="/items/<%= item ? item.id : 0 %>/rename"></form>` })));
  assert.ok(report.errors.some((e) => e.kind === 'no-route' && /rename/.test(e.detail)), JSON.stringify(report.errors));
});

test('flags a method the route does not serve, including ?_method', () => {
  const { report } = run(tree(base({ 'views/items/show.ejs': `<%- include('../partials/head') %><form method="POST" action="/items/<%= item.id %>?_method=PUT"></form>` })));
  assert.ok(report.errors.some((e) => e.kind === 'wrong-method'), JSON.stringify(report.errors));
});

test('flags a view variable the route does not pass, also through a partial', () => {
  const direct = run(tree(base({ 'views/items/list.ejs': `<%- include('../partials/head') %><%= heading %>` })));
  assert.ok(direct.report.errors.some((e) => e.kind === 'view-undefined-variable' && /heading/.test(e.detail)), JSON.stringify(direct.report.errors));
  const viaPartial = run(tree(base({ 'views/partials/head.ejs': '<head><%= siteName %></head>' })));
  assert.ok(viaPartial.report.errors.some((e) => /siteName/.test(e.detail)), JSON.stringify(viaPartial.report.errors));
});

test('include data counts as passed, and a hidden _method field is flagged', () => {
  const withData = `<%- include('../partials/head', { siteName: 'x' }) %>`;
  const ok = run(tree(base({
    'views/partials/head.ejs': '<head><%= siteName %></head>',
    'views/items/list.ejs': withData + '<% items.length %>',
    'views/items/form.ejs': withData,
    'views/items/show.ejs': withData,
  })));
  assert.deepStrictEqual(ok.report.errors, []);
  const hidden = run(tree(base({ 'views/items/show.ejs': `<%- include('../partials/head') %><form method="POST" action="/items/1"><input type="hidden" name="_method" value="DELETE"></form>` })));
  assert.ok(hidden.report.errors.some((e) => e.kind === 'method-override'), JSON.stringify(hidden.report.errors));
});

test('flags a redirect to a page nothing serves and a render of a missing view', () => {
  const { report } = run(tree(base({
    'src/routes/items.js': ITEMS.replace("router.delete('/:id', (req, res) => res.redirect('/items'));", "router.delete('/:id', (req, res) => res.redirect('/elsewhere/' + req.params.id));\nrouter.get('/x', (req, res) => res.render('items/missing', {}));"),
  })));
  const kinds = report.errors.map((e) => e.kind).sort();
  assert.deepStrictEqual(kinds, ['redirect-no-route', 'render-no-view']);
});

test('flags a template helper that src/helpers.js does not export', () => {
  const { report } = run(tree(base({
    'src/helpers.js': 'module.exports = { fmtDate: (d) => d };',
    'views/items/list.ejs': `<%- include('../partials/head') %><%= h.fmtDate(1) %><%= h.fmtDat(2) %><% items.length %>`,
    'views/items/form.ejs': `<%- include('../partials/head') %>`,
    'views/items/show.ejs': `<%- include('../partials/head') %>`,
  })));
  const e = report.errors.filter((x) => x.kind === 'view-unknown-helper');
  assert.strictEqual(e.length, 1, JSON.stringify(report.errors));
  assert.match(e[0].detail, /h\.fmtDat\b/);
});

test('NovaDesk <-> NovaConnect: URL, method and the keys read from the answer are checked', () => {
  const connect = (extra = '') => tree({
    'src/server.js': `const app = require('express')();\nconst inbound = require('./routes/integrationsIn');\napp.use('/api/integrations', inbound);`,
    'src/routes/integrationsIn.js': `const router = require('express').Router();
router.post('/novadesk/decom-updates', (req, res) => { const { channel_id, body } = req.body; res.json({ ok: true, keyed: false }); });
${extra}
module.exports = router;`,
    'src/decomFlow.js': `async function go(){ const { change } = await callNovaDesk('/api/integrations/novaconnect/decommission-requests/5/approve', { acting_user: 1 }); }`,
  });
  const desk = (call) => tree(base({
    'src/novaconnect.js': `async function push(){ await postToNovaConnect(${call}); }`,
    'src/routes/integrations.js': `const router = require('express').Router();
router.post('/novaconnect/decommission-requests/:id/approve', (req, res) => res.json({ ok: true, other: 1 }));
module.exports = router;`,
    'src/server.js': SERVER + `\napp.use('/api/integrations', require('./routes/integrations'));`,
  }));
  const good = run(desk(`'/api/integrations/novadesk/decom-updates', { channel_id: 1, body: 'x' }`), connect());
  assert.ok(!good.report.errors.some((e) => e.kind === 'cross-no-route' && /novadesk\/decom-updates/.test(e.detail)), JSON.stringify(good.report.errors));
  const missing = run(desk(`'/api/integrations/novadesk/decom-update', { channel_id: 1 }`), connect());
  assert.ok(missing.report.errors.some((e) => e.kind === 'cross-no-route'), JSON.stringify(missing.report.errors));
  // callNovaDesk reads `change`, which the NovaDesk route does not answer with
  assert.ok(good.report.errors.some((e) => e.kind === 'cross-response-keys' && /change/.test(e.detail)), JSON.stringify(good.report.errors));
});

test('this repository has no contract errors', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(r.stdout);
  assert.deepStrictEqual(report.errors, []);
  assert.strictEqual(r.status, 0);
});
