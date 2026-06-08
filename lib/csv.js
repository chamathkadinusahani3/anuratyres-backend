// backend/lib/csv.js
// Minimal dependency-free CSV reader/writer (RFC 4180-ish: quoted fields,
// embedded commas/newlines/escaped quotes via "").

/**
 * Parses CSV text into { headers, rows } where rows is an array of arrays.
 * Handles quoted fields, escaped quotes (""), CRLF/LF, and trailing blank lines.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // Strip BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }

    if (char === ',') { row.push(field); field = ''; continue; }

    if (char === '\r') continue; // normalise CRLF -> LF

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  // flush final field/row
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // drop fully-empty trailing rows
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}

/**
 * Converts parsed CSV (headers + raw row arrays) into an array of plain
 * objects keyed by lower-cased, trimmed header names.
 */
export function rowsToObjects(headers, rows) {
  const keys = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.map((cells) => {
    const obj = {};
    keys.forEach((key, idx) => {
      obj[key] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}

function escapeField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Serialises an array of plain objects into CSV text using the given column
 * order. Missing keys become empty cells.
 */
export function toCsv(columns, records) {
  const lines = [columns.map(escapeField).join(',')];
  for (const record of records) {
    lines.push(columns.map((col) => escapeField(record[col])).join(','));
  }
  return lines.join('\r\n');
}

export default { parseCsv, rowsToObjects, toCsv };
