// Creating and changing a configuration item, shared by the pages and the REST API.
'use strict';
const { db, nextNumber, nowStr } = require('./db');

const CI_COLUMNS = ['name', 'ci_type', 'environment', 'status', 'ip_address', 'os', 'manufacturer', 'model', 'serial_number', 'location',
  'owner_id', 'support_group', 'cpu', 'ram', 'disk', 'purchase_date', 'warranty_expiry', 'install_date', 'notes'];

// The complete column values from whatever fields were given (empty means unset; environment and status default).
function ciValues(b) {
  const v = {};
  for (const c of CI_COLUMNS) v[c] = b[c] || null;
  v.environment = b.environment || 'production';
  v.status = b.status || 'in_use';
  v.name = b.name;
  v.ci_type = b.ci_type;
  return v;
}

async function createCi({ actor, fields }) {
  const ci_number = await nextNumber('ci', 'CI');
  const info = await db.prepare(`
    INSERT INTO cmdb_ci (ci_number, name, ci_type, environment, status, ip_address, os, manufacturer, model,
      serial_number, location, owner_id, support_group, cpu, ram, disk, purchase_date, warranty_expiry,
      install_date, notes, created_by)
    VALUES (@ci_number, @name, @ci_type, @environment, @status, @ip_address, @os, @manufacturer, @model,
      @serial_number, @location, @owner_id, @support_group, @cpu, @ram, @disk, @purchase_date, @warranty_expiry,
      @install_date, @notes, @created_by)
    RETURNING id
  `).run({ ci_number, ...ciValues(fields), created_by: actor.id });
  return { id: info.lastInsertRowid, ci_number };
}

async function updateCi({ existing, fields }) {
  await db.prepare(`
    UPDATE cmdb_ci SET name=@name, ci_type=@ci_type, environment=@environment, status=@status, ip_address=@ip_address,
      os=@os, manufacturer=@manufacturer, model=@model, serial_number=@serial_number, location=@location,
      owner_id=@owner_id, support_group=@support_group, cpu=@cpu, ram=@ram, disk=@disk,
      purchase_date=@purchase_date, warranty_expiry=@warranty_expiry, install_date=@install_date, notes=@notes,
      updated_at=@updated_at
    WHERE id=@id
  `).run({ id: existing.id, ...ciValues(fields), updated_at: nowStr() });
}

module.exports = { createCi, updateCi, CI_COLUMNS };
