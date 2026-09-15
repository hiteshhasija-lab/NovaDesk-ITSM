const dayjs = require('dayjs');

function priorityFromImpactUrgency(impact, urgency) {
  const score = Number(impact) + Number(urgency);
  if (score <= 2) return 1;
  if (score === 3) return 2;
  if (score === 4) return 3;
  return 4;
}

const PRIORITY_LABELS = { 1: 'Critical', 2: 'High', 3: 'Moderate', 4: 'Low' };
const PRIORITY_BADGE = { 1: 'danger', 2: 'warning', 3: 'info', 4: 'secondary' };

const INCIDENT_STATUS_LABELS = {
  new: 'New', in_progress: 'In Progress', on_hold: 'On Hold',
  resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled'
};
const INCIDENT_STATUS_BADGE = {
  new: 'primary', in_progress: 'warning', on_hold: 'secondary',
  resolved: 'success', closed: 'dark', cancelled: 'secondary'
};

const CHANGE_STATUS_LABELS = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected',
  scheduled: 'Scheduled', implemented: 'Implemented', closed: 'Closed', cancelled: 'Cancelled'
};
const CHANGE_STATUS_BADGE = {
  draft: 'secondary', submitted: 'info', approved: 'primary', rejected: 'danger',
  scheduled: 'warning', implemented: 'success', closed: 'dark', cancelled: 'secondary'
};

const PROBLEM_STATUS_LABELS = {
  new: 'New', investigating: 'Investigating', known_error: 'Known Error', resolved: 'Resolved', closed: 'Closed'
};
const PROBLEM_STATUS_BADGE = {
  new: 'primary', investigating: 'warning', known_error: 'info', resolved: 'success', closed: 'dark'
};

const REQUEST_STATUS_LABELS = {
  submitted: 'Submitted', in_progress: 'In Progress', fulfilled: 'Fulfilled', rejected: 'Rejected', cancelled: 'Cancelled'
};
const REQUEST_STATUS_BADGE = {
  submitted: 'primary', in_progress: 'warning', fulfilled: 'success', rejected: 'danger', cancelled: 'secondary'
};

const CI_STATUS_LABELS = { in_use: 'In Use', in_stock: 'In Stock', maintenance: 'Maintenance', retired: 'Retired' };
const CI_STATUS_BADGE = { in_use: 'success', in_stock: 'info', maintenance: 'warning', retired: 'secondary' };

const CI_TYPE_LABELS = {
  server: 'Server', network_device: 'Network Device', application: 'Application',
  database: 'Database', workstation: 'Workstation', storage: 'Storage'
};

const ENVIRONMENT_LABELS = {
  production: 'Production', staging: 'Staging', uat: 'UAT', development: 'Development', dr: 'Disaster Recovery'
};

const SLA_HOURS = { 1: 4, 2: 8, 3: 24, 4: 72 };

function slaStatus(incident) {
  if (!incident.sla_due_at) return { key: 'none', label: '—', badge: 'secondary' };
  const due = dayjs(incident.sla_due_at.replace(' ', 'T'));

  if (incident.resolved_at) {
    const resolved = dayjs(incident.resolved_at.replace(' ', 'T'));
    return resolved.isAfter(due)
      ? { key: 'breached', label: 'Breached', badge: 'danger' }
      : { key: 'met', label: 'Met SLA', badge: 'success' };
  }
  if (['closed', 'cancelled'].includes(incident.status)) {
    return { key: 'closed', label: '—', badge: 'secondary' };
  }

  const now = dayjs();
  if (now.isAfter(due)) return { key: 'breached', label: 'Breached', badge: 'danger' };

  const totalHours = SLA_HOURS[incident.priority] || SLA_HOURS[4];
  const warnFrom = due.subtract(totalHours * 0.25, 'hour');
  if (now.isAfter(warnFrom)) return { key: 'at_risk', label: 'At Risk', badge: 'warning' };
  return { key: 'on_track', label: 'On Track', badge: 'success' };
}

const ASSIGNMENT_GROUPS = [
  'Infrastructure Support', 'Network Operations', 'Database Team',
  'Desktop Support', 'Applications Team', 'Security Team', 'Service Desk'
];

function escapeHtml(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toCsv(rows, columns) {
  const escape = (val) => {
    let s = val === null || val === undefined ? '' : String(val);
    // Neutralize formula injection (CWE-1236): spreadsheet apps treat a leading
    // =, +, -, @, tab, or CR as the start of a formula/macro when the CSV is opened.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(c => escape(c.label)).join(',');
  const lines = rows.map(row => columns.map(c => escape(c.value(row))).join(','));
  return [header, ...lines].join('\n');
}

function initials(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmtDate(d) {
  if (!d) return '';
  return dayjs(d.replace(' ', 'T')).format('MMM D, YYYY h:mm A');
}

function fmtDateShort(d) {
  if (!d) return '';
  return dayjs(d.replace(' ', 'T')).format('MMM D, YYYY');
}

// Merges `overrides` into an existing query object and serializes it back to a query string,
// for building pagination/sort links that preserve the other active filters.
function withQuery(query, overrides) {
  const merged = { ...query, ...overrides };
  const parts = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

module.exports = {
  priorityFromImpactUrgency,
  PRIORITY_LABELS, PRIORITY_BADGE,
  INCIDENT_STATUS_LABELS, INCIDENT_STATUS_BADGE,
  CHANGE_STATUS_LABELS, CHANGE_STATUS_BADGE,
  PROBLEM_STATUS_LABELS, PROBLEM_STATUS_BADGE,
  REQUEST_STATUS_LABELS, REQUEST_STATUS_BADGE,
  CI_STATUS_LABELS, CI_STATUS_BADGE, CI_TYPE_LABELS, ENVIRONMENT_LABELS,
  SLA_HOURS, slaStatus,
  ASSIGNMENT_GROUPS, toCsv, escapeHtml, withQuery, initials,
  fmtDate, fmtDateShort
};
