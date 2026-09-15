const express = require('express');

// Express 4 does not forward a rejected promise from an async handler to next(err) —
// the request just hangs. This wraps every handler/middleware registered on a router
// (including ones passed as arrays, e.g. requireAuth, requireRole) so a thrown/rejected
// error always reaches the app's error-handling middleware instead of silently hanging.
function wrapHandler(fn) {
  if (typeof fn !== 'function') return fn;
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function wrapArg(arg) {
  return Array.isArray(arg) ? arg.map(wrapHandler) : wrapHandler(arg);
}

function createAsyncRouter(...routerArgs) {
  const router = express.Router(...routerArgs);
  ['get', 'post', 'put', 'delete', 'patch', 'all', 'use'].forEach((method) => {
    const original = router[method].bind(router);
    router[method] = (...handlers) => original(...handlers.map(wrapArg));
  });
  return router;
}

module.exports = createAsyncRouter;
