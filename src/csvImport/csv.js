// Reading a CSV file: bytes to text, text to rows. No dependency; the format is small and the edge cases are the point
// (quoted values with commas and line breaks, a byte-order mark, Excel's semicolons and tabs, files that are not UTF-8).
'use strict';

class CsvError extends Error {}

// Bytes to text. UTF-8 (with or without a BOM) first; UTF-16 when the file says so (Excel's "Unicode Text"); when the bytes
// are not valid UTF-8 the file is taken to be Windows-1252, which is what Excel on Windows writes for "CSV".
function decode(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16' };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16' };
  const start = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(start)), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(b.subarray(start)), encoding: 'Windows-1252' };
  }
}

// The separator is whichever of comma, semicolon and tab is most frequent in the first line outside quotes.
function detectDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && c in counts) counts[c]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

// Text to records (arrays of strings). Blank lines are dropped. A value in quotes may hold the separator, line breaks and
// doubled quotes. A quote in the middle of an unquoted value is kept as it is.
function parse(text, { maxRecords = Infinity, maxColumns = 200 } = {}) {
  const delimiter = detectDelimiter(text);
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let quoted = false;     // the current value started with a quote
  let any = false;        // something (even an empty quoted value) was seen on this line

  const endField = () => { record.push(field); field = ''; quoted = false; };
  const endRecord = () => {
    endField();
    if (record.length > maxColumns) throw new CsvError(`The file has more than ${maxColumns} columns.`);
    if (any && !(record.length === 1 && record[0].trim() === '' && !quoted)) records.push(record);
    record = []; any = false;
    if (records.length > maxRecords) throw new CsvError(`The file has more than ${maxRecords - 1} rows. Split it into smaller files.`);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '' && !quoted) { inQuotes = true; quoted = true; any = true; continue; }
    if (c === delimiter) { any = true; endField(); continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      continue;
    }
    field += c; any = true;
  }
  if (inQuotes) throw new CsvError('A value in quotes is never closed. Check for a stray " in the file.');
  if (any || field !== '' || record.length) endRecord();
  return { records, delimiter };
}

// One value as typed by a person: trimmed, and with the apostrophe put in front by NovaDesk's own CSV export (which keeps
// a spreadsheet from running a value that starts with = + - @ as a formula) taken off again.
function cleanCell(value) {
  let s = String(value === undefined || value === null ? '' : value).trim();
  if (/^'[=+\-@\t\r]/.test(s)) s = s.slice(1);
  return s;
}

// "IP Address", "ip_address" and "IP-address" are the same column.
const headerKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

module.exports = { decode, parse, detectDelimiter, cleanCell, headerKey, CsvError };
