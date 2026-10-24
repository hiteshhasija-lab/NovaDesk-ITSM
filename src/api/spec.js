// The OpenAPI 3 document for /api/v1 and the shapes of what the API returns. The routes and their input come from
// the registry in core.js (the code that runs); the response shapes are listed here and a test compares them with
// real answers, so neither can drift from the code.
'use strict';

// A shape is { property: 'type' }. Types: integer, string, boolean, object, plus the name of another shape; a trailing ? allows null.
const SHAPES = {
  Ref: { id: 'integer', name: 'string?' },
  Sla: { due_at: 'string', status: 'string', target_minutes: 'integer?', clock: 'string?', paused: 'boolean' },
  Me: { id: 'integer', username: 'string', full_name: 'string', email: 'string?', role: 'string', key: 'object' },
  User: { id: 'integer', username: 'string', full_name: 'string', email: 'string?', role: 'string', department: 'string?', active: 'boolean' },
  Incident: {
    id: 'integer', number: 'string', short_description: 'string', description: 'string?', category: 'string?', subcategory: 'string?', impact: 'integer', urgency: 'integer',
    priority: 'integer', status: 'string', caller: 'Ref?', assigned_to: 'Ref?', assignment_group: 'string?', affected_ci_id: 'integer?', problem_id: 'integer?',
    resolution_notes: 'string?', created_at: 'string', updated_at: 'string', resolved_at: 'string?', closed_at: 'string?', sla: 'Sla?', html_url: 'string?',
  },
  Comment: { id: 'integer', comment: 'string', work_note: 'boolean', author: 'Ref?', created_at: 'string' },
  CatalogItem: { id: 'integer', name: 'string', description: 'string?', category: 'string?', fulfillment_group: 'string?' },
  Request: {
    id: 'integer', number: 'string', status: 'string', catalog_item: 'Ref?', requested_by: 'Ref?', assigned_to: 'Ref?', assignment_group: 'string?', notes: 'string?',
    created_at: 'string', updated_at: 'string', fulfilled_at: 'string?', sla: 'Sla?', html_url: 'string?',
  },
  Change: {
    id: 'integer', number: 'string', short_description: 'string', description: 'string?', change_type: 'string', risk: 'string', status: 'string', approval_status: 'string',
    requested_by: 'Ref?', assigned_to: 'Ref?', assignment_group: 'string?', affected_ci_id: 'integer?', planned_start: 'string?', planned_end: 'string?',
    created_at: 'string', updated_at: 'string', closed_at: 'string?', approval_sla: 'Sla?', html_url: 'string?',
  },
  Problem: {
    id: 'integer', number: 'string', short_description: 'string', description: 'string?', status: 'string', priority: 'integer', root_cause: 'string?', workaround: 'string?',
    affected_ci_id: 'integer?', raised_by: 'Ref?', assigned_to: 'Ref?', assignment_group: 'string?', created_at: 'string', updated_at: 'string', resolved_at: 'string?', closed_at: 'string?', html_url: 'string?',
  },
  Ci: {
    id: 'integer', ci_number: 'string', name: 'string', ci_type: 'string', environment: 'string?', status: 'string', ip_address: 'string?', os: 'string?', manufacturer: 'string?',
    model: 'string?', serial_number: 'string?', location: 'string?', owner: 'Ref?', support_group: 'string?', cpu: 'string?', ram: 'string?', disk: 'string?',
    purchase_date: 'string?', warranty_expiry: 'string?', install_date: 'string?', notes: 'string?', created_at: 'string', updated_at: 'string', html_url: 'string?',
  },
  Article: { id: 'integer', number: 'string', title: 'string', category: 'string', status: 'string', author: 'Ref?', view_count: 'integer', body: 'string', created_at: 'string', updated_at: 'string', html_url: 'string?' },
  ArticleSummary: { id: 'integer', number: 'string', title: 'string', category: 'string', status: 'string', author: 'Ref?', view_count: 'integer', summary: 'string', created_at: 'string', updated_at: 'string', html_url: 'string?' },
};
// What each route's `response` name means: a shape, or a page of them.
const RESPONSES = {
  Me: 'Me', Incident: 'Incident', Comment: 'Comment', Request: 'Request', Change: 'Change', Problem: 'Problem', Ci: 'Ci', Article: 'Article',
  UserList: ['User'], IncidentList: ['Incident'], CommentList: ['Comment'], CatalogItemList: ['CatalogItem'], RequestList: ['Request'],
  ChangeList: ['Change'], ProblemList: ['Problem'], CiList: ['Ci'], ArticleList: ['ArticleSummary'],
};

const TYPE_JSON = { integer: { type: 'integer' }, string: { type: 'string' }, boolean: { type: 'boolean' }, object: { type: 'object' } };
function propertySchema(type) {
  const nullable = type.endsWith('?');
  const base = type.replace(/\?$/, '');
  const schema = TYPE_JSON[base] ? { ...TYPE_JSON[base] } : { $ref: `#/components/schemas/${base}` };
  return nullable ? (schema.$ref ? { allOf: [schema], nullable: true } : { ...schema, nullable: true }) : schema;
}
const shapeSchema = (shape) => ({ type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, t]) => [k, propertySchema(t)])), required: Object.keys(shape) });
const pageSchema = (itemName) => ({ type: 'object', properties: { data: { type: 'array', items: { $ref: `#/components/schemas/${itemName}` } }, page: { type: 'integer' }, per_page: { type: 'integer' }, total: { type: 'integer' } }, required: ['data', 'page', 'per_page', 'total'] });

function fieldSchema(def) {
  const s = def.type === 'enum' ? { type: 'string', enum: def.values } : def.type === 'date' ? { type: 'string', format: 'date' } : { type: def.type };
  if (def.max !== undefined) s[def.type === 'string' ? 'maxLength' : 'maximum'] = def.max;
  if (def.min !== undefined) s.minimum = def.min;
  if (def.nullable) s.nullable = true;
  if (def.description) s.description = def.description;
  return s;
}

function buildOpenApi(routes, { serverUrl = '/' } = {}) {
  const paths = {};
  for (const r of routes) {
    const path = r.path.replace(/:(\w+)/g, '{$1}');
    const params = [...(r.path.match(/:(\w+)/g) || []).map((p) => ({ name: p.slice(1), in: 'path', required: true, schema: { type: 'integer' } })),
      ...Object.entries(r.query || {}).map(([name, def]) => ({ name, in: 'query', required: false, schema: fieldSchema(def), description: def.description }))];
    const response = RESPONSES[r.response];
    const okSchema = Array.isArray(response) ? { $ref: `#/components/schemas/${response[0]}Page` } : { $ref: `#/components/schemas/${response}` };
    const op = {
      tags: [r.tag], summary: r.summary, description: r.description,
      parameters: params.length ? params : undefined,
      requestBody: r.body ? { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(r.body).map(([k, d]) => [k, fieldSchema(d)])), required: Object.entries(r.body).filter(([, d]) => d.required).map(([k]) => k) } } } } : undefined,
      responses: {
        [r.status || 200]: { description: 'Success', content: { 'application/json': { schema: okSchema } } },
        400: { description: 'The request is not valid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        401: { description: 'No valid API key', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        ...(r.scope === 'write' || r.roles ? { 403: { description: 'The key or its owner may not do this', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } : {}),
        404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        429: { description: 'Rate limit reached', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
    (paths[path] = paths[path] || {})[r.method.toLowerCase()] = JSON.parse(JSON.stringify(op));
  }
  const schemas = { Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } } }, required: ['code', 'message'] } }, required: ['error'] } };
  for (const [name, shape] of Object.entries(SHAPES)) schemas[name] = shapeSchema(shape);
  for (const name of Object.values(RESPONSES).filter(Array.isArray).map((a) => a[0])) schemas[`${name}Page`] = pageSchema(name);
  return {
    openapi: '3.0.3',
    info: { title: 'NovaDesk REST API', version: '1.0.0', description: 'Personal API keys, JSON over HTTPS. See /api/docs for the guide.' },
    servers: [{ url: serverUrl }],
    security: [{ bearerKey: [] }],
    tags: [...new Set(routes.map((r) => r.tag))].map((name) => ({ name })),
    paths,
    components: { securitySchemes: { bearerKey: { type: 'http', scheme: 'bearer', description: 'A personal API key (ndk_...), made under Profile, API keys.' } }, schemas },
  };
}

module.exports = { SHAPES, RESPONSES, buildOpenApi };
