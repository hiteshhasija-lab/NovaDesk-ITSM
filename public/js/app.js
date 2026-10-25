// Behaviour the pages used to carry as inline attributes (onclick=..., onsubmit=...). The Content-Security-Policy does
// not allow inline handlers, so the pages say what they want with data attributes and this file does it.
(function () {
  'use strict';

  // <form data-confirm="Delete this?"> asks first, and does nothing if the answer is no.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var question = form && form.getAttribute && form.getAttribute('data-confirm');
    if (question && !window.confirm(question)) event.preventDefault();
  }, true);

  // <tr data-href="/incidents/12"> (and a board card) opens its record when clicked. A click on a link, button or field
  // inside it, or on anything marked data-no-row (the tick box), does its own thing instead. A card that was just
  // dragged (the boards set window.__dragging) does not open.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var row = target.closest('[data-href]');
    if (!row || window.__dragging) return;
    if (target.closest('a, button, input, select, textarea, label, [data-no-row]')) return;
    window.location = row.getAttribute('data-href');
  });
})();
