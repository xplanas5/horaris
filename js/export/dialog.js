import * as store from '../store.js';
import { buildIndex } from '../model.js';
import { KINDS, timetableOf, timetablesPdf, timetablesXlsx, fileName } from './timetable.js';
import { zip } from './zip.js';
import { esc, downloadBlob } from '../util.js';

// Finestra «Exporta horaris»: horaris individuals de grups, docents, matèries o aules en PDF o Excel.

const root = document.getElementById('modal');
const MIME = { pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const opt = { kind: 'class', format: 'pdf', split: false, picked: null }; // picked: Set of ids, null = all

const items = () => KINDS[opt.kind].list(store.getState());
const picked = () => items().filter((x) => !opt.picked || opt.picked.has(x.id));

export function openExport(kind = 'class') {
  opt.kind = KINDS[kind] ? kind : 'class';
  opt.picked = null;
  draw();
}

// Exports the timetables of `ids`; with several ids, one file with a page/sheet each, or a .zip of files.
export function exportTimetables(kind, ids, format, split = false) {
  const s = store.getState();
  const ix = buildIndex(s);
  const list = ids.map((id) => timetableOf(s, kind, id, ix));
  if (!list.length) return;
  const make = (l) => (format === 'pdf' ? timetablesPdf(l) : timetablesXlsx(l));
  const centre = fileName(s.meta.name);
  if (list.length === 1) {
    downloadBlob(`${centre} - ${fileName(list[0].name)}.${format}`, make(list), MIME[format]);
  } else if (!split) {
    downloadBlob(`${centre} - ${KINDS[kind].label}.${format}`, make(list), MIME[format]);
  } else {
    const used = new Map();
    const files = list.map((tt) => {
      const base = fileName(tt.name);
      const n = (used.get(base) || 0) + 1;
      used.set(base, n);
      return { name: `${n > 1 ? `${base} (${n})` : base}.${format}`, data: make([tt]) };
    });
    downloadBlob(`${centre} - ${KINDS[kind].label} (${format.toUpperCase()}).zip`, zip(files), 'application/zip');
  }
}

function draw() {
  const list = items();
  const sel = picked();
  const radio = (name, value, cur, label) => `<label class="opt"><input type="radio" name="${name}" value="${value}" data-exp-${name} ${value === cur ? 'checked' : ''}> ${label}</label>`;
  root.innerHTML = `
  <div class="overlay"><div class="modal mid" role="dialog" aria-modal="true" aria-label="Exporta horaris">
    <header><h3>Exporta horaris</h3><button class="x" data-close-btn title="Tanca (Esc)">×</button></header>
    <div class="modal-body exp">
      <div class="exp-row"><span class="lbl">Horaris de</span>
        <div class="seg">${Object.entries(KINDS).map(([k, K]) => `<button data-exp-kind="${k}" class="${k === opt.kind ? 'on' : ''}">${K.label}</button>`).join('')}</div>
      </div>
      <div class="exp-row top"><span class="lbl">Quins</span>
        <div class="exp-pick">
          <div class="exp-pick-head"><span>${sel.length} de ${list.length}</span><button data-exp-all>Tots</button><button data-exp-none>Cap</button></div>
          <div class="exp-items">${list.map((x) => `<label><input type="checkbox" data-exp-item="${x.id}" ${!opt.picked || opt.picked.has(x.id) ? 'checked' : ''}> ${esc(x.name)}</label>`).join('') || '<span class="hint">No n’hi ha cap.</span>'}</div>
        </div>
      </div>
      <div class="exp-row"><span class="lbl">Format</span>
        ${radio('format', 'pdf', opt.format, '📄 PDF')}
        ${radio('format', 'xlsx', opt.format, '📊 Excel (s’obre amb Fulls de càlcul de Google)')}
      </div>
      <div class="exp-row"><span class="lbl">Fitxers</span>
        ${radio('split', 'one', opt.split ? 'many' : 'one', opt.format === 'pdf' ? 'Un sol PDF, una pàgina per horari' : 'Un sol Excel, un full per horari')}
        ${radio('split', 'many', opt.split ? 'many' : 'one', 'Un fitxer per horari (dins d’un .zip)')}
      </div>
      ${opt.format === 'xlsx' ? `<p class="hint">Per tenir-lo a Google Drive: puja el fitxer a Drive i obre’l amb <b>Fulls de càlcul de Google</b>.
        Si vols que es converteixi sol, activa <i>Configuració de Drive → Converteix les pujades</i>.</p>` : ''}
      <div class="actions"><button class="primary" data-exp-go ${sel.length ? '' : 'disabled'}>Exporta ${sel.length} ${sel.length === 1 ? 'horari' : 'horaris'}</button></div>
    </div>
  </div></div>`;
}

const isOpen = () => !!root.querySelector('.modal-body.exp');

root.addEventListener('click', (e) => {
  if (!isOpen()) return;
  const t = e.target;
  const k = t.closest('[data-exp-kind]');
  if (k) { opt.kind = k.dataset.expKind; opt.picked = null; draw(); return; }
  if (t.closest('[data-exp-all]')) { opt.picked = null; draw(); return; }
  if (t.closest('[data-exp-none]')) { opt.picked = new Set(); draw(); return; }
  if (t.closest('[data-exp-go]')) {
    exportTimetables(opt.kind, picked().map((x) => x.id), opt.format, opt.split);
    root.innerHTML = '';
  }
});

root.addEventListener('change', (e) => {
  if (!isOpen()) return;
  const t = e.target;
  if (t.matches('[data-exp-item]')) {
    if (!opt.picked) opt.picked = new Set(items().map((x) => x.id));
    if (t.checked) opt.picked.add(t.dataset.expItem); else opt.picked.delete(t.dataset.expItem);
    draw();
  } else if (t.matches('[data-exp-format]')) {
    opt.format = t.value;
    draw();
  } else if (t.matches('[data-exp-split]')) {
    opt.split = t.value === 'many';
    draw();
  }
});
