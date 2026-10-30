// The three documents a provider reads to learn what this SCIM server can do (RFC 7643 section 5-8, RFC 7644 section 4):
// ServiceProviderConfig, ResourceTypes and Schemas. They describe what NovaDesk really supports, nothing more.
'use strict';
const R = require('./resource');

const SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
const RESOURCE_TYPE = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
const SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

const serviceProviderConfig = (base, { maxResults }) => ({
  schemas: [SPC],
  documentationUri: undefined,
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A SCIM token made under Settings > SCIM provisioning, sent as "Authorization: Bearer nds_...".', specUri: 'https://www.rfc-editor.org/info/rfc6750', primary: true }],
  meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
});

const resourceTypes = (base) => [
  { schemas: [RESOURCE_TYPE], id: 'User', name: 'User', endpoint: '/Users', description: 'A person in NovaDesk.', schema: R.CORE_USER, schemaExtensions: [{ schema: R.ENTERPRISE_USER, required: false }], meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
  { schemas: [RESOURCE_TYPE], id: 'Group', name: 'Group', endpoint: '/Groups', description: "One of NovaDesk's assignment groups. The list is fixed; only membership can change.", schema: R.CORE_GROUP, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
];

const attr = (name, type, extra = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });

const schemas = (base) => [
  {
    schemas: [SCHEMA], id: R.CORE_USER, name: 'User', description: 'A person in NovaDesk.',
    attributes: [
      attr('userName', 'string', { required: true, uniqueness: 'server', description: 'The username. Letters, digits and . _ - @ + (2 to 64 characters). Unique whatever the capitals.' }),
      attr('externalId', 'string', { caseExact: true, description: "The provider's own id for the person." }),
      attr('displayName', 'string', { description: 'The name shown in NovaDesk.' }),
      attr('name', 'complex', { description: 'NovaDesk keeps one name. formatted (or displayName) is stored as it is; givenName and familyName are joined, and read back by splitting at the first space.', subAttributes: [attr('formatted', 'string'), attr('givenName', 'string'), attr('familyName', 'string')] }),
      attr('active', 'boolean', { description: 'false switches the person off: their sessions end and their API keys are revoked.' }),
      attr('emails', 'complex', { multiValued: true, description: 'NovaDesk keeps one email address: the primary one, else a work one, else the first. It must belong to one account only.', subAttributes: [attr('value', 'string'), attr('type', 'string'), attr('primary', 'boolean')] }),
      attr('roles', 'complex', { multiValued: true, description: 'admin, agent or user. admin only when an administrator has allowed SCIM to grant it.', subAttributes: [attr('value', 'string'), attr('primary', 'boolean')] }),
      attr('groups', 'complex', { multiValued: true, mutability: 'readOnly', description: 'The assignment groups the person is in. Change them through /Groups.', subAttributes: [attr('value', 'string', { mutability: 'readOnly' }), attr('display', 'string', { mutability: 'readOnly' }), attr('$ref', 'reference', { mutability: 'readOnly' })] }),
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${R.CORE_USER}` },
  },
  {
    schemas: [SCHEMA], id: R.ENTERPRISE_USER, name: 'EnterpriseUser', description: 'The enterprise extension. Only department is kept.',
    attributes: [attr('department', 'string')],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${R.ENTERPRISE_USER}` },
  },
  {
    schemas: [SCHEMA], id: R.CORE_GROUP, name: 'Group', description: "One of NovaDesk's assignment groups (a fixed list).",
    attributes: [
      attr('displayName', 'string', { required: true, mutability: 'readOnly' }),
      attr('members', 'complex', { multiValued: true, description: 'The people in the group. Changing them needs an administrator to have allowed it in the SCIM settings.', subAttributes: [attr('value', 'string', { mutability: 'immutable' }), attr('$ref', 'reference', { mutability: 'immutable' }), attr('display', 'string', { mutability: 'immutable' })] }),
    ],
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${R.CORE_GROUP}` },
  },
];

module.exports = { serviceProviderConfig, resourceTypes, schemas };
