#!/usr/bin/env node
// Contract check for NovaDesk. Static (no server, no database), so it runs in a second.
//
//   node scripts/contract-check.js                 # check this repository
//   node scripts/contract-check.js --root DIR      # check another checkout (used by tests)
//   node scripts/contract-check.js --json          # machine readable report
//   node scripts/contract-check.js --list-routes   # every route with the body fields its handler reads
//   NOVACONNECT_REPO=/path/to/NovaConnect          # also check the NovaDesk <-> NovaConnect calls
//                                                  # (default: a sibling ../NovaConnect if present)
//
// NovaDesk is a server-rendered app, so its contracts are:
//   1. Views -> routes: every form action, link and fetch() in views/*.ejs reaches a route that
//      serves that method (method-override `?_method=PUT` included), and form fields are read.
//   2. Routes -> routes: every res.redirect() target is a real GET route.
//   3. Routes -> views: every res.render() names an existing view, and every variable a view uses
//      (through its partials) is passed by the route, set in res.locals, or declared in the view.
//      A missing one is a ReferenceError, i.e. a 500 page, only on that code path.
//   4. NovaDesk <-> NovaConnect: the integration calls in both directions (URL, method, body keys,
//      keys read from the answer) match the routes on the other side.
//
// Exit code 1 on any error. Warnings never fail the run.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : path.join(__dirname, '..'));
const OTHER_ENV = process.env.NOVACONNECT_REPO;
const OTHER = OTHER_ENV ? path.resolve(OTHER_ENV) : path.resolve(ROOT, '..', 'NovaConnect');

function load(name) {
  // acorn is not a NovaDesk dependency (and the image must not grow): use this checkout's copy if
  // there is one, else the sibling NovaConnect checkout's (which pins it as a devDependency).
  const dirs = [ROOT, path.resolve(__dirname, '..'), OTHER, path.resolve(__dirname, '..', '..', 'NovaConnect')];
  for (const d of dirs) { try { return require(path.join(d, 'node_modules', name)); } catch (e) { /* next */ } }
  try { return require(name); } catch (e) {
    console.error(`contract-check needs "${name}": run  npm install --no-save ${name}@8.18.0  in this repository, or put a NovaConnect checkout next to it.`);
    process.exit(2);
  }
}
const acorn = load('acorn');
const ejs = load('ejs');

// ------------------------------------------------------------------ AST helpers
function parse(code) {
  const base = { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, allowHashBang: true };
  try { return acorn.parse(code, { ...base, sourceType: 'script' }); } catch (e) { return acorn.parse(code, { ...base, sourceType: 'module' }); }
}
function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parents) === false) return;
  parents.push(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, parents));
    else if (v && typeof v.type === 'string') walk(v, visit, parents);
  }
  parents.pop();
}
const isFn = (n) => n && /Function/.test(n.type);
const keyName = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' ? String(k.value) : null);
const listFiles = (dir, ext) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return f === 'node_modules' || f === 'experiments' ? [] : listFiles(p, ext);
    return f.endsWith(ext) ? [p] : [];
  });
};
const rel = (root, f) => path.relative(root, f);

// ------------------------------------------------------------------ answer shapes (res.json(variable), helper returns)
function makeShapes(asts) {
  const fnIndex = new Map();
  const add = (n, fn) => { if (!fnIndex.has(n)) fnIndex.set(n, []); fnIndex.get(n).push(fn); };
  for (const ast of asts.values()) {
    walk(ast, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id) add(n.id.name, n);
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFn(n.init)) add(n.id.name, n.init);
      if (n.type === 'Property' && keyName(n.key) && isFn(n.value)) add(keyName(n.key), n.value);
    });
  }
  const fresh = () => ({ keys: new Set(), array: false, dynamic: false });
  const merge = (a, b) => { b.keys.forEach((k) => a.keys.add(k)); a.array = a.array || b.array; a.dynamic = a.dynamic || b.dynamic; };
  function shapeOf(expr, scope, depth, seen) {
    const out = fresh();
    if (!expr || depth > 4) { out.dynamic = true; return out; }
    switch (expr.type) {
      case 'AwaitExpression': return shapeOf(expr.argument, scope, depth, seen);
      case 'ObjectExpression':
        for (const pr of expr.properties) { if (pr.type === 'SpreadElement') out.dynamic = true; else { const k = keyName(pr.key); if (k) out.keys.add(k); } }
        return out;
      case 'ArrayExpression': out.array = true; return out;
      case 'ConditionalExpression': merge(out, shapeOf(expr.consequent, scope, depth, seen)); merge(out, shapeOf(expr.alternate, scope, depth, seen)); return out;
      case 'LogicalExpression': merge(out, shapeOf(expr.left, scope, depth, seen)); merge(out, shapeOf(expr.right, scope, depth, seen)); return out;
      case 'Identifier': {
        let decl = null;
        const assigned = [];
        walk(scope, (m) => {
          if (m.type === 'VariableDeclarator' && m.id.type === 'Identifier' && m.id.name === expr.name && m.init) decl = m.init;
          if (m.type === 'AssignmentExpression' && m.left.type === 'MemberExpression' && m.left.object.type === 'Identifier' && m.left.object.name === expr.name && !m.left.computed) assigned.push(m.left.property.name);
        });
        if (!decl) { out.dynamic = true; return out; }
        const s = shapeOf(decl, scope, depth + 1, seen);
        assigned.forEach((k) => s.keys.add(k));
        return s;
      }
      case 'CallExpression': {
        const c = expr.callee;
        const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed ? c.property.name : null);
        if (name && /^(map|filter|slice|sort|concat|reverse|all)$/.test(name)) { out.array = true; return out; }
        const fns = name ? fnIndex.get(name) : null;
        if (!fns || !fns.length || seen.has(name)) { out.dynamic = true; return out; }
        seen.add(name);
        for (const fn of fns) merge(out, returnShape(fn, depth + 1, seen));
        seen.delete(name);
        return out;
      }
      default: out.dynamic = true; return out;
    }
  }
  function returnShape(fn, depth, seen) {
    if (fn.body.type !== 'BlockStatement') return shapeOf(fn.body, fn, depth, seen);
    const out = fresh();
    let any = false;
    walk(fn.body, (n) => {
      if (n !== fn.body && isFn(n)) return false;
      if (n.type === 'ReturnStatement') { any = true; merge(out, n.argument ? shapeOf(n.argument, fn, depth, seen) : fresh()); }
      return true;
    });
    if (!any) out.dynamic = true;
    return out;
  }
  return { shapeOf, fresh, merge, fnIndex };
}

// ------------------------------------------------------------------ route table of a checkout
function exprToPath(n) {
  if (!n) return ':~';
  if (n.type === 'Literal') return String(n.value);
  if (n.type === 'TemplateLiteral') { let s = ''; n.quasis.forEach((q, i) => { s += q.value.cooked; if (i < n.expressions.length) s += ':p'; }); return s; }
  if (n.type === 'BinaryExpression' && n.operator === '+') return exprToPath(n.left) + exprToPath(n.right);
  if (n.type === 'ConditionalExpression') return exprToPath(n.consequent);
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && /encodeURIComponent|Number|String/.test(n.callee.name)) return ':p';
  return ':~';
}
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function buildRoutes(root) {
  const srcDir = path.join(root, 'src');
  const files = listFiles(srcDir, '.js');
  const asts = new Map(files.map((f) => [f, parse(fs.readFileSync(f, 'utf8'))]));
  const shapes = makeShapes(asts);
  // mounts: app.use('/prefix', ..., <router>) where <router> is bound with require('./routes/x')
  const mounts = new Map();
  const serverAst = asts.get(path.join(srcDir, 'server.js'));
  if (serverAst) {
    const requires = new Map();
    const modOf = (n) => {
      let cur = n;
      while (cur && (cur.type === 'CallExpression' || cur.type === 'MemberExpression')) {
        if (cur.type === 'CallExpression' && cur.callee.type === 'Identifier' && cur.callee.name === 'require' && cur.arguments[0] && cur.arguments[0].type === 'Literal') return String(cur.arguments[0].value);
        cur = cur.type === 'CallExpression' ? cur.callee : cur.object;
      }
      return null;
    };
    walk(serverAst, (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init) { const m = modOf(n.init); if (m && m.startsWith('.')) requires.set(n.id.name, m); } });
    walk(serverAst, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.object.name !== 'app' || n.callee.property.name !== 'use') return;
      const a = n.arguments;
      const prefix = a[0] && a[0].type === 'Literal' && typeof a[0].value === 'string' ? a[0].value : '/';
      const last = a[a.length - 1];
      const mod = last.type === 'Identifier' ? requires.get(last.name) : modOf(last);
      if (!mod || !mod.startsWith('.')) return;
      const key = path.normalize(mod).replace(/\.js$/, '');
      if (!mounts.has(key)) mounts.set(key, []);
      mounts.get(key).push(prefix);
    });
  }
  const table = [];
  const unmounted = new Set();
  // helpers such as attachRoutes(router, 'changes') register routes on the router they are given
  const helperFns = new Set();
  for (const ast of asts.values()) {
    walk(ast, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || !n.arguments[0] || n.arguments[0].type !== 'Identifier' || n.arguments[0].name !== 'router') return;
      (shapes.fnIndex.get(n.callee.name) || []).forEach((fn) => helperFns.add(fn));
    });
  }
  const add = (prefixes, file, line, method, p, handler) => {
    const info = summarise(handler, shapes);
    for (const pre of prefixes) {
      const full = (pre === '/' ? '' : pre) + (p.startsWith('/') ? p : '/' + p);
      table.push({ method: method.toUpperCase(), path: full || '/', where: `${rel(root, file)}:${line}`, ...info });
    }
  };
  const routeOf = (n, objNames) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return null;
    const obj = n.callee.object, prop = n.callee.property;
    if (!obj || obj.type !== 'Identifier' || !objNames.includes(obj.name) || !METHODS.has(prop.name)) return null;
    const a0 = n.arguments[0];
    let p = null;
    if (a0 && a0.type === 'Literal' && typeof a0.value === 'string') p = a0.value;
    else if (a0 && a0.type === 'TemplateLiteral') p = a0.quasis.map((q) => q.value.cooked).join(':~');
    if (p === null) return null;
    return { method: prop.name, path: p, handler: [...n.arguments].reverse().find(isFn) || null };
  };
  for (const [file, ast] of asts) {
    const relMod = path.relative(srcDir, file).replace(/\.js$/, '');
    const prefixes = mounts.get(relMod) || (relMod === 'server' ? ['/'] : null);
    walk(ast, (n, parents) => {
      if (parents.some((p) => helperFns.has(p))) return;                    // registered through a helper, below
      const r = routeOf(n, ['router', 'app']);
      if (!r) {
        // fn(router, ...) -> the routes that fn registers, under this file's prefixes
        if (prefixes && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.arguments[0] && n.arguments[0].type === 'Identifier' && n.arguments[0].name === 'router') {
          for (const fn of shapes.fnIndex.get(n.callee.name) || []) {
            const param = fn.params[0] && fn.params[0].type === 'Identifier' ? fn.params[0].name : null;
            if (!param) continue;
            walk(fn.body, (m) => { const hr = routeOf(m, [param]); if (hr) add(prefixes, file, m.loc.start.line, hr.method, hr.path, hr.handler); });
          }
        }
        return;
      }
      if (!prefixes) { unmounted.add(rel(root, file)); return; }
      add(prefixes, file, n.loc.start.line, r.method, r.path, r.handler);
    });
  }
  return { table, unmounted, asts, shapes, files };
}
function readBodyNode(n, parents, reqName, res) {
  if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === reqName && n.property.name === 'body' && !n.computed) {
    const parent = parents[parents.length - 1];
    if (parent && parent.type === 'MemberExpression' && parent.object === n && !parent.computed) res.bodyKeys.add(parent.property.name);
    else if (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern' && parent.init === n) {
      for (const pr of parent.id.properties) { if (pr.type === 'RestElement') res.bodyOpaque = true; else { const k = keyName(pr.key); if (k) res.bodyKeys.add(k); } }
    } else if (parent && parent.type === 'LogicalExpression') { /* req.body && req.body.x: the member read is found on its own */ }
    else res.bodyOpaque = true;      // req.body passed whole to a helper, spread, indexed...
  }
}
function readBody(body, reqName, res, shapes, depth, seen) {
  walk(body, (n, parents) => {
    readBodyNode(n, parents, reqName, res);
    if (depth < 3 && n.type === 'CallExpression') {
      n.arguments.forEach((a, i) => {
        if (a.type !== 'Identifier' || a.name !== reqName) return;
        const name = n.callee.type === 'Identifier' ? n.callee.name : null;
        if (!name || seen.has(name)) return;
        for (const fn of shapes.fnIndex.get(name) || []) {
          const prm = fn.params[i] && fn.params[i].type === 'Identifier' ? fn.params[i].name : null;
          if (prm) readBody(fn.body, prm, res, shapes, depth + 1, new Set([...seen, name]));
        }
      });
    }
    return true;
  });
}
function summarise(h, shapes) {
  const res = { keys: new Set(), array: false, dynamic: false, json: false, bodyKeys: new Set(), bodyOpaque: false, renders: [], redirects: [] };
  if (!h) { res.dynamic = true; res.bodyOpaque = true; return res; }
  walk(h.body, (n, parents) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') {
      const m = n.callee.property.name;
      if (m === 'json') { res.json = true; const s = shapes.shapeOf(n.arguments[0], h, 0, new Set()); shapes.merge(res, s); }
      if (m === 'render' && n.arguments[0] && n.arguments[0].type === 'Literal') res.renders.push({ view: String(n.arguments[0].value), locals: n.arguments[1] || null, scope: h, line: n.loc.start.line });
      if (m === 'redirect') res.redirects.push({ arg: n.arguments[n.arguments.length - 1], line: n.loc.start.line });
    }
    if (n.type === 'CallExpression') {
      // a helper that is handed `req` (or req.body) reads body keys on the route's behalf
      n.arguments.forEach((a, i) => {
        const whole = a.type === 'Identifier' && a.name === 'req';
        if (!whole) return;
        const name = n.callee.type === 'Identifier' ? n.callee.name : (n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : null);
        for (const fn of (name && shapes.fnIndex.get(name)) || []) {
          const prm = fn.params[i] && fn.params[i].type === 'Identifier' ? fn.params[i].name : null;
          if (prm) readBody(fn.body, prm, res, shapes, 1, new Set([name]));
        }
      });
    }
    readBodyNode(n, parents, 'req', res);
    return true;
  });
  return res;
}

// ------------------------------------------------------------------ matching
const segs = (p) => p.split(/[?#]/)[0].replace(/\/+$/, '').split('/');
const segMatches = (route, client) => {
  if (route.startsWith(':') || client.startsWith(':')) return true;
  const i = client.indexOf(':~');
  return i > 0 ? route === client.slice(0, i) : route === client;
};
function matchRoutes(table, clientPath) {
  let c = segs(clientPath);
  const tailOnly = c[0] === ':~';
  if (tailOnly) c = c.slice(1);
  return table.filter((r) => {
    const s = segs(r.path);
    if (tailOnly ? s.length <= c.length : s.length !== c.length) return false;
    const tail = tailOnly ? s.slice(s.length - c.length) : s;
    return tail.every((seg, i) => segMatches(seg, c[i]));
  });
}

// ------------------------------------------------------------------ the checks
const errors = [];
const warnings = [];
const add = (list, kind, where, detail) => list.push({ kind, where, detail });
const mine = buildRoutes(ROOT);
const viewsDir = path.join(ROOT, 'views');
const publicDir = path.join(ROOT, 'public');
const viewFiles = listFiles(viewsDir, '.ejs');
for (const f of mine.unmounted) add(warnings, 'unmounted', f, 'defines routes but is not mounted in server.js');

if (args.includes('--list-routes')) {
  for (const r of mine.table) console.log(`${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.where.padEnd(28)} body: ${r.bodyOpaque ? '(whole body)' : [...r.bodyKeys].join(',')}`);
  process.exit(0);
}

// -- 1. views -> routes -------------------------------------------------
const ejsTag = /<%[=\-_#]?([\s\S]*?)[-_]?%>/g;
function candidatesFor(value) {
  // value of an attribute that may hold EJS output: returns candidate client paths
  const whole = value.match(/^\s*<%[=-]\s*([\s\S]*?)\s*%>\s*$/);
  if (whole) {
    try {
      const e = acorn.parseExpressionAt(whole[1], 0, { ecmaVersion: 'latest' });
      const out = [];
      const visit = (n) => { if (n.type === 'ConditionalExpression') { visit(n.consequent); visit(n.alternate); } else if (n.type === 'LogicalExpression') { visit(n.right); } else out.push(exprToPath(n)); };
      visit(e);
      return out;
    } catch (err) { return [':~']; }
  }
  return [value.replace(ejsTag, ':p')];
}
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? (m[2] !== undefined ? m[2] : m[3]) : null;
}
const isInternal = (p) => p.startsWith('/') && !p.startsWith('//');
const isStatic = (p) => {
  const clean = p.split(/[?#]/)[0];
  return /^\/(css|img|js|fonts)\//.test(clean) || fs.existsSync(path.join(publicDir, clean));
};
function checkTarget(where, method, p, extra = {}) {
  const hits = matchRoutes(mine.table, p);
  if (!hits.length) { add(errors, 'no-route', where, `${method} ${p.split('?')[0]} matches no route`); return null; }
  const exact = hits.filter((r) => r.method === method);
  if (!exact.length) { add(errors, 'wrong-method', where, `${p.split('?')[0]} is served only as ${[...new Set(hits.map((r) => r.method))].join('/')}, the view uses ${method}`); return null; }
  return exact;
}
let formCount = 0, linkCount = 0, fetchCount = 0;
for (const file of viewFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const relFile = rel(ROOT, file);
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  // forms
  for (const m of text.matchAll(/<form\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    const tag = m[0];
    const method = (attr(tag, 'method') || 'GET').toUpperCase();
    const action = attr(tag, 'action');
    if (action === null) continue;                 // submits to the page it is on; checked as a link elsewhere
    formCount++;
    const end = text.indexOf('</form>', m.index);
    const inner = text.slice(m.index, end === -1 ? undefined : end);
    const fields = new Set();
    for (const im of inner.matchAll(/<(?:input|select|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      const nm = attr(im[0], 'name');
      if (nm && !/<%/.test(nm) && !/\stype\s*=\s*["']file["']/.test(im[0])) fields.add(nm);   // file inputs travel as multipart, not in req.body
    }
    for (const cand of candidatesFor(action)) {
      if (!isInternal(cand) || isStatic(cand)) continue;
      const q = cand.match(/[?&]_method=(\w+)/);
      const eff = q ? q[1].toUpperCase() : method;
      const where = `${relFile}:${lineAt(m.index)}`;
      const hit = checkTarget(where, eff, cand);
      if (hit && eff !== 'GET' && hit.length === 1) {
        const r = hit[0];
        const unread = [...fields].filter((f) => f !== '_method' && !r.bodyKeys.has(f));
        if (!r.bodyOpaque && unread.length) add(warnings, 'form-field-unread', where, `form sends ${unread.join(', ')}; ${r.method} ${r.path} (${r.where}) reads ${[...r.bodyKeys].join(', ') || 'nothing'}`);
      }
    }
    if (/<input[^>]*name\s*=\s*"_method"/.test(inner)) add(errors, 'method-override', `${relFile}:${lineAt(m.index)}`, 'a hidden _method field is not honoured: server.js reads _method from the query string only');
  }
  // links
  for (const m of text.matchAll(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    const href = attr(m[0], 'href');
    if (!href) continue;
    for (const cand of candidatesFor(href)) {
      if (!isInternal(cand) || isStatic(cand) || cand.startsWith('/#')) continue;
      linkCount++;
      checkTarget(`${relFile}:${lineAt(m.index)}`, 'GET', cand);
    }
  }
  // inline scripts: fetch('/x/' + id + '/status', { method: 'POST', body: JSON.stringify({...}) })
  for (const m of text.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const code = m[1].replace(ejsTag, (all, body) => (all.startsWith('<%=') || all.startsWith('<%-') ? '0' : ''));
    let ast;
    try { ast = parse(code); } catch (e) { continue; }
    const base = lineAt(m.index);
    walk(ast, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'fetch') return;
      const p = exprToPath(n.arguments[0]);
      if (!isInternal(p)) return;
      fetchCount++;
      let method = 'GET';
      const opts = n.arguments[1];
      if (opts && opts.type === 'ObjectExpression') {
        const mp = opts.properties.find((pr) => pr.type === 'Property' && keyName(pr.key) === 'method');
        if (mp && mp.value.type === 'Literal') method = String(mp.value.value).toUpperCase();
      }
      checkTarget(`${relFile}:${base + n.loc.start.line - 1}`, method, p);
    });
  }
}

// -- 2. redirects -------------------------------------------------------
const seenRedirect = new Set();
for (const r of mine.table) {
  for (const d of r.redirects) {
    const p = exprToPath(d.arg);
    const key = `${r.where}:${d.line}`;
    if (seenRedirect.has(key)) continue;
    seenRedirect.add(key);
    if (!isInternal(p) || /^:~/.test(p.replace(/^\//, ''))) continue;
    const hits = matchRoutes(mine.table, p);
    if (!hits.some((h) => h.method === 'GET')) add(errors, 'redirect-no-route', `${r.where.split(':')[0]}:${d.line}`, `redirects to ${p.split('?')[0]}, which no GET route serves`);
  }
}

// -- 3. routes -> views: every variable a view uses has to be provided --------------------
const globalLocals = new Set(['h', 'path', 'currentUser']);
for (const ast of mine.asts.values()) {
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'MemberExpression' &&
        ['locals'].includes(n.left.object.property.name) && !n.left.computed) globalLocals.add(n.left.property.name);
  });
}
const EJS_INTERNAL = new Set(['locals', 'escapeFn', 'include', 'rethrow', '__line', '__lines', '__filename', '__output', '__append', 'undefined', 'NaN', 'Infinity', 'arguments',
  'Math', 'JSON', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Intl', 'RegExp', 'Set', 'Map', 'Error', 'console', 'process', 'require',
  'window', 'document', 'URL', 'URLSearchParams', 'Symbol', 'Promise', 'isFinite', 'escape']);
const viewInfo = new Map();     // view name -> { free:Set, includes:[{view, keys:Set|null}], file }
function inspectView(name) {
  if (viewInfo.has(name)) return viewInfo.get(name);
  const file = path.join(viewsDir, name.endsWith('.ejs') ? name : name + '.ejs');
  if (!fs.existsSync(file)) { viewInfo.set(name, null); return null; }
  const info = { free: new Map(), includes: [], helperUses: new Map(), file };
  viewInfo.set(name, info);
  const t = new ejs.Template(fs.readFileSync(file, 'utf8'), { filename: file, compileDebug: false });
  t.generateSource();
  let ast;
  try { ast = parse(`(function(){${t.source}})`); } catch (e) { info.parseError = e.message; return info; }
  const declared = new Set();
  const refs = [];
  const guarded = new Set();
  walk(ast, (n, parents) => {
    if (n.type === 'VariableDeclarator') walk(n.id, (m) => { if (m.type === 'Identifier') declared.add(m.name); });
    if (n.type === 'FunctionDeclaration' && n.id) declared.add(n.id.name);
    if (isFn(n)) n.params.forEach((p) => walk(p, (m) => { if (m.type === 'Identifier') declared.add(m.name); }));
    if (n.type === 'CatchClause' && n.param) walk(n.param, (m) => { if (m.type === 'Identifier') declared.add(m.name); });
    if (n.type === 'UnaryExpression' && n.operator === 'typeof' && n.argument.type === 'Identifier') guarded.add(n.argument.name);   // `typeof q !== 'undefined' ? q : ''` makes every use of q safe
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'include' && n.arguments[0]) {
      const p = n.arguments[0];
      const data = n.arguments[1];
      info.includes.push({ view: p.type === 'Literal' ? String(p.value) : null, keys: data ? (data.type === 'ObjectExpression' && !data.properties.some((x) => x.type === 'SpreadElement') ? new Set(data.properties.map((x) => keyName(x.key)).filter(Boolean)) : null) : new Set() });
    }
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'h') {
      if (!info.helperUses.has(n.property.name)) info.helperUses.set(n.property.name, n.loc.start.line);
    }
    if (n.type === 'Identifier') {
      const parent = parents[parents.length - 1];
      if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return true;
      if (parent && parent.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return true;
      if (parent && parent.type === 'VariableDeclarator' && parent.id === n) return true;
      if (parent && /^(Function|Arrow)/.test(parent.type) && parent.params.includes(n)) return true;
      refs.push(n);
    }
    return true;
  });
  for (const r of refs) {
    if (declared.has(r.name) || EJS_INTERNAL.has(r.name) || guarded.has(r.name)) continue;
    if (!info.free.has(r.name)) info.free.set(r.name, []);
    info.free.get(r.name).push(r.loc.start.line);
  }
  return info;
}
// variables used by a view and, through include(), by its partials; `have` grows with include data
function missingFor(name, have, seen = new Set(), trail = []) {
  const info = inspectView(name);
  const out = [];
  if (!info || seen.has(name)) return out;
  seen.add(name);
  for (const v of info.free.keys()) if (!have.has(v)) out.push({ name: v, view: name });
  for (const inc of info.includes) {
    if (!inc.view) continue;
    const incName = inc.view.replace(/^\.\//, '');
    const resolved = fs.existsSync(path.join(viewsDir, incName + '.ejs')) ? incName : path.join(path.dirname(name), incName);
    const next = new Set(have);
    if (inc.keys === null) next.add('*');
    else inc.keys.forEach((k) => next.add(k));
    out.push(...missingFor(resolved, next, new Set(seen), trail));
  }
  return out;
}
const rendered = new Set();
let renderCount = 0;
for (const r of mine.table) {
  for (const rn of r.renders) {
    renderCount++;
    const where = `${r.where.split(':')[0]}:${rn.line}`;
    rendered.add(rn.view);
    if (!inspectView(rn.view)) { add(errors, 'render-no-view', where, `res.render('${rn.view}') but views/${rn.view}.ejs does not exist`); continue; }
    const have = new Set(globalLocals);
    let opaque = false;
    if (rn.locals) {
      const sh = mine.shapes.shapeOf(rn.locals, rn.scope, 0, new Set());
      sh.keys.forEach((k) => have.add(k));
      if (sh.dynamic) opaque = true;
    }
    if (opaque) continue;
    const seenVar = new Set();
    for (const miss of missingFor(rn.view, have)) {
      if (have.has('*') || seenVar.has(miss.name)) continue;
      seenVar.add(miss.name);
      const lines = inspectView(miss.view).free.get(miss.name);
      add(errors, 'view-undefined-variable', where, `views/${miss.view}.ejs:${lines[0]} uses "${miss.name}", which res.render('${rn.view}') does not pass`);
    }
  }
}

// -- 3b. h.<helper>() used by a view exists in src/helpers.js ------------
const helperNames = new Set();
const helpersAst = [...mine.asts].find(([f]) => path.basename(f) === 'helpers.js' && path.dirname(f) === path.join(ROOT, 'src'));
if (helpersAst) {
  walk(helpersAst[1], (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.name === 'module' && n.left.property.name === 'exports' && n.right.type === 'ObjectExpression') {
      n.right.properties.forEach((p) => { const k = keyName(p.key); if (k) helperNames.add(k); if (p.type === 'SpreadElement') helperNames.add('*'); });
    }
  });
  if (helperNames.size && !helperNames.has('*')) {
    viewFiles.forEach((f) => inspectView(rel(viewsDir, f).replace(/\.ejs$/, '')));
    for (const [name, info] of viewInfo) {
      if (!info) continue;
      for (const [fnName, line] of info.helperUses) {
        if (!helperNames.has(fnName)) add(errors, 'view-unknown-helper', `views/${name}.ejs:${line}`, `uses h.${fnName}, which src/helpers.js does not export`);
      }
    }
  }
}
for (const f of viewFiles) {
  const name = rel(viewsDir, f).replace(/\.ejs$/, '');
  inspectView(name);
  if (!rendered.has(name) && !/^partials\//.test(name)) add(warnings, 'view-never-rendered', rel(ROOT, f), 'no route renders this view');
}

// -- 4. NovaDesk <-> NovaConnect ---------------------------------------
let cross = { checked: 0, skipped: null };
if (fs.existsSync(path.join(OTHER, 'src', 'server.js'))) {
  const theirs = buildRoutes(OTHER);
  const check = (dirLabel, callerRoot, callerAsts, routeSet, finder) => {
    for (const [file, ast] of callerAsts) {
      walk(ast, (n, parents) => {
        const c = finder(n, parents);
        if (!c) return;
        cross.checked++;
        const where = `${dirLabel} ${rel(callerRoot, file)}:${n.loc.start.line}`;
        const hits = matchRoutes(routeSet, c.path);
        if (!hits.length) { add(errors, 'cross-no-route', where, `${c.method} ${c.path} matches no route on the other side`); return; }
        const exact = hits.filter((r) => r.method === c.method);
        if (!exact.length) { add(errors, 'cross-wrong-method', where, `${c.path} is served only as ${[...new Set(hits.map((r) => r.method))].join('/')}`); return; }
        const r = exact[0];
        if (c.bodyKeys && !r.bodyOpaque) {
          const unread = c.bodyKeys.filter((k) => !r.bodyKeys.has(k));
          if (unread.length) add(warnings, 'cross-body-unread', where, `sends ${unread.join(', ')}; ${r.method} ${r.path} (${r.where}) reads ${[...r.bodyKeys].join(', ')}`);
        }
        if (c.reads && c.reads.length && r.json && !r.dynamic && !r.array && r.keys.size) {
          const missing = c.reads.filter((k) => !r.keys.has(k));
          if (missing.length) add(errors, 'cross-response-keys', where, `reads ${missing.join(', ')}; ${r.method} ${r.path} (${r.where}) answers with ${[...r.keys].join(', ')}`);
        }
      });
    }
  };
  const bodyKeysOf = (o) => (o && o.type === 'ObjectExpression' && !o.properties.some((p) => p.type === 'SpreadElement') ? o.properties.map((p) => keyName(p.key)).filter(Boolean) : null);
  // NovaDesk -> NovaConnect: postToNovaConnect('/api/...', {...}) and fetch(`${NOVACONNECT_BASE_URL}/path`)
  check('NovaDesk->NovaConnect', ROOT, mine.asts, theirs.table, (n) => {
    if (n.type !== 'CallExpression') return null;
    if (n.callee.type === 'Identifier' && n.callee.name === 'postToNovaConnect' && n.arguments[0] && n.arguments[0].type === 'Literal') {
      return { method: 'POST', path: String(n.arguments[0].value), bodyKeys: bodyKeysOf(n.arguments[1]) };
    }
    if (n.callee.type === 'Identifier' && n.callee.name === 'fetch' && n.arguments[0] && n.arguments[0].type === 'TemplateLiteral') {
      const t = n.arguments[0];
      if (t.expressions[0] && t.expressions[0].type === 'Identifier' && /NOVACONNECT_BASE_URL/.test(t.expressions[0].name) && t.expressions.length === 1) return { method: 'GET', path: t.quasis[1].value.cooked };
    }
    return null;
  });
  // NovaConnect -> NovaDesk: callNovaDesk('/api/...', {...}); the answer's keys are read through destructuring
  check('NovaConnect->NovaDesk', OTHER, theirs.asts, mine.table, (n, parents) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'callNovaDesk' || !n.arguments[0]) return null;
    const p = exprToPath(n.arguments[0]);
    if (!p.startsWith('/')) return null;
    const reads = [];
    const parent = parents[parents.length - 1], grand = parents[parents.length - 2];
    if (parent && parent.type === 'AwaitExpression' && grand && grand.type === 'VariableDeclarator') {
      if (grand.id.type === 'ObjectPattern') grand.id.properties.forEach((pr) => { const k = pr.key && keyName(pr.key); if (k) reads.push(k); });
    }
    return { method: 'POST', path: p, bodyKeys: bodyKeysOf(n.arguments[1]), reads };
  });
} else {
  cross.skipped = `no NovaConnect checkout at ${OTHER} (set NOVACONNECT_REPO)`;
}

// ------------------------------------------------------------------ report
const report = {
  checked: { routes: mine.table.length, views: viewFiles.length, forms: formCount, links: linkCount, fetches: fetchCount, renders: renderCount, crossServiceCalls: cross.checked },
  crossServiceSkipped: cross.skipped, errors, warnings,
};
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  const c = report.checked;
  console.log(`contract-check: ${c.routes} routes, ${c.views} views (${c.forms} forms, ${c.links} links, ${c.fetches} fetches, ${c.renders} renders), ${c.crossServiceCalls} NovaDesk<->NovaConnect calls`);
  if (cross.skipped) console.log(`note: ${cross.skipped}; cross-service calls were not checked`);
  for (const e of errors) console.log(`ERROR  ${e.where}  [${e.kind}]  ${e.detail}`);
  for (const w of warnings) console.log(`warn   ${w.where}  [${w.kind}]  ${w.detail}`);
  console.log(errors.length ? `FAILED: ${errors.length} contract error(s)` : `OK: no contract errors (${warnings.length} warning(s))`);
}
process.exit(errors.length ? 1 : 0);
