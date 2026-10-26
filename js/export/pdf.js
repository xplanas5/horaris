/*
 * Generador de PDF mínim: pàgines amb rectangles i text en Helvetica (fonts estàndard, sense incrustar).
 * Coordenades en punts amb l'origen a dalt a l'esquerra. El text es codifica en WinAnsi, que cobreix
 * el català (à, ç, l·l…); els caràcters que no hi són surten com a «?».
 */

// Glyph widths (1/1000 em) for codes 32..126, from the standard Helvetica AFM files.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// WinAnsi codes for characters outside Latin-1.
const WIN_EXTRA = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

function winAnsi(str) {
  const out = [];
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) out.push(c);
    else if (WIN_EXTRA[ch]) out.push(WIN_EXTRA[ch]);
    else if (c === 10 || c === 9) out.push(32);
    else out.push(63);
  }
  return out;
}

// Width of one WinAnsi code: accented letters measure like their base letter.
function glyphWidth(code, bold) {
  const table = bold ? W_BOLD : W_REG;
  if (code >= 32 && code < 127) return table[code - 32];
  if (code >= 192) {
    const base = String.fromCharCode(code).normalize('NFD')[0].charCodeAt(0);
    if (base < 127 && base >= 32) return table[base - 32];
  }
  return code === 0xb7 ? 278 : 556;
}

export function textWidth(str, size, bold = false) {
  return winAnsi(str).reduce((n, c) => n + glyphWidth(c, bold), 0) * size / 1000;
}

// Cuts text to fit `width`, adding an ellipsis.
export function fit(str, width, size, bold = false) {
  const s = String(str ?? '');
  if (textWidth(s, size, bold) <= width) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textWidth(`${s.slice(0, mid)}…`, size, bold) <= width) lo = mid; else hi = mid - 1;
  }
  return lo ? `${s.slice(0, lo).trimEnd()}…` : '';
}

function rgb(hex) {
  let h = String(hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return n.some(Number.isNaN) ? '0 0 0' : n.map((x) => x.toFixed(3)).join(' ');
}

const num = (x) => (Math.round(x * 100) / 100).toString();

export class Pdf {
  constructor() { this.pages = []; }

  page(width = 842, height = 595) {
    this.cur = { width, height, ops: [] };
    this.pages.push(this.cur);
    return this;
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    const { ops, height } = this.cur;
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${num(lineWidth)} w`);
    ops.push(`${num(x)} ${num(height - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    return this;
  }

  // y is the text baseline. With `width`, the text is cut to fit and can be centred or right-aligned.
  text(str, x, y, { size = 10, bold = false, color = '#000000', width = null, align = 'left' } = {}) {
    let s = String(str ?? '');
    if (width != null) s = fit(s, width, size, bold);
    if (!s) return this;
    let tx = x;
    if (width != null && align !== 'left') {
      const free = width - textWidth(s, size, bold);
      tx = x + (align === 'center' ? free / 2 : free);
    }
    const hex = winAnsi(s).map((c) => c.toString(16).padStart(2, '0')).join('');
    this.cur.ops.push(`BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(tx)} ${num(this.cur.height - y)} Td <${hex}> Tj ET`);
    return this;
  }

  output() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = this.pages.map((p) => {
      const stream = p.ops.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.width} ${p.height}] `
        + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`);
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

    // Everything is ASCII (text goes as hex), so string length equals byte length.
    let out = '%PDF-1.4\n';
    const offsets = objs.map((body, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return at;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }
}
