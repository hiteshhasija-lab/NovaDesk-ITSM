// Which tenant (organisation) the code that is running is acting for.
//
// Every request is handled inside tenancy.run(tenantId, ...) (src/tenants.js sets that up from the host name, or from the
// API key or SCIM token), and every background job inside tenancy.run() for each tenant in turn. The database layer
// (src/db.js) reads it for every statement and tells Postgres (the setting app.tenant_id, which the row level security
// policies check), so code that runs with no tenant cannot reach any tenant's data: it fails with NoTenantError.
//
// runPlatform() is the one way to look across tenants (find which tenant a key belongs to, list the tenants, clean up expired
// sessions). It is used in a handful of places named in the README, never for anything a person typed.
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

class NoTenantError extends Error {
  constructor(sql) {
    super(`No tenant is set for this database call (it ran outside any request or tenant job): ${String(sql || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    this.code = 'NO_TENANT';
  }
}

function run(tenantId, fn) {
  const id = Number(tenantId);
  if (!Number.isInteger(id) || id < 1) throw new Error(`Not a tenant id: ${tenantId}`);
  return als.run({ tenantId: id, platform: false }, fn);
}
const runPlatform = (fn) => als.run({ tenantId: null, platform: true }, fn);
const context = () => als.getStore() || null;
const currentId = () => { const c = als.getStore(); return c && !c.platform ? c.tenantId : null; };

module.exports = { run, runPlatform, context, currentId, NoTenantError };
