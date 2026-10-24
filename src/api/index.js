// /api/v1: put together the router, the resources and the OpenAPI document.
'use strict';
const { createApi } = require('./core');
const { register } = require('./resources');
const { buildOpenApi } = require('./spec');

const api = createApi();
register(api);
api.publicGet('/openapi.json', (req, res) => {
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  res.json(buildOpenApi(api.routes, { serverUrl: `${publicUrl}/api/v1` }));
});
api.finish();

module.exports = { router: api.router, routes: api.routes, limits: api.limits, openApi: () => buildOpenApi(api.routes, { serverUrl: '/api/v1' }) };
