export const uid = (prefix = 'x') => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const byId = (arr) => new Map(arr.map((x) => [x.id, x]));

// Text color (dark/light) readable over a hex background.
export function textColor(hex) {
  let h = String(hex || '#cccccc').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return '#1a1a1a';
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1a1a1a' : '#ffffff';
}

// Saves `data` (Blob, Uint8Array or string) as a file download.
export function downloadBlob(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
