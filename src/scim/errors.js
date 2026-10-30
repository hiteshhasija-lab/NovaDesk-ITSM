// SCIM errors (RFC 7644 section 3.12): a JSON body with the Error schema, a status that is a string, and, where the
// protocol names one, a scimType.
'use strict';

class ScimError extends Error {
  constructor(status, scimType, detail) { super(detail); this.status = status; this.scimType = scimType || null; this.detail = detail; }
}
const invalidFilter = (d) => new ScimError(400, 'invalidFilter', d);
const invalidSyntax = (d) => new ScimError(400, 'invalidSyntax', d);
const invalidValue = (d) => new ScimError(400, 'invalidValue', d);
const invalidPath = (d) => new ScimError(400, 'invalidPath', d);
const noTarget = (d) => new ScimError(400, 'noTarget', d);
const uniqueness = (d) => new ScimError(409, 'uniqueness', d);
const notFound = (what = 'Resource') => new ScimError(404, null, `${what} not found.`);
const forbidden = (d, scimType = null) => new ScimError(403, scimType, d);
const mutability = (d) => new ScimError(400, 'mutability', d);

const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const errorBody = (e) => ({ schemas: [ERROR_SCHEMA], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.detail });

module.exports = { ScimError, invalidFilter, invalidSyntax, invalidValue, invalidPath, noTarget, uniqueness, notFound, forbidden, mutability, errorBody, ERROR_SCHEMA };
