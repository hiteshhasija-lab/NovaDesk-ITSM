const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const dayjs = require('dayjs');
dayjs.extend(require('dayjs/plugin/utc'));
dayjs.extend(require('dayjs/plugin/timezone'));

const TRACKER_PATH = path.join(__dirname, '..', 'data', 'Decommissioned Tracker.xlsx');
const SHEET_NAME = 'Decommissioned Servers';
const DATE_COLUMN_HEADER = 'Decommissioned Date';

const COLUMNS = [
  { header: 'CI Number', key: 'ciNumber', width: 16 },
  { header: 'Name', key: 'name', width: 24 },
  { header: 'CI Type', key: 'ciType', width: 16 },
  { header: 'IP Address', key: 'ipAddress', width: 16 },
  { header: 'OS', key: 'os', width: 20 },
  { header: 'Serial Number', key: 'serialNumber', width: 20 },
  { header: 'Location', key: 'location', width: 18 },
  { header: 'Support Group', key: 'supportGroup', width: 18 },
  { header: 'Change Number', key: 'changeNumber', width: 16 },
  { header: 'Decommissioned Date', key: 'decommissionedDate', width: 20 },
  { header: 'Confirmed By', key: 'confirmedBy', width: 18 }
];

// Appends one row per decommissioned server. Creates the workbook on first use so the
// "Update tracker & reclaim licenses" CTask has an actual file to point to from day one.
async function appendDecomTrackerRow(row) {
  const workbook = new ExcelJS.Workbook();
  let sheet;

  if (fs.existsSync(TRACKER_PATH)) {
    await workbook.xlsx.readFile(TRACKER_PATH);
    sheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];
  } else {
    sheet = workbook.addWorksheet(SHEET_NAME);
    sheet.columns = COLUMNS.map(c => ({ header: c.header, width: c.width }));
    sheet.getRow(1).font = { bold: true };
  }

  // Reloading a workbook from disk does not restore each column's `key`, so a key-based
  // addRow({...}) would silently misalign after the first save. Push values in COLUMNS
  // order instead, which works whether the sheet was just created or just reloaded.
  sheet.addRow(COLUMNS.map(c => row[c.key] || ''));

  await workbook.xlsx.writeFile(TRACKER_PATH);
  return sheet.rowCount;
}

// The tracker file on disk stores "Decommissioned Date" as UTC text (nowStr(), see db.js),
// same as every other timestamp in the app. HTML pages re-render stored UTC into the viewer's
// own timezone client-side (see fmtDate in helpers.js) — Excel has no equivalent at open-time,
// so the conversion has to happen here, at download, using the timezone the downloading
// browser reports for itself. Returns a Buffer; the on-disk file is left untouched so the
// stored data stays unambiguous UTC regardless of who last downloaded it.
async function readTrackerForDownload(tz) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TRACKER_PATH);
  const sheet = workbook.getWorksheet(SHEET_NAME) || workbook.worksheets[0];

  if (tz) {
    const dateColIndex = COLUMNS.findIndex(c => c.header === DATE_COLUMN_HEADER) + 1;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const cell = row.getCell(dateColIndex);
      const raw = cell.value;
      if (!raw || typeof raw !== 'string') return;
      const converted = dayjs.utc(raw.replace(' ', 'T')).tz(tz);
      if (converted.isValid()) cell.value = converted.format('YYYY-MM-DD HH:mm:ss');
    });
  }

  return workbook.xlsx.writeBuffer();
}

module.exports = { TRACKER_PATH, appendDecomTrackerRow, readTrackerForDownload };
