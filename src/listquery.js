const DEFAULT_PAGE_SIZE = 20;

// `columns` is a whitelist map: query-string sort key -> getter(row) used for comparison.
// Never build SQL ORDER BY from req.query.sort directly — this only ever touches JS values.
function parseSort(req, columns, defaultKey, defaultDir = 'asc') {
  const key = Object.prototype.hasOwnProperty.call(columns, req.query.sort) ? req.query.sort : defaultKey;
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  return { key, dir };
}

function sortRows(rows, columns, key, dir) {
  const getter = columns[key] || columns[Object.keys(columns)[0]];
  const sorted = [...rows].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  if (dir === 'desc') sorted.reverse();
  return sorted;
}

// Slices an already filtered+sorted array into one page, based on req.query.page.
function paginate(rows, req, pageSize = DEFAULT_PAGE_SIZE) {
  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;

  return {
    items: rows.slice(offset, offset + pageSize),
    pagination: {
      page: clampedPage,
      pageSize,
      total,
      totalPages,
      hasPrev: clampedPage > 1,
      hasNext: clampedPage < totalPages,
      from: total === 0 ? 0 : offset + 1,
      to: Math.min(total, offset + pageSize)
    }
  };
}

module.exports = { parseSort, sortRows, paginate, DEFAULT_PAGE_SIZE };
