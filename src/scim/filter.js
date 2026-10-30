// SCIM filters (RFC 7644 section 3.4.2.2): `userName eq "jane@corp.example"`, `emails.value co "corp"`,
// `active eq true and userName sw "a"`, `not (...)`, `title pr`. Parsed to a small tree, then either turned into SQL
// (for the users table) or evaluated on plain objects (for the fixed list of groups). Only attributes the caller names
// can ever reach SQL: an unknown attribute is an error, and every value travels as a bound parameter.
'use strict';
const { invalidFilter } = require('./errors');

const MAX_LENGTH = 1000;
const MAX_NODES = 40;
const MAX_DEPTH = 12;
const COMPARISONS = ['eq', 'ne', 'co', 'sw', 'ew', 'pr'];
const UNSUPPORTED = ['gt', 'ge', 'lt', 'le'];

function tokenize(text) {
  const tokens = []; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === '[' || c === ']') throw invalidFilter('Filters on the parts of a multi-valued attribute (square brackets) are not supported. Filter on the attribute itself, for example emails.value eq "..."');
    if (c === '"') {
      let j = i + 1; let raw = '';
      for (;;) {
        if (j >= text.length) throw invalidFilter('A quoted value in the filter is never closed.');
        if (text[j] === '\\') { raw += text[j] + (text[j + 1] || ''); j += 2; continue; }
        if (text[j] === '"') break;
        raw += text[j]; j++;
      }
      let value;
      try { value = JSON.parse(`"${raw}"`); } catch { throw invalidFilter('A quoted value in the filter has an invalid escape.'); }
      tokens.push({ t: 'str', v: value }); i = j + 1; continue;
    }
    let j = i;
    while (j < text.length && !/[\s()"[\]]/.test(text[j])) j++;
    tokens.push({ t: 'word', v: text.slice(i, j) }); i = j;
  }
  return tokens;
}

function parse(text) {
  if (typeof text !== 'string' || !text.trim()) throw invalidFilter('The filter is empty.');
  if (text.length > MAX_LENGTH) throw invalidFilter(`The filter is longer than ${MAX_LENGTH} characters.`);
  const tokens = tokenize(text);
  let pos = 0; let nodes = 0;
  const peek = () => tokens[pos];
  const isWord = (tok, w) => tok && tok.t === 'word' && tok.v.toLowerCase() === w;
  const count = () => { if (++nodes > MAX_NODES) throw invalidFilter('The filter has too many conditions.'); };

  function parseOr(depth) {
    if (depth > MAX_DEPTH) throw invalidFilter('The filter is nested too deeply.');
    let left = parseAnd(depth);
    while (isWord(peek(), 'or')) { pos++; count(); left = { op: 'or', left, right: parseAnd(depth) }; }
    return left;
  }
  function parseAnd(depth) {
    let left = parseNot(depth);
    while (isWord(peek(), 'and')) { pos++; count(); left = { op: 'and', left, right: parseNot(depth) }; }
    return left;
  }
  function parseNot(depth) {
    if (isWord(peek(), 'not')) {
      pos++;
      if (!peek() || peek().t !== '(') throw invalidFilter('"not" must be followed by a condition in brackets.');
      pos++; count(); const inner = parseOr(depth + 1);
      if (!peek() || peek().t !== ')') throw invalidFilter('A bracket in the filter is never closed.');
      pos++;
      return { op: 'not', inner };
    }
    return parseAtom(depth);
  }
  function parseAtom(depth) {
    const tok = peek();
    if (!tok) throw invalidFilter('The filter ends where a condition was expected.');
    if (tok.t === '(') {
      pos++; const inner = parseOr(depth + 1);
      if (!peek() || peek().t !== ')') throw invalidFilter('A bracket in the filter is never closed.');
      pos++;
      return inner;
    }
    if (tok.t !== 'word') throw invalidFilter('A condition should start with an attribute name.');
    pos++; count();
    const attr = tok.v;
    const opTok = peek();
    if (!opTok || opTok.t !== 'word') throw invalidFilter(`The attribute "${attr}" needs an operator (${COMPARISONS.join(', ')}).`);
    const op = opTok.v.toLowerCase(); pos++;
    if (UNSUPPORTED.includes(op)) throw invalidFilter(`The operator "${op}" is not supported (use ${COMPARISONS.join(', ')}).`);
    if (!COMPARISONS.includes(op)) throw invalidFilter(`"${opTok.v}" is not a filter operator (use ${COMPARISONS.join(', ')}).`);
    if (op === 'pr') return { op: 'pr', attr };
    const valTok = peek();
    if (!valTok) throw invalidFilter(`The condition on "${attr}" needs a value.`);
    pos++;
    let value;
    if (valTok.t === 'str') value = valTok.v;
    else if (valTok.t === 'word' && /^(true|false)$/i.test(valTok.v)) value = valTok.v.toLowerCase() === 'true';
    else if (valTok.t === 'word' && /^null$/i.test(valTok.v)) value = null;
    else if (valTok.t === 'word' && /^-?\d+(\.\d+)?$/.test(valTok.v)) value = Number(valTok.v);
    else throw invalidFilter(`The value "${valTok.t === 'word' ? valTok.v : valTok.t}" for "${attr}" must be in double quotes (or true, false, null or a number).`);
    return { op, attr, value };
  }

  const tree = parseOr(0);
  if (pos < tokens.length) throw invalidFilter('The filter has something left over after a complete condition.');
  return tree;
}

// "urn:ietf:params:scim:schemas:core:2.0:User:userName" and "userName" are the same attribute, whatever the capitals.
const normalise = (attr) => String(attr).replace(/^urn:ietf:params:scim:schemas:(core|extension:enterprise):2\.0:(User|Group):/i, '').toLowerCase();

// Each attribute: { sql: the column expression, kind: 'text' | 'bool', fold: compare without regard to capitals }.
function toSql(tree, attributes) {
  const params = [];
  const resolve = (node) => {
    const def = attributes[normalise(node.attr)];
    if (!def) throw invalidFilter(`"${node.attr}" cannot be filtered on. You can use: ${Object.keys(attributes).join(', ')}.`);
    return def;
  };
  const like = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
  const walk = (n) => {
    if (n.op === 'and' || n.op === 'or') return `(${walk(n.left)} ${n.op.toUpperCase()} ${walk(n.right)})`;
    if (n.op === 'not') return `(NOT ${walk(n.inner)})`;
    const def = resolve(n);
    if (n.op === 'pr') return def.kind === 'bool' ? 'TRUE' : `(${def.sql} IS NOT NULL AND ${def.sql} <> '')`;
    if (def.kind === 'bool') {
      if (typeof n.value !== 'boolean' || !['eq', 'ne'].includes(n.op)) throw invalidFilter(`"${n.attr}" can only be compared with eq or ne to true or false.`);
      return `(${def.sql} ${n.op === 'eq' ? '=' : '<>'} ${n.value ? 1 : 0})`;
    }
    if (n.value === null) {
      if (!['eq', 'ne'].includes(n.op)) throw invalidFilter(`null can only be used with eq or ne.`);
      return `(${def.sql} IS ${n.op === 'ne' ? 'NOT ' : ''}NULL)`;
    }
    const text = String(n.value);
    const col = def.fold === false ? def.sql : `lower(${def.sql})`;
    const lit = (v) => (def.fold === false ? v : v.toLowerCase());
    switch (n.op) {
      case 'eq': params.push(lit(text)); return `(${col} = ?)`;
      case 'ne': params.push(lit(text)); return `(${def.sql} IS NULL OR ${col} <> ?)`;
      case 'co': params.push(`%${like(lit(text))}%`); return `(${col} LIKE ? ESCAPE '\\')`;
      case 'sw': params.push(`${like(lit(text))}%`); return `(${col} LIKE ? ESCAPE '\\')`;
      case 'ew': params.push(`%${like(lit(text))}`); return `(${col} LIKE ? ESCAPE '\\')`;
      default: throw invalidFilter(`The operator "${n.op}" is not supported.`);
    }
  };
  const sql = walk(tree);
  return { sql, params };
}

// The same tree on a plain object: getters maps an attribute to a function(row) giving its value(s).
function evaluate(tree, row, getters) {
  const valuesOf = (n) => {
    const get = getters[normalise(n.attr)];
    if (!get) throw invalidFilter(`"${n.attr}" cannot be filtered on. You can use: ${Object.keys(getters).join(', ')}.`);
    const v = get(row);
    return (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined);
  };
  const walk = (n) => {
    if (n.op === 'and') return walk(n.left) && walk(n.right);
    if (n.op === 'or') return walk(n.left) || walk(n.right);
    if (n.op === 'not') return !walk(n.inner);
    const vals = valuesOf(n);
    if (n.op === 'pr') return vals.some((v) => v !== null && v !== '');
    if (n.value === null) return n.op === 'eq' ? vals.every((v) => v === null) : vals.some((v) => v !== null);
    const lc = (v) => String(v).toLowerCase();
    const want = lc(n.value);
    const test = (v) => {
      if (v === null) return false;
      if (typeof v === 'boolean') return typeof n.value === 'boolean' && (n.op === 'eq' ? v === n.value : v !== n.value);
      switch (n.op) {
        case 'eq': return lc(v) === want;
        case 'ne': return lc(v) !== want;
        case 'co': return lc(v).includes(want);
        case 'sw': return lc(v).startsWith(want);
        case 'ew': return lc(v).endsWith(want);
        default: return false;
      }
    };
    return n.op === 'ne' ? vals.every(test) : vals.some(test);
  };
  return walk(tree);
}

module.exports = { parse, toSql, evaluate, normalise, MAX_LENGTH };
