// Sends the page's CSRF token (the <meta name="csrf-token"> NovaDesk puts in every page) as a header with every
// same-site fetch() that changes something, so the board, the theme switch and the bulk actions keep working.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta || !window.fetch) return;
  var token = meta.getAttribute('content');
  var original = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      var url = new URL(typeof input === 'string' ? input : (input && input.url) || '', location.href);
      if (url.origin === location.origin) {
        var headers = new Headers(init.headers || (input && input.headers) || {});
        if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
        init.headers = headers;
      }
    }
    return original.call(this, input, init);
  };
})();
