#!/usr/bin/env node
// A small OpenID Connect provider for tests and CI. It publishes discovery and keys, runs the authorization
// code flow with PKCE, and signs ID tokens with RS256. No real accounts: a test chooses who signs in next.
//   node scripts/mock-oidc.js [port]        env: MOCK_CLIENT_ID, MOCK_CLIENT_SECRET (default novadesk-test / test-secret)
//
// Control (from the test, POST JSON):
//   /__next    { sub, email, email_verified, name, preferred_username, bad }   who the next authorization signs in as;
//              bad: 'nonce' | 'aud' | 'iss' | 'expired' | 'signature' | 'alg-none' | 'deny' makes that attempt fail that way
//   /__rotate  new signing key (the old one disappears from the key set)
//   GET /__log what the provider saw (authorizations, token requests and whether PKCE and the secret checked out)
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 9999;
const ISSUER = process.env.MOCK_ISSUER || `http://127.0.0.1:${PORT}`;
const CLIENT_ID = process.env.MOCK_CLIENT_ID || 'novadesk-test';
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || 'test-secret';

let keys = [];
function newKey() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `mock-${crypto.randomBytes(3).toString('hex')}`;
  keys = [{ kid, privateKey: pair.privateKey, jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' } }];
}
newKey();

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signToken(claims, { alg = 'RS256', tamper = false } = {}) {
  const head = b64u({ alg, kid: keys[0].kid, typ: 'JWT' });
  const body = b64u(claims);
  if (alg === 'none') return `${head}.${body}.`;
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), keys[0].privateKey).toString('base64url');
  return tamper ? `${head}.${b64u({ ...claims, sub: `${claims.sub}-forged` })}.${sig}` : `${head}.${body}.${sig}`;
}

let nextIdentity = null;
const codes = new Map();      // code -> { nonce, challenge, redirectUri, identity }
const log = [];
const DEFAULT_IDENTITY = { sub: 'sub-default', email: 'jane.doe@corp.local', email_verified: true, name: 'Jane Doe' };

const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  try {
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(res, 200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, id_token_signing_alg_values_supported: ['RS256'], response_types_supported: ['code'], subject_types_supported: ['public'] });
    }
    if (url.pathname === '/jwks') return send(res, 200, { keys: keys.map((k) => k.jwk) });

    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const entry = { path: 'authorize', client_id: q.get('client_id'), pkce: q.get('code_challenge_method') === 'S256' && Boolean(q.get('code_challenge')), scope: q.get('scope'), has_state: Boolean(q.get('state')), has_nonce: Boolean(q.get('nonce')) };
      log.push(entry);
      if (q.get('client_id') !== CLIENT_ID) return send(res, 400, { error: 'unauthorized_client' });
      const identity = nextIdentity || DEFAULT_IDENTITY; nextIdentity = null;
      const back = new URL(q.get('redirect_uri'));
      if (identity.bad === 'deny') { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', q.get('state')); res.writeHead(302, { Location: back.toString() }); return res.end(); }
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), identity });
      back.searchParams.set('code', code); back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const entry = { path: 'token', secret_ok: form.get('client_secret') === CLIENT_SECRET, client_ok: form.get('client_id') === CLIENT_ID, pkce_ok: false, redirect_ok: false };
      const grant = codes.get(form.get('code'));
      codes.delete(form.get('code'));                       // a code works once
      if (grant) {
        entry.pkce_ok = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') === grant.challenge;
        entry.redirect_ok = form.get('redirect_uri') === grant.redirectUri;
      }
      log.push(entry);
      if (!grant || !entry.secret_ok || !entry.client_ok || !entry.pkce_ok || !entry.redirect_ok) return send(res, 400, { error: 'invalid_grant', error_description: 'code, secret, PKCE or redirect did not check out' });
      const { bad, ...who } = grant.identity;
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 600, nonce: grant.nonce, ...who };
      if (bad === 'nonce') claims.nonce = 'someone-elses-nonce';
      if (bad === 'aud') claims.aud = 'another-application';
      if (bad === 'iss') claims.iss = 'https://evil.example.com';
      if (bad === 'expired') { claims.iat = now - 7200; claims.exp = now - 3600; }
      return send(res, 200, { token_type: 'Bearer', access_token: crypto.randomBytes(8).toString('hex'), id_token: signToken(claims, { alg: bad === 'alg-none' ? 'none' : 'RS256', tamper: bad === 'signature' }) });
    }

    if (url.pathname === '/__next' && req.method === 'POST') { nextIdentity = JSON.parse(await readBody(req) || '{}'); return send(res, 200, { ok: true }); }
    if (url.pathname === '/__rotate' && req.method === 'POST') { newKey(); return send(res, 200, { kid: keys[0].kid }); }
    if (url.pathname === '/__log') return send(res, 200, log);
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    send(res, 500, { error: String(err.message) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`mock OIDC provider on ${ISSUER} (client ${CLIENT_ID})`));
