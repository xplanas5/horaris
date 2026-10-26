import * as store from './store.js';
import { PALETTE, placedCounts, DUTIES, dutySubject, dutyLesson } from './model.js';
import { RULE_TYPES, describeRule } from './rules.js';
import { uid, esc } from './util.js';

// Finestra modal per editar les dades del centre.

const root = document.getElementById('modal');
const TABS = [
  ['school', 'Centre i franges'], ['subjects', 'Matèries'], ['classes', 'Grups'],
  ['teachers', 'Professorat'], ['rooms', 'Aules'], ['lessons', 'Càrregues lectives'], ['rules', 'Normes'],
];

let tab = 'school';
let slotsOf = null;        // graella de franges oberta: { kind: 'teacher' | 'rule', id }
let lessonFilter = '';     // grup filtrat a càrregues lectives

export const isEditorOpen = () => root.childElementCount > 0;
export function closeEditor() { root.innerHTML = ''; }

export function openEditor(t = 'school') {
  tab = t;
  slotsOf = null;
  draw(true);
}

export function openNewCentre() {
  root.innerHTML = `
  <div class="overlay"><div class="modal small" role="dialog" aria-modal="true" aria-label="Nou centre">
    <header><h3>Nou centre</h3><button class="x" data-close-btn title="Tanca">×</button></header>
    <div class="modal-body">
      <form id="new-centre" class="form">
        <label>Nom del centre <input name="name" required placeholder="Escola …"></label>
        <label>Plantilla
          <select name="tpl">
            <option value="buit">Buit (dies i franges per defecte)</option>
            <option value="exemple">Exemple d'institut (ESO)</option>
          </select>
        </label>
        <div class="actions"><button type="submit" class="primary">Crea</button></div>
      </form>
    </div>
  </div></div>`;
  root.querySelector('input').focus();
}

function draw(resetScroll = false) {
  const top = resetScroll ? 0 : (root.querySelector('.modal-body')?.scrollTop || 0);
  root.innerHTML = `
  <div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="Dades del centre">
    <header>
      <nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <button class="x" data-close-btn title="Tanca (Esc)">×</button>
    </header>
    <div class="modal-body">${slotsOf ? slotsView() : VIEWS[tab]()}</div>
  </div></div>`;
  root.querySelector('.modal-body').scrollTop = top;
}

// ---------- generic editable table ----------

function field(coll, it, c) {
  const a = `data-field data-coll="${coll}" data-id="${it.id}" data-k="${c.k}"`;
  const style = c.w ? ` style="width:${c.w}px"` : '';
  if (c.type === 'checkbox') return `<input type="checkbox" ${a} ${it[c.k] ? 'checked' : ''}>`;
  const value = c.get ? c.get(it) : it[c.k];
  const extra = c.type === 'number' ? ` min="${c.min ?? 0}"` : '';
  return `<input type="${c.type || 'text'}" ${a} value="${esc(value ?? '')}"${style}${extra}${c.ph ? ` placeholder="${esc(c.ph)}"` : ''}>`;
}

function table(coll, cols, { move = false, extra = null, items = null } = {}) {
  const s = store.getState();
  const list = items || s[coll];
  const rows = list.map((it, i) => `<tr>
    ${cols.map((c) => `<td>${c.render ? c.render(it) : field(coll, it, c)}</td>`).join('')}
    ${extra ? `<td>${extra(it)}</td>` : ''}
    <td class="rowacts">
      ${move ? `<button data-move="-1" data-coll="${coll}" data-id="${it.id}" ${i === 0 ? 'disabled' : ''} title="Amunt">↑</button><button data-move="1" data-coll="${coll}" data-id="${it.id}" ${i === list.length - 1 ? 'disabled' : ''} title="Avall">↓</button>` : ''}
      <button class="danger" data-del="${it.id}" data-coll="${coll}" title="Elimina">✕</button>
    </td></tr>`).join('');
  return `<table class="etable" data-table="${coll}">
    <thead><tr>${cols.map((c) => `<th>${c.l}</th>`).join('')}${extra ? '<th></th>' : ''}<th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols.length + 2}" class="hint">Encara no n'hi ha cap.</td></tr>`}</tbody>
  </table>
  <button class="add" data-add-item="${coll}">＋ Afegeix</button>`;
}

function chips(coll, it, k, options) {
  const sel = it[k];
  const label = new Map(options.map((o) => [o.id, o.label]));
  const a = `data-coll="${coll}" data-id="${it.id}" data-k="${k}"`;
  return `<div class="chips">
    ${sel.map((id) => `<span class="chip">${esc(label.get(id) ?? '?')}<button data-chip-rm="${id}" ${a} title="Treu">×</button></span>`).join('')}
    <select data-chip-add ${a}><option value="">＋</option>${options.filter((o) => !sel.includes(o.id)).map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select>
  </div>`;
}

const divisionsText = (c) => c.divisions.map((d) => `${d.name}: ${d.groups.map((g) => g.name).join(', ')}`).join(' | ');

function parseDivisions(cls, text) {
  const old = cls.divisions || [];
  const oldGroups = old.flatMap((d) => d.groups);
  return text.split('|').map((x) => x.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf(':');
    const name = at >= 0 ? part.slice(0, at).trim() || 'Desdoblament' : 'Desdoblament';
    const rest = at >= 0 ? part.slice(at + 1) : part;
    const od = old.find((d) => d.name === name);
    const groups = rest.split(',').map((g) => g.trim()).filter(Boolean).map((gn) => {
      const og = od?.groups.find((g) => g.name === gn) || oldGroups.find((g) => g.name === gn);
      return { id: og?.id || uid('sg'), name: gn };
    });
    return { id: od?.id || uid('dv'), name, groups };
  }).filter((d) => d.groups.length);
}

// ---------- tabs ----------

const VIEWS = {
  school() {
    const m = store.getState().meta;
    const f = (k, l, ph = '') => `<label>${l} <input data-field data-coll="meta" data-id="" data-k="${k}" value="${esc(m[k])}" placeholder="${esc(ph)}"></label>`;
    return `
      <section><h3>Centre</h3><div class="form inline">
        ${f('name', 'Nom')}${f('stage', 'Etapes', 'Infantil, Primària, ESO, Batxillerat, FP…')}${f('year', 'Curs', '2026-2027')}
      </div></section>
      <section><h3>Dies</h3>${table('days', [{ k: 'name', l: 'Nom' }, { k: 'short', l: 'Abrev.', w: 60 }], { move: true })}</section>
      <section><h3>Franges horàries</h3>
        <p class="hint">Les franges no lectives (patis, migdia) no es poden ocupar. Una sessió de 2 franges no pot travessar-ne cap.</p>
        ${table('periods', [{ k: 'name', l: 'Nom', w: 90 }, { k: 'start', l: 'Inici', type: 'time' }, { k: 'end', l: 'Final', type: 'time' }, { k: 'isBreak', l: 'No lectiva', type: 'checkbox' }], { move: true })}
      </section>`;
  },
  subjects() {
    const kind = (x) => `<select data-field data-coll="subjects" data-id="${x.id}" data-k="duty">
      <option value="">Lectiva</option>${Object.entries(DUTIES).map(([k, d]) => `<option value="${k}" ${x.duty === k ? 'selected' : ''}>${d.name}</option>`).join('')}</select>`;
    return `<p class="hint">L'abreviatura és el que es veu a la graella. Les matèries de tipus <b>Guàrdia</b> o <b>Coordinació</b> són hores no lectives del professorat.</p>
      ${table('subjects', [{ k: 'name', l: 'Nom' }, { k: 'short', l: 'Abrev.', w: 70 }, { k: 'color', l: 'Color', type: 'color' }, { l: 'Tipus', render: kind }], { move: true })}`;
  },
  classes() {
    return `<p class="hint">Desdoblaments: grups que es parteixen a la mateixa hora. Format: <code>Optatives: Francès, Robòtica | Anglès: A1, A2</code></p>
      ${table('classes', [{ k: 'name', l: 'Nom' }, { k: 'short', l: 'Abrev.', w: 60 },
        { k: 'divisions', l: 'Desdoblaments', w: 340, get: divisionsText, ph: 'Optatives: Francès, Robòtica' }], { move: true })}`;
  },
  teachers() {
    const s = store.getState();
    const duty = (t, type) => `<input type="number" min="0" max="20" data-duty="${type}" data-id="${t.id}" value="${dutyLesson(s, t.id, type)?.perWeek || 0}" style="width:50px">`;
    return `<p class="hint"><b>Guàrdies</b> i <b>Coordinació</b>: hores setmanals no lectives. ⚡ Omple les col·loca després de les classes,
        repartint les guàrdies perquè sempre hi hagi algú disponible (norma <i>Cobertura de guàrdies</i>).</p>
      ${table('teachers', [{ k: 'name', l: 'Nom' }, { k: 'short', l: 'Abrev.', w: 60 },
        { l: 'Guàrdies', render: (t) => duty(t, 'guard') }, { l: 'Coordinació', render: (t) => duty(t, 'coord') }], {
        move: true,
        extra: (t) => `<button data-slots="teacher" data-id="${t.id}">Disponibilitat${t.unavailable.length ? ` (${t.unavailable.length} ✕)` : ''}</button>`,
      })}`;
  },
  rooms() {
    return table('rooms', [{ k: 'name', l: 'Nom' }, { k: 'short', l: 'Abrev.', w: 60 }, { k: 'capacity', l: 'Capacitat', type: 'number', w: 70 }], { move: true });
  },
  lessons() {
    const s = store.getState();
    if (!s.subjects.length) return '<p class="hint">Primer cal crear alguna matèria.</p>';
    const counts = placedCounts(s);
    const items = lessonFilter ? s.lessons.filter((l) => l.classIds.includes(lessonFilter)) : s.lessons;
    const hours = items.reduce((n, l) => n + l.perWeek * l.duration, 0);
    const classOpts = s.classes.map((c) => ({ id: c.id, label: c.short || c.name }));
    const teacherOpts = s.teachers.map((t) => ({ id: t.id, label: t.short || t.name }));
    const roomOpts = s.rooms.map((r) => ({ id: r.id, label: r.short || r.name }));
    const groupOpts = (l) => s.classes.filter((c) => l.classIds.includes(c.id))
      .flatMap((c) => c.divisions.flatMap((d) => d.groups.map((g) => ({ id: g.id, label: `${c.short} · ${g.name}` }))));
    const subjectSel = (l) => `<select data-field data-coll="lessons" data-id="${l.id}" data-k="subjectId">${s.subjects.map((x) => `<option value="${x.id}" ${x.id === l.subjectId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`;

    return `
      <div class="toolbar-row">
        <label>Grup <select id="lesson-filter"><option value="">Tots</option>${s.classes.map((c) => `<option value="${c.id}" ${c.id === lessonFilter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <span class="hint">${items.length} càrregues · ${hours} hores setmanals</span>
      </div>
      <p class="hint">Cada fila és una matèria que un o més grups fan amb uns docents. Subgrup buit = grup sencer. Les aules van per ordre de preferència.</p>
      ${table('lessons', [
        { l: 'Matèria', render: subjectSel },
        { l: 'Grups', render: (l) => chips('lessons', l, 'classIds', classOpts) },
        { l: 'Subgrup', render: (l) => chips('lessons', l, 'groupIds', groupOpts(l)) },
        { l: 'Docents', render: (l) => chips('lessons', l, 'teacherIds', teacherOpts) },
        { l: 'Aules', render: (l) => chips('lessons', l, 'roomIds', roomOpts) },
        { k: 'perWeek', l: 'Sessions', type: 'number', w: 54 },
        { k: 'duration', l: 'Durada', type: 'number', w: 54, min: 1 },
        { l: 'Posades', render: (l) => `<span class="${(counts.get(l.id) || 0) < l.perWeek ? 'pending' : 'done'}">${counts.get(l.id) || 0}/${l.perWeek}</span>` },
      ], { items })}`;
  },
};

function ruleCard(s, r) {
  const T = RULE_TYPES[r.type];
  const opts = (list) => list.map((x) => ({ id: x.id, label: x.short || x.name }));
  const fld = (label, html) => `<label class="rf"><span>${label}</span>${html}</label>`;
  const a = (k) => `data-field data-coll="rules" data-id="${r.id}" data-k="${k}"`;
  const subjects = fld('Matèries', chips('rules', r, 'subjectIds', opts(s.subjects)) + (r.subjectIds.length ? '' : '<small>totes</small>'));
  const classes = fld('Grups', chips('rules', r, 'classIds', opts(s.classes)) + (r.classIds.length ? '' : '<small>tots</small>'));
  const slots = (what) => fld('Franges', `<button data-slots="rule" data-id="${r.id}">${what} (${r.slots.length})</button>`);
  const fields = {
    noConsecutive: () => subjects + classes,
    subjectSlots: () => subjects + classes
      + fld('Condició', `<select ${a('mode')}><option value="only" ${r.mode !== 'never' ? 'selected' : ''}>Només a les franges marcades</option><option value="never" ${r.mode === 'never' ? 'selected' : ''}>Mai a les franges marcades</option></select>`)
      + slots('Tria franges'),
    guardCoverage: () => fld('Mínim de docents de guàrdia per hora', `<input type="number" min="1" ${a('min')} value="${r.min}" style="width:60px">`),
    maxPerDay: () => subjects + classes + fld('Màxim al dia', `<input type="number" min="1" ${a('max')} value="${r.max}" style="width:60px">`),
    teacherBlock: () => fld('Motiu', `<input ${a('label')} value="${esc(r.label || '')}" placeholder="Reunió de cicle" style="width:170px">`)
      + fld('Docents', chips('rules', r, 'teacherIds', opts(s.teachers)))
      + slots('Tria hores'),
  };
  return `<div class="rule ${r.on ? '' : 'off'}">
    <div class="rhead">
      <input type="checkbox" ${a('on')} ${r.on ? 'checked' : ''} title="Activa / desactiva">
      <span class="ricon">${T?.icon || '?'}</span>
      <b>${esc(T?.name || r.type)}</b>
      <span class="rdesc">${esc(describeRule(s, r))}</span>
      ${r.type === 'guardCoverage' ? '<span class="hint">Es mostra a la vista de professorat</span>' : `<select ${a('hard')} class="${r.hard ? 'hard' : 'soft'}" title="Obligatòria: mai s'incompleix. Preferent: s'evita si es pot.">
        <option value="1" ${r.hard ? 'selected' : ''}>Obligatòria</option><option value="0" ${r.hard ? '' : 'selected'}>Preferent</option>
      </select>`}
      <button class="danger" data-del="${r.id}" data-coll="rules" title="Elimina">✕</button>
    </div>
    <div class="rbody">${fields[r.type]?.() || ''}</div>
  </div>`;
}

VIEWS.rules = () => {
  const s = store.getState();
  return `
    <p class="hint">Les normes s'apliquen quan col·loques sessions a mà i quan fas <b>⚡ Omple</b>.
      <b>Obligatòria</b>: la cel·la queda vermella i el generador no la incompleix mai.
      <b>Preferent</b>: es permet, però surt com a avís (△) i el generador l'evita si pot.</p>
    <div class="radd">${Object.entries(RULE_TYPES).map(([k, T]) => `<button data-add-rule="${k}">${T.icon} ${T.name}</button>`).join('')}</div>
    <div class="rules">${s.rules.map((r) => ruleCard(s, r)).join('') || '<p class="hint">Encara no hi ha cap norma.</p>'}</div>
    <p class="hint">Les hores en què un sol docent no pot fer classe també es poden marcar a <b>Professorat → Disponibilitat</b>
      o, des de la vista de professorat, amb <b>🔒 Bloqueja hores</b>.</p>`;
};

// Slot grid shared by teacher availability and rule time slots.
function slotTarget(s) {
  if (!slotsOf) return null;
  if (slotsOf.kind === 'teacher') {
    const t = s.teachers.find((x) => x.id === slotsOf.id);
    return t && { list: t.unavailable, set: (st, v) => { st.teachers.find((x) => x.id === t.id).unavailable = v; },
      title: `Disponibilitat de ${t.name}`, hint: 'Clica les franges en què <b>no</b> pot fer classe.', on: 'No', off: 'Sí', cls: 'off', back: 'Torna al professorat' };
  }
  const r = s.rules.find((x) => x.id === slotsOf.id);
  if (!r) return null;
  const only = r.type === 'subjectSlots' && r.mode !== 'never';
  return { list: r.slots, set: (st, v) => { st.rules.find((x) => x.id === r.id).slots = v; },
    title: describeRule(s, r),
    hint: only ? 'Marca les franges on <b>sí</b> que pot anar.' : 'Marca les franges <b>prohibides</b>.',
    on: only ? 'Sí' : 'No', off: '', cls: only ? 'yes' : 'off', back: 'Torna a les normes' };
}

function slotsView() {
  const s = store.getState();
  const T = slotTarget(s);
  if (!T) { slotsOf = null; return VIEWS[tab](); }
  const rows = s.periods.map((p) => `<tr><th>${p.isBreak ? esc(p.name) : `<button class="hdr" data-slot-row="${p.id}" title="Marca o desmarca tota la fila">${esc(p.name)}</button>`} <small>${esc(p.start)}–${esc(p.end)}</small></th>${s.days.map((d) => {
    if (p.isBreak) return '<td class="brk"></td>';
    const key = `${d.id}|${p.id}`;
    const sel = T.list.includes(key);
    return `<td><button class="slot ${sel ? T.cls : ''}" data-slot="${key}">${sel ? T.on : T.off}</button></td>`;
  }).join('')}</tr>`).join('');
  return `<button data-back>← ${T.back}</button>
    <h3>${esc(T.title)}</h3>
    <p class="hint">${T.hint} Clica el nom d'un dia o d'una franja per marcar-ne tota la columna o fila.</p>
    <table class="avail ${slotsOf.kind}"><thead><tr><th></th>${s.days.map((d) => `<th><button class="hdr" data-slot-col="${d.id}" title="Marca o desmarca tot el dia">${esc(d.name)}</button></th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

// Toggle a set of slots: if all are already marked, unmark them; otherwise mark them all.
function toggleSlots(keys) {
  const T = slotTarget(store.getState());
  if (!T || !keys.length) return;
  const all = keys.every((k) => T.list.includes(k));
  store.update((st) => {
    const cur = slotTarget(st).list;
    T.set(st, all ? cur.filter((k) => !keys.includes(k)) : [...new Set([...cur, ...keys])]);
  });
  draw();
}

// ---------- mutations ----------

const MAKERS = {
  days: () => ({ id: uid('d'), name: 'Nou dia', short: 'Nd' }),
  periods: (s) => ({ id: uid('p'), name: `${s.periods.filter((p) => !p.isBreak).length + 1}a`, start: '', end: '', isBreak: false }),
  subjects: (s) => ({ id: uid('s'), name: 'Nova matèria', short: 'NM', color: PALETTE[s.subjects.length % PALETTE.length] }),
  classes: () => ({ id: uid('g'), name: 'Nou grup', short: 'NG', divisions: [] }),
  teachers: () => ({ id: uid('t'), name: 'Nou docent', short: 'ND', unavailable: [] }),
  rooms: () => ({ id: uid('r'), name: 'Nova aula', short: 'NA', capacity: '' }),
  rules: () => ({}),
  lessons: (s) => ({
    id: uid('l'), subjectId: s.subjects[0]?.id, classIds: lessonFilter ? [lessonFilter] : [],
    groupIds: [], teacherIds: [], roomIds: [], perWeek: 1, duration: 1,
  }),
};

function addItem(coll) {
  store.update((s) => { s[coll].push(MAKERS[coll](s)); });
  draw();
  const rows = root.querySelectorAll(`[data-table="${coll}"] tbody tr`);
  const input = rows[rows.length - 1]?.querySelector('input:not([type=checkbox]), select');
  input?.scrollIntoView({ block: 'nearest' });
  input?.focus();
  input?.select?.();
}

function delItem(coll, id) {
  const s = store.getState();
  const refKey = { subjects: 'subjectId' }[coll];
  if (refKey) {
    const n = s.lessons.filter((l) => l[refKey] === id).length;
    if (n && !confirm(`Aquesta matèria té ${n} càrregues lectives que també s'eliminaran. Vols continuar?`)) return;
  }
  if (coll === 'lessons') {
    const n = s.cards.filter((c) => c.lessonId === id).length;
    if (n && !confirm(`Aquesta càrrega té ${n} sessions a l'horari que també es trauran. Vols continuar?`)) return;
  }
  store.update((st) => { st[coll] = st[coll].filter((x) => x.id !== id); });
  draw();
}

function moveItem(coll, id, dir) {
  store.update((s) => {
    const a = s[coll];
    const i = a.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
  });
  draw();
}

function setField(el) {
  const { coll, id, k } = el.dataset;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') v = el.value === '' ? '' : parseInt(el.value, 10);
  if (k === 'hard') v = el.value === '1';
  let redraw = false;
  store.update((s) => {
    const it = coll === 'meta' ? s.meta : s[coll].find((x) => x.id === id);
    if (!it) return;
    if (k === 'divisions') { it.divisions = parseDivisions(it, v); redraw = true; } else it[k] = v;
  });
  if (redraw || coll === 'lessons' || coll === 'rules') draw();
}

// Weekly guard or coordination hours of a teacher, kept as a duty lesson of that teacher.
function setDuty(teacherId, type, n) {
  store.update((s) => {
    const l = dutyLesson(s, teacherId, type);
    if (n <= 0) { if (l) s.lessons = s.lessons.filter((x) => x !== l); return; }
    if (l) { l.perWeek = n; return; }
    s.lessons.push({ id: uid('l'), subjectId: dutySubject(s, type, true).id, classIds: [], groupIds: [], teacherIds: [teacherId], roomIds: [], perWeek: n, duration: 1 });
  });
  draw();
}

// ---------- events ----------

root.addEventListener('click', (e) => {
  const t = e.target;
  if (t.classList.contains('overlay') || t.closest('[data-close-btn]')) { closeEditor(); return; }
  const tb = t.closest('[data-tab]');
  if (tb) { tab = tb.dataset.tab; slotsOf = null; draw(true); return; }
  const add = t.closest('[data-add-item]');
  if (add) { addItem(add.dataset.addItem); return; }
  const del = t.closest('[data-del]');
  if (del) { delItem(del.dataset.coll, del.dataset.del); return; }
  const mv = t.closest('[data-move]');
  if (mv) { moveItem(mv.dataset.coll, mv.dataset.id, Number(mv.dataset.move)); return; }
  const rm = t.closest('[data-chip-rm]');
  if (rm) {
    const { coll, id, k } = rm.dataset;
    store.update((s) => { const it = s[coll].find((x) => x.id === id); it[k] = it[k].filter((x) => x !== rm.dataset.chipRm); });
    draw();
    return;
  }
  const addRule = t.closest('[data-add-rule]');
  if (addRule) {
    const type = addRule.dataset.addRule;
    store.update((s) => {
      s.rules.push({ id: uid('n'), type, on: true, hard: false, subjectIds: [], classIds: [], teacherIds: [], slots: [], ...RULE_TYPES[type].make() });
    });
    draw();
    root.querySelector('.rule:last-child')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const sl = t.closest('[data-slots]');
  if (sl) { slotsOf = { kind: sl.dataset.slots, id: sl.dataset.id }; draw(true); return; }
  if (t.closest('[data-back]')) { slotsOf = null; draw(true); return; }
  const s = store.getState();
  if (!s) return;
  const nonBreak = s.periods.filter((p) => !p.isBreak);
  const col = t.closest('[data-slot-col]');
  if (col) { toggleSlots(nonBreak.map((p) => `${col.dataset.slotCol}|${p.id}`)); return; }
  const row = t.closest('[data-slot-row]');
  if (row) { toggleSlots(s.days.map((d) => `${d.id}|${row.dataset.slotRow}`)); return; }
  const slot = t.closest('[data-slot]');
  if (slot) toggleSlots([slot.dataset.slot]);
});

root.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'lesson-filter') { lessonFilter = el.value; draw(true); return; }
  if (el.matches('[data-chip-add]')) {
    if (!el.value) return;
    const { coll, id, k } = el.dataset;
    store.update((s) => { const it = s[coll].find((x) => x.id === id); it[k] = [...it[k], el.value]; });
    draw();
    return;
  }
  if (el.matches('[data-duty]')) { setDuty(el.dataset.id, el.dataset.duty, parseInt(el.value, 10) || 0); return; }
  if (el.matches('[data-field]')) setField(el);
});

root.addEventListener('submit', (e) => {
  if (e.target.id !== 'new-centre') return;
  e.preventDefault();
  const f = new FormData(e.target);
  closeEditor();
  store.createCentre(String(f.get('name') || '').trim(), f.get('tpl')).catch((err) => alert(`No s'ha pogut crear el centre: ${err.message}`));
});
