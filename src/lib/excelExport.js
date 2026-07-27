import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
import { buildDisplayNames } from './csv';

// SheetJS's community edition can write cell values/formulas but not cell
// fills or native Excel conditional-formatting rules (that's a Pro-only
// feature). To still match the coordinator's existing red/yellow outlier
// formatting, we splice real OOXML <conditionalFormatting> + <dxfs> markup
// into the generated workbook after XLSX.write() using `cfb` (already a
// transitive dependency of xlsx, used here to read/patch/rewrite the zip).

function colLetter(n) {
  let s = '';
  let num = n;
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

function toUint8(view) {
  return view instanceof Uint8Array ? view : new Uint8Array(view);
}

function getEntryText(container, path) {
  const idx = container.FullPaths.indexOf(`Root Entry/${path}`);
  if (idx === -1) return null;
  const entry = container.FileIndex[idx];
  const content = entry.content;
  if (typeof content === 'string') return content;
  return new TextDecoder().decode(content);
}

function setEntryText(container, path, text) {
  CFB.utils.cfb_del(container, path);
  const bytes = new TextEncoder().encode(text);
  CFB.utils.cfb_add(container, path, bytes);
}

/**
 * Adds native Excel conditional-formatting rules (red fill when the value
 * in `flagColumn` exceeds `threshold`, yellow fill when it's below
 * `-threshold`) to `sheetName`, covering `A2:<lastCol><lastRow>`.
 */
function injectOutlierConditionalFormatting(workbookArrayBuffer, { sheetName, flagColumn, lastColumn, lastRow, threshold }) {
  const bytes = toUint8(workbookArrayBuffer);
  const container = CFB.read(bytes, { type: 'array' });

  const workbookXml = getEntryText(container, 'xl/workbook.xml');
  const relsXml = getEntryText(container, 'xl/_rels/workbook.xml.rels');

  const sheetMatch = new RegExp(`<sheet[^>]*name="${sheetName}"[^>]*r:id="(rId\\d+)"`).exec(workbookXml);
  if (!sheetMatch) return bytes;
  const rId = sheetMatch[1];

  const relMatch = new RegExp(`<Relationship[^>]*Id="${rId}"[^>]*Target="([^"]+)"`).exec(relsXml);
  if (!relMatch) return bytes;
  const sheetPath = `xl/${relMatch[1]}`;

  let sheetXml = getEntryText(container, sheetPath);
  const sqref = `A2:${lastColumn}${lastRow}`;
  const cfXml =
    `<conditionalFormatting sqref="${sqref}">` +
    `<cfRule type="expression" dxfId="0" priority="1"><formula>$${flagColumn}2&gt;${threshold}</formula></cfRule>` +
    `<cfRule type="expression" dxfId="1" priority="2"><formula>$${flagColumn}2&lt;-${threshold}</formula></cfRule>` +
    `</conditionalFormatting>`;
  sheetXml = sheetXml.replace('</worksheet>', `${cfXml}</worksheet>`);
  setEntryText(container, sheetPath, sheetXml);

  let stylesXml = getEntryText(container, 'xl/styles.xml');
  const dxfsXml =
    '<dxfs count="2">' +
    '<dxf><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>' +
    '<dxf><fill><patternFill><bgColor rgb="FFFFEB9C"/></patternFill></fill></dxf>' +
    '</dxfs>';
  stylesXml = stylesXml.replace(/<dxfs[^/]*\/>/, dxfsXml);
  setEntryText(container, 'xl/styles.xml', stylesXml);

  const out = CFB.write(container, { type: 'array', fileType: 'zip' });
  return toUint8(out);
}

function buildTermDistancesSheet(roster, weekly, displayNames) {
  const header = ['Student Name'];
  for (let w = 1; w <= 6; w++) {
    header.push(`W${w} Site`, `W${w} Distance`);
  }
  header.push('Total Distance');

  const rows = [header];
  roster.forEach((student) => {
    const row = [displayNames[student.id] || student.name];
    for (let w = 1; w <= 6; w++) {
      const cell = weekly[student.id]?.[w];
      row.push(cell ? cell.siteName : '', cell ? cell.distance : 0);
    }
    rows.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const totalCol = 1 + 6 * 2; // 0-indexed column for Total Distance
  roster.forEach((student, i) => {
    const rowNum = i + 2;
    const distCols = [3, 5, 7, 9, 11, 13].map((c) => `${colLetter(c)}${rowNum}`);
    const cellRef = `${colLetter(totalCol + 1)}${rowNum}`;
    ws[cellRef] = { t: 'n', f: `${distCols.join('+')}` };
  });
  ws['!cols'] = header.map(() => ({ wch: 14 }));
  return ws;
}

function buildMileageSummarySheet(roster, mileage, rank, zScore, threshold, displayNames) {
  const rows = [['Student Name', 'Total Distance', 'Rank', 'Z-Score', 'Flag']];
  roster.forEach((s) => {
    const z = zScore[s.id];
    let flag = '';
    if (z > threshold) flag = 'HIGH';
    else if (z < -threshold) flag = 'LOW';
    rows.push([displayNames[s.id] || s.name, Math.round(mileage[s.id] * 10) / 10, rank[s.id], Number(z.toFixed(2)), flag]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 8 }, { wch: 10 }, { wch: 8 }];
  return ws;
}

/**
 * Builds and triggers a download of the results workbook: Term Distances
 * and Mileage Summary (with red/yellow outlier conditional formatting),
 * matching the spec's Results export format.
 */
export function exportResultsToExcel({ roster, weekly, mileage, rank, zScore, threshold = 1.5, fileName = 'clerkship_schedule.xlsx' }) {
  const displayNames = buildDisplayNames(roster);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildTermDistancesSheet(roster, weekly, displayNames), 'Term Distances');
  XLSX.utils.book_append_sheet(wb, buildMileageSummarySheet(roster, mileage, rank, zScore, threshold, displayNames), 'Mileage Summary');

  const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const patched = injectOutlierConditionalFormatting(arrayBuffer, {
    sheetName: 'Mileage Summary',
    flagColumn: 'D',
    lastColumn: 'E',
    lastRow: roster.length + 1,
    threshold,
  });

  const blob = new Blob([patched], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
