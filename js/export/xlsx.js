import { zip } from './zip.js';

/*
 * Llibre d'Excel (.xlsx) mínim, amb colors, vores, text ajustat i cel·les combinades.
 * Google Drive l'obre com a Full de càlcul de Google.
 *
 * sheets: [{ name, cols: [width], rows: [{ height, cells: [cell | null] }], merges: ['A1:F1'] }]
 * cell:   { v: string, bold, size, color, fill, align: 'left' | 'center', wrap, border }
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // Characters not allowed in XML 1.0
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

export const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

const argb = (hex) => {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(h) ? `FF${h.toUpperCase()}` : null;
};

// Sheet names: max 31 characters, no []:*?/\ and unique in the workbook.
function sheetNames(names) {
  const used = new Set();
  return names.map((n) => {
    const base = String(n || 'Full').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Full';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
}

class Styles {
  constructor() {
    this.fonts = ['<font><sz val="10"/><name val="Arial"/></font>'];
    this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    this.keys = new Map();
  }

  idx(list, xml) {
    let i = list.indexOf(xml);
    if (i < 0) { list.push(xml); i = list.length - 1; }
    return i;
  }

  get(c) {
    const color = argb(c.color);
    const font = this.idx(this.fonts, `<font>${c.bold ? '<b/>' : ''}<sz val="${c.size || 10}"/>${color ? `<color rgb="${color}"/>` : ''}<name val="Arial"/></font>`);
    const fillRgb = argb(c.fill);
    const fill = fillRgb ? this.idx(this.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${fillRgb}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = c.border ? 1 : 0;
    const align = `<alignment horizontal="${c.align || 'left'}" vertical="center"${c.wrap ? ' wrapText="1"' : ''}/>`;
    const key = `${font}|${fill}|${border}|${align}`;
    if (!this.keys.has(key)) {
      this.xfs.push(`<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`);
      this.keys.set(key, this.xfs.length - 1);
    }
    return this.keys.get(key);
  }

  xml() {
    const thin = '<left style="thin"><color rgb="FFB0B7C3"/></left><right style="thin"><color rgb="FFB0B7C3"/></right><top style="thin"><color rgb="FFB0B7C3"/></top><bottom style="thin"><color rgb="FFB0B7C3"/></bottom><diagonal/>';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>
<fills count="${this.fills.length}">${this.fills.join('')}</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${thin}</border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }
}

function sheetXml(sheet, styles) {
  const cols = (sheet.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const rows = sheet.rows.map((row, r) => {
    const cells = row.cells.map((c, i) => {
      if (!c) return '';
      const ref = `${colName(i)}${r + 1}`;
      const s = styles.get(c);
      return c.v === '' || c.v == null
        ? `<c r="${ref}" s="${s}"/>`
        : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
    }).join('');
    const ht = row.height ? ` ht="${row.height}" customHeight="1"` : '';
    return `<row r="${r + 1}"${ht}>${cells}</row>`;
  }).join('');
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows}</sheetData>
${merges}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="1"/>
</worksheet>`;
}

export function xlsx(sheets) {
  const styles = new Styles();
  const names = sheetNames(sheets.map((s) => s.name));
  const files = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, styles) }));
  const ws = sheets.map((_, i) => i + 1);
  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${ws.map((n) => `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${ws.map((n, i) => `<sheet name="${esc(names[i])}" sheetId="${n}" r:id="rId${n}"/>`).join('')}</sheets>
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${ws.map((n) => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`).join('\n')}
<Relationship Id="rId${ws.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: styles.xml() },
    ...files,
  ]);
}
