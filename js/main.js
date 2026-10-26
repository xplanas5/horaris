import * as store from './store.js';
import { buildIndex, placedCounts, classesLabel, shortOf } from './model.js';
import { buildOccupancy, evaluatePlacement, computeIssues } from './conflicts.js';
import { teacherBlocks, guardCoverage } from './rules.js';
import { greedyFill } from './solver/greedy.js';
import { openEditor, openNewCentre, isEditorOpen, closeEditor } from './editor.js';
import { openAdmin, openAccount, loginHtml } from './admin.js';
import { openExport, exportTimetables } from './export/dialog.js';
import { openAbsences } from './absences.js';
import { uid, esc, textColor, downloadBlob } from './util.js';

const app = document.getElementById('app');

// Estat de la interfície (no es desa).
const ui = {
  view: 'class',      // 'class' | 'teacher' | 'subject' | 'room'
  sel: null,          // { type: 'card' | 'lesson', id }
  row: null,          // fila seleccionada (filtra la safata)
  drag: null,         // { lessonId, cardId }
  evals: null,        // Map slotKey -> evaluation for the active piece
  lock: false,        // mode «bloqueja hores»: clicar una cel·la de la vista de professorat la bloqueja
  msg: '',
  loginError: '',
};

const VIEWS = [['class', 'Grups'], ['teacher', 'Professorat'], ['subject', 'Matèries'], ['room', 'Aules']];

const rowsFor = (s) => ({ class: s.classes, teacher: s.teachers, subject: s.subjects, room: s.rooms }[ui.view]);

function rowIdsOfLesson(lesson) {
  if (ui.view === 'class') return lesson.classIds;
  if (ui.view === 'teacher') return lesson.teacherIds;
  if (ui.view === 'subject') return [lesson.subjectId];
  return lesson.roomIds;
}

function rowIdsOfCard(card, lesson) {
  if (ui.view === 'room') return card.roomId ? [card.roomId] : [];
  return rowIdsOfLesson(lesson);
}

// ---------- render ----------

function render() {
  if (!store.getUser()) {
    app.innerHTML = loginHtml(ui.loginError);
    app.querySelector('input[name=email]')?.focus();
    return;
  }
  const s = store.getState();
  if (!s) { app.innerHTML = `${userBar()}${noCentre()}`; return; }
  const ix = buildIndex(s);
  const issues = computeIssues(s, ix);
  issues.cov = guardCoverage(s, ix, buildOccupancy(s, ix));

  if (ui.sel?.type === 'card' && !s.cards.some((c) => c.id === ui.sel.id)) ui.sel = null;
  if (ui.sel?.type === 'lesson') {
    const l = ix.lesson.get(ui.sel.id);
    if (!l || (placedCounts(s).get(l.id) || 0) >= l.perWeek) ui.sel = null;
  }
  if (ui.row && !rowsFor(s).some((r) => r.id === ui.row)) ui.row = null;

  const wrap = app.querySelector('.grid-wrap');
  const scroll = wrap ? [wrap.scrollLeft, wrap.scrollTop] : [0, 0];

  app.innerHTML = `
    ${toolbar(s)}
    <main class="grid-wrap ${ui.lock && ui.view === 'teacher' ? 'locking' : ''}">${grid(s, ix, issues)}</main>
    <section class="bottom">${detail(s, ix, issues)}${tray(s, ix)}</section>
    ${statusbar(s, issues)}`;

  const nw = app.querySelector('.grid-wrap');
  [nw.scrollLeft, nw.scrollTop] = scroll;
  applyHighlight();
}

function userGroup() {
  if (store.isLocal()) {
    return `<div class="group user"><span class="local-tag" title="Sense servidor: els centres es desen només en aquest navegador. Fes-ne còpies amb «Còpia JSON».">💻 Desat en aquest navegador</span></div>`;
  }
  const u = store.getUser();
  return `<div class="group user">
      ${store.isAdmin() ? '<button data-act="admin" title="Gestiona centres i usuaris">⚙ Administració</button>' : ''}
      <button data-act="account" title="${esc(u.email)}">👤 ${esc(u.name || u.email)}</button>
      <button data-act="logout" title="Tanca la sessió">Surt</button>
    </div>`;
}

function userBar() {
  return `<header class="topbar"><div class="brand">Horaris</div><div class="spacer"></div>${userGroup()}</header>`;
}

function noCentre() {
  return store.isAdmin()
    ? `<div class="empty"><p>Encara no hi ha cap centre.</p><button class="primary" data-act="new-centre">＋ Crea el primer centre</button></div>`
    : `<div class="empty"><p>El teu usuari encara no té cap centre assignat.</p><p class="hint">Demana a l’administrador que te’n vinculi un.</p></div>`;
}

function toolbar(s) {
  const centres = store.listCentres();
  const cur = store.currentCentreId();
  return `
  <header class="topbar">
    <div class="brand">Horaris</div>
    <div class="group">
      <select id="centre-sel" title="Centre">${centres.map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      ${store.isAdmin() ? `<button data-act="new-centre" title="Nou centre">＋ Nou</button>
      <button data-act="del-centre" title="Elimina aquest centre">Elimina</button>` : ''}
    </div>
    <div class="group">
      <button class="tool" data-edit="school"><span>🏫</span>Centre</button>
      <button class="tool" data-edit="subjects"><span>📘</span>Matèries</button>
      <button class="tool" data-edit="classes"><span>👥</span>Grups</button>
      <button class="tool" data-edit="teachers"><span>🎓</span>Professorat</button>
      <button class="tool" data-edit="rooms"><span>🚪</span>Aules</button>
      <button class="tool" data-edit="lessons"><span>📋</span>Càrregues</button>
      <button class="tool" data-act="absences" title="Baixes del professorat i substitucions"><span>🩺</span>Baixes</button>
      <button class="tool" data-edit="rules"><span>📏</span>Normes${s.rules.some((r) => r.on) ? ` (${s.rules.filter((r) => r.on).length})` : ''}</button>
    </div>
    <div class="group seg" role="tablist" aria-label="Vista">
      ${VIEWS.map(([k, l]) => `<button data-view="${k}" class="${ui.view === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    ${ui.view === 'teacher' ? `<div class="group"><button data-act="lock" class="${ui.lock ? 'on' : ''}" title="Clica cel·les per marcar hores en què el docent no pot fer classe">🔒 Bloqueja hores</button></div>` : ''}
    <div class="group">
      <button data-act="undo" ${store.canUndo() ? '' : 'disabled'} title="Desfés (Ctrl+Z)">↶</button>
      <button data-act="redo" ${store.canRedo() ? '' : 'disabled'} title="Refés (Ctrl+Y)">↷</button>
      <button data-act="fill" title="Col·loca automàticament les sessions pendents respectant les normes">⚡ Omple</button>
      <button data-act="clear" title="Treu totes les sessions de l'horari">Buida</button>
    </div>
    <div class="group">
      <button data-act="export-tt" title="Horaris individuals de grups, docents, matèries o aules en PDF o Excel">📄 Exporta horaris</button>
      <button data-act="export" title="Desa una còpia de seguretat de totes les dades en un fitxer JSON">Còpia JSON</button>
      <button data-act="import" title="Substitueix les dades d’aquest centre per les d’un fitxer JSON">Importa JSON</button>
      <button data-act="print">Imprimeix</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>
    <div class="spacer"></div>
    ${userGroup()}
  </header>`;
}

function grid(s, ix, issues) {
  const rows = rowsFor(s);
  if (!s.days.length || !s.periods.length) return `<p class="empty">Defineix els dies i les franges a <b>Centre</b>.</p>`;
  if (!rows.length) {
    const what = { class: 'grups', teacher: 'docents', subject: 'matèries', room: 'aules' }[ui.view];
    return `<p class="empty">Encara no hi ha ${what}. Afegeix-ne des de la barra superior.</p>`;
  }

  const cellMap = new Map();
  for (const card of s.cards) {
    const lesson = ix.lesson.get(card.lessonId);
    const pi = ix.periodIdx.get(card.periodId);
    if (!lesson || pi == null) continue;
    for (let k = 0; k < lesson.duration; k++) {
      const p = s.periods[pi + k];
      if (!p) break;
      for (const rid of rowIdsOfCard(card, lesson)) {
        const key = `${rid}|${card.dayId}|${p.id}`;
        if (!cellMap.has(key)) cellMap.set(key, []);
        cellMap.get(key).push({ card, lesson, k });
      }
    }
  }

  const blocks = ui.view === 'teacher' ? teacherBlocks(s) : new Map();
  const last = s.periods.length - 1;
  const corner = { class: 'Grup', teacher: 'Docent', subject: 'Matèria', room: 'Aula' }[ui.view];
  const head1 = s.days.map((d) => `<th class="day dend" colspan="${s.periods.length}">${esc(d.name)}</th>`).join('');
  const head2 = s.days.map(() => s.periods.map((p, i) =>
    `<th class="per ${p.isBreak ? 'brk' : ''} ${i === last ? 'dend' : ''}" title="${esc(p.name)} ${esc(p.start)}–${esc(p.end)}">${p.isBreak ? '' : esc(p.name)}</th>`).join('')).join('');

  const body = rows.map((r) => {
    const cells = s.days.map((d) => s.periods.map((p, i) => {
      const items = cellMap.get(`${r.id}|${d.id}|${p.id}`) || [];
      const na = ui.view === 'teacher' && r.unavailable.includes(`${d.id}|${p.id}`);
      const blk = blocks.get(`${r.id}|${d.id}|${p.id}`);
      const cls = ['cell', p.isBreak && 'brk', i === last && 'dend', na && 'na', blk && 'blk'].filter(Boolean).join(' ');
      const tip = [na && 'No disponible', ...(blk || [])].filter(Boolean).join(' · ');
      const inner = items.length
        ? `<div class="stack ${items.length > 1 ? 'multi' : ''}">${items.map((it) => cardHtml(ix, it, issues)).join('')}</div>`
        : (blk ? `<span class="blk-label">${esc(blk[0])}</span>` : '');
      return `<td class="${cls}" data-day="${d.id}" data-period="${p.id}" data-row="${r.id}"${tip ? ` title="${esc(tip)}"` : ''}>${inner}</td>`;
    }).join('')).join('');
    return `<tr class="${ui.row === r.id ? 'rowsel' : ''}"><th class="rowh" data-rowsel="${r.id}" title="${esc(r.name)}">${esc(r.short || r.name)}</th>${cells}</tr>`;
  }).join('');

  // Teacher view: how many teachers are on guard at each hour (red when below the coverage rule).
  let foot = '';
  if (ui.view === 'teacher' && issues.cov) {
    const { count, min } = issues.cov;
    foot = `<tfoot><tr><th class="rowh" title="Docents de guàrdia a cada hora (mínim ${min})">🛡 Guàrdia</th>${s.days.map((d) => s.periods.map((p, i) => {
      if (p.isBreak) return `<td class="cell brk ${i === last ? 'dend' : ''}"></td>`;
      const n = count.get(`${d.id}|${p.id}`) || 0;
      return `<td class="cov ${n < min ? 'short' : ''} ${i === last ? 'dend' : ''}" title="${n} de guàrdia">${n}</td>`;
    }).join('')).join('')}</tr></tfoot>`;
  }

  return `<table class="grid">
    <thead><tr><th class="corner" rowspan="2">${corner}</th>${head1}</tr><tr>${head2}</tr></thead>
    <tbody>${body}</tbody>${foot}</table>`;
}

function cardHtml(ix, { card, lesson, k }, { conflicts, warnings }) {
  const subj = ix.subject.get(lesson.subjectId);
  const bg = subj?.color || '#cccccc';
  let sub;
  if (ui.view === 'class') {
    const groups = lesson.groupIds.map((g) => ix.group.get(g)?.group.name).filter(Boolean);
    sub = groups.length ? groups.join(',') : lesson.teacherIds.map((t) => shortOf(ix.teacher, t)).join(',');
  } else {
    sub = lesson.classIds.map((c) => shortOf(ix.cls, c)).join(',');
  }
  const bad = conflicts.get(card.id);
  const warn = warnings.get(card.id);
  const classes = ['card', k > 0 && 'cont', ui.sel?.type === 'card' && ui.sel.id === card.id && 'sel', bad && 'bad', !bad && warn && 'warn'].filter(Boolean).join(' ');
  const tip = [
    subj?.name, classesLabel(ix, lesson),
    lesson.teacherIds.map((t) => ix.teacher.get(t)?.name).join(', '),
    card.roomId ? ix.room.get(card.roomId)?.name : 'Sense aula',
    ...(bad || []).map((r) => `⚠ ${r}`),
    ...(warn || []).map((r) => `△ ${r}`),
  ].filter(Boolean).join('\n');
  return `<div class="${classes}" draggable="true" data-card="${card.id}" style="background:${esc(bg)};color:${textColor(bg)}" title="${esc(tip)}"><b>${esc(subj?.short || '?')}</b><i>${esc(sub)}</i></div>`;
}

function tray(s, ix) {
  const counts = placedCounts(s);
  let items = s.lessons.filter((l) => l.perWeek - (counts.get(l.id) || 0) > 0);
  if (ui.row) items = items.filter((l) => rowIdsOfLesson(l).includes(ui.row));
  const total = items.reduce((n, l) => n + l.perWeek - (counts.get(l.id) || 0), 0);
  const rowName = ui.row ? (rowsFor(s).find((r) => r.id === ui.row)?.short || '') : '';

  const cards = items.map((l) => {
    const subj = ix.subject.get(l.subjectId);
    const bg = subj?.color || '#cccccc';
    const left = l.perWeek - (counts.get(l.id) || 0);
    const sel = ui.sel?.type === 'lesson' && ui.sel.id === l.id ? 'sel' : '';
    const tip = `${subj?.name}\n${classesLabel(ix, l)}\n${l.teacherIds.map((t) => ix.teacher.get(t)?.name).join(', ')}\nQueden ${left} de ${l.perWeek}`;
    return `<div class="tcard ${sel}" draggable="true" data-lesson="${l.id}" style="--dur:${l.duration};background:${esc(bg)};color:${textColor(bg)}" title="${esc(tip)}">
      <b>${esc(subj?.short || '?')}</b><i>${esc(classesLabel(ix, l))}</i>${left > 1 ? `<span class="n">×${left}</span>` : ''}</div>`;
  }).join('');

  return `<div class="tray" data-drop="tray">
    <div class="tray-head">
      <span>Per col·locar: <b>${total}</b></span>
      ${ui.row ? `<span class="chip">Només ${esc(rowName)} <button data-act="clear-row" title="Treu el filtre">×</button></span>` : '<span class="hint">Clica una fila per filtrar</span>'}
    </div>
    <div class="tray-items">${cards || '<span class="hint">No queda cap sessió per col·locar. 🎉</span>'}</div>
  </div>`;
}

function slotLabel(s, ix, card, lesson) {
  const d = s.days[ix.dayIdx.get(card.dayId)];
  const pi = ix.periodIdx.get(card.periodId);
  const p = s.periods[pi];
  const end = s.periods[pi + lesson.duration - 1] || p;
  return `${d?.name}, ${p?.name}${lesson.duration > 1 ? `–${end.name}` : ''} (${p?.start}–${end?.end})`;
}

function detail(s, ix, { conflicts, warnings }) {
  const box = (inner) => `<aside class="detail">${inner}</aside>`;

  if (ui.sel?.type === 'card') {
    const card = s.cards.find((c) => c.id === ui.sel.id);
    const lesson = ix.lesson.get(card.lessonId);
    const subj = ix.subject.get(lesson.subjectId);
    const bad = conflicts.get(card.id) || [];
    const warn = warnings.get(card.id) || [];
    const roomOpts = [`<option value="">— Sense aula —</option>`,
      ...s.rooms.map((r) => `<option value="${r.id}" ${r.id === card.roomId ? 'selected' : ''}>${esc(r.name)}${lesson.roomIds.includes(r.id) ? '' : ' *'}</option>`)].join('');
    return box(`
      <div class="dhead"><span class="swatch" style="background:${esc(subj?.color)}"></span><h2>${esc(subj?.name)}</h2></div>
      <dl>
        <dt>Grup</dt><dd>${esc(classesLabel(ix, lesson)) || '—'}</dd>
        <dt>Docents</dt><dd>${esc(lesson.teacherIds.map((t) => ix.teacher.get(t)?.name).join(', ')) || '—'}</dd>
        <dt>Quan</dt><dd>${esc(slotLabel(s, ix, card, lesson))}</dd>
        <dt>Aula</dt><dd><select data-act="room">${roomOpts}</select></dd>
      </dl>
      ${bad.length || warn.length ? `<ul class="warn">${bad.map((r) => `<li>⚠ ${esc(r)}</li>`).join('')}${warn.map((r) => `<li class="soft">△ ${esc(r)}</li>`).join('')}</ul>` : ''}
      <div class="dacts"><button data-act="unplace">Treu de l'horari</button></div>`);
  }

  if (ui.sel?.type === 'lesson') {
    const lesson = ix.lesson.get(ui.sel.id);
    const subj = ix.subject.get(lesson.subjectId);
    const left = lesson.perWeek - (placedCounts(s).get(lesson.id) || 0);
    return box(`
      <div class="dhead"><span class="swatch" style="background:${esc(subj?.color)}"></span><h2>${esc(subj?.name)}</h2></div>
      <dl>
        <dt>Grup</dt><dd>${esc(classesLabel(ix, lesson)) || '—'}</dd>
        <dt>Docents</dt><dd>${esc(lesson.teacherIds.map((t) => ix.teacher.get(t)?.name).join(', ')) || '—'}</dd>
        <dt>Pendents</dt><dd>${left} de ${lesson.perWeek} (durada ${lesson.duration})</dd>
      </dl>
      <p class="hint">Clica una cel·la verda o arrossega-hi la sessió.</p>`);
  }

  if (ui.row) {
    const r = rowsFor(s).find((x) => x.id === ui.row);
    const lessons = s.lessons.filter((l) => rowIdsOfLesson(l).includes(r.id));
    const counts = placedCounts(s);
    const total = lessons.reduce((n, l) => n + l.perWeek * l.duration, 0);
    const placed = lessons.reduce((n, l) => n + Math.min(counts.get(l.id) || 0, l.perWeek) * l.duration, 0);
    return box(`<div class="dhead"><h2>${esc(r.name)}</h2></div>
      <dl><dt>Hores</dt><dd>${placed} col·locades de ${total}</dd><dt>Càrregues</dt><dd>${lessons.length}</dd></dl>
      <div class="dacts"><button data-act="row-pdf" title="Horari individual en PDF">📄 PDF</button> <button data-act="row-xlsx" title="Horari individual en Excel (Google Fulls)">📊 Excel</button></div>`);
  }

  if (ui.lock && ui.view === 'teacher') {
    return box(`<div class="dhead"><h2>🔒 Bloqueja hores</h2></div>
      <p class="hint">Clica una cel·la d'un docent per marcar-la com a no disponible (o desmarcar-la).
      Per a reunions de diversos docents, fes servir <b>Normes → Bloqueig de docents</b>.</p>
      <div class="dacts"><button data-act="lock">Acaba</button></div>`);
  }

  return box(`<div class="dhead"><h2>${esc(s.meta.name)}</h2></div>
    <p class="hint">Arrossega les sessions de la safata a la graella, o clica-les i després clica una cel·la verda.
    Supr treu la sessió seleccionada · Esc desselecciona · Ctrl+Z desfà.</p>`);
}

function statusbar(s, { conflicts, warnings, cov }) {
  const total = s.lessons.reduce((n, l) => n + l.perWeek, 0);
  const placed = s.cards.length;
  return `<footer class="status">
    <span class="msg" id="msg">${esc(ui.msg)}</span>
    <span>Col·locades <b>${placed}</b> / ${total}</span>
    <span class="${conflicts.size ? 'bad' : 'good'}">${conflicts.size} ${conflicts.size === 1 ? 'conflicte' : 'conflictes'}</span>
    <span class="${warnings.size ? 'soft' : 'good'}" title="Sessions que incompleixen alguna norma preferent">${warnings.size} ${warnings.size === 1 ? 'avís' : 'avisos'}</span>
    ${cov ? `<span class="${cov.short.length ? 'soft' : 'good'}" title="Hores lectives amb menys de ${cov.min} docents de guàrdia">🛡 ${cov.short.length ? `${cov.short.length} h sense prou guàrdia` : 'Guàrdies cobertes'}</span>` : ''}
    ${saveStatus()}
    <label class="zoom">Mida <input type="range" id="zoom" min="28" max="90" value="${cellW}"></label>
  </footer>`;
}

function saveStatus() {
  const { status, error, by } = store.saveInfo();
  switch (status) {
    case 'saved': return '<span class="save ok" title="Les dades estan desades al servidor">✓ Desat</span>';
    case 'pending': case 'saving': return '<span class="save">Desant…</span>';
    case 'conflict': return `<span class="save bad" title="${esc(error)}">⚠ ${by ? `${esc(by)} ha` : 'Algú altre ha'} modificat aquest centre
      <button data-act="save-reload" title="Descarta els teus canvis i carrega la versió del servidor">Recarrega</button>
      <button data-act="save-force" title="Desa els teus canvis per sobre dels de l’altra persona">Desa igualment</button></span>`;
    default: return `<span class="save bad" title="${esc(error)}">⚠ No desat <button data-act="save-retry">Torna-ho a provar</button></span>`;
  }
}

// ---------- highlight of valid cells ----------

function activePiece() {
  if (ui.drag) return ui.drag;
  if (ui.sel?.type === 'card') {
    const c = store.getState().cards.find((x) => x.id === ui.sel.id);
    return c ? { lessonId: c.lessonId, cardId: c.id } : null;
  }
  if (ui.sel?.type === 'lesson') return { lessonId: ui.sel.id, cardId: null };
  return null;
}

function applyHighlight() {
  app.querySelectorAll('td.cell.ok, td.cell.no').forEach((td) => td.classList.remove('ok', 'no', 'warn'));
  ui.evals = null;
  const piece = activePiece();
  if (!piece) return;
  const s = store.getState();
  const ix = buildIndex(s);
  const lesson = ix.lesson.get(piece.lessonId);
  if (!lesson) return;
  const occ = buildOccupancy(s, ix);
  const prevRoom = piece.cardId ? s.cards.find((c) => c.id === piece.cardId)?.roomId : null;
  const evals = new Map();
  for (const d of s.days) {
    for (const p of s.periods) evals.set(`${d.id}|${p.id}`, evaluatePlacement(s, ix, occ, lesson, d.id, p.id, piece.cardId, prevRoom));
  }
  ui.evals = evals;
  const rows = new Set(rowIdsOfLesson(lesson));
  if (prevRoom && ui.view === 'room') rows.add(prevRoom);
  app.querySelectorAll('td.cell').forEach((td) => {
    if (!rows.has(td.dataset.row)) return;
    const ev = evals.get(`${td.dataset.day}|${td.dataset.period}`);
    td.classList.add(ev.ok ? 'ok' : 'no');
    if (ev.ok && ev.warnings.length) td.classList.add('warn');
  });
}

// ---------- actions ----------

function flash(msg) {
  ui.msg = msg;
  const el = document.getElementById('msg');
  if (el) el.textContent = msg;
}

function place(piece, dayId, periodId) {
  const s = store.getState();
  const ix = buildIndex(s);
  const lesson = ix.lesson.get(piece.lessonId);
  if (!lesson) return;
  const prevRoom = piece.cardId ? s.cards.find((c) => c.id === piece.cardId)?.roomId : null;
  const ev = evaluatePlacement(s, ix, buildOccupancy(s, ix), lesson, dayId, periodId, piece.cardId, prevRoom);
  if (!ev.ok) { flash(`No es pot: ${ev.reasons.join(' · ')}`); return; }
  ui.msg = ev.warnings.length ? `Col·locada, però: ${ev.warnings.join(' · ')}` : '';
  store.update((st) => {
    if (piece.cardId) {
      const c = st.cards.find((x) => x.id === piece.cardId);
      Object.assign(c, { dayId, periodId, roomId: ev.roomId });
    } else {
      st.cards.push({ id: uid('c'), lessonId: lesson.id, dayId, periodId, roomId: ev.roomId });
    }
  });
}

function unplace(cardId) {
  store.update((st) => { st.cards = st.cards.filter((c) => c.id !== cardId); });
  if (ui.sel?.id === cardId) ui.sel = null;
  render();
}

function toggleUnavailable(teacherId, key) {
  store.update((s) => {
    const tt = s.teachers.find((x) => x.id === teacherId);
    if (tt) tt.unavailable = tt.unavailable.includes(key) ? tt.unavailable.filter((x) => x !== key) : [...tt.unavailable, key];
  });
}


const actions = {
  'new-centre': () => openNewCentre(),
  'del-centre': () => {
    const s = store.getState();
    if (confirm(`Segur que vols eliminar «${s.meta.name}»? No es pot desfer.`)) {
      ui.sel = null;
      ui.row = null;
      store.deleteCentre(store.currentCentreId()).catch((e) => flash(`No s'ha pogut eliminar: ${e.message}`));
    }
  },
  undo: () => store.undo(),
  redo: () => store.redo(),
  fill: () => {
    const r = store.update((s) => greedyFill(s));
    const parts = [r.added ? `S'han col·locat ${r.added} sessions.` : 'No s\'ha pogut col·locar cap sessió més.'];
    if (r.pending) parts.push(`En queden ${r.pending} sense lloc: revisa les normes obligatòries o la disponibilitat.`);
    if (r.warnings) parts.push(`Hi ha ${r.warnings} incompliments de normes preferents.`);
    if (r.uncovered) parts.push(`${r.uncovered} hores sense prou docents de guàrdia.`);
    flash(parts.join(' '));
  },
  clear: () => {
    if (confirm('Vols treure totes les sessions de l\'horari? (Es pot desfer amb Ctrl+Z)')) store.update((s) => { s.cards = []; });
  },
  export: () => {
    const s = store.getState();
    downloadBlob(`${(s.meta.name || 'horari').replace(/[^\w\- ]+/g, '').trim() || 'horari'}.json`, store.exportData(), 'application/json');
  },
  import: () => app.querySelector('#import-file').click(),
  print: () => window.print(),
  'export-tt': () => openExport(ui.view),
  absences: () => openAbsences(),
  'row-pdf': () => { if (ui.row) exportTimetables(ui.view, [ui.row], 'pdf'); },
  'row-xlsx': () => { if (ui.row) exportTimetables(ui.view, [ui.row], 'xlsx'); },
  admin: () => openAdmin().catch((e) => flash(e.message)),
  account: () => openAccount(),
  logout: () => { ui.sel = null; ui.row = null; store.logout().catch((e) => flash(e.message)); },
  'save-retry': () => store.flush(),
  'save-force': () => { if (confirm('Els canvis de l’altra persona es perdran. Vols desar els teus igualment?')) store.flush({ force: true }); },
  'save-reload': () => { if (confirm('Es perdran els canvis que no s’han desat. Vols carregar la versió del servidor?')) store.reload(); },
  'clear-row': () => { ui.row = null; render(); },
  lock: () => { ui.lock = !ui.lock; ui.sel = null; render(); },
  unplace: () => { if (ui.sel?.type === 'card') unplace(ui.sel.id); },
};

// ---------- events ----------

app.addEventListener('click', (e) => {
  const t = e.target;
  const act = t.closest('button[data-act]');
  if (act) { actions[act.dataset.act]?.(); return; }
  const edit = t.closest('[data-edit]');
  if (edit) { openEditor(edit.dataset.edit); return; }
  const view = t.closest('[data-view]');
  if (view) { ui.view = view.dataset.view; ui.row = null; if (ui.view !== 'teacher') ui.lock = false; render(); return; }
  if (ui.lock && ui.view === 'teacher') {
    const td = t.closest('td.cell');
    if (td && !td.classList.contains('brk')) { toggleUnavailable(td.dataset.row, `${td.dataset.day}|${td.dataset.period}`); return; }
  }
  const rowh = t.closest('[data-rowsel]');
  if (rowh) { ui.row = ui.row === rowh.dataset.rowsel ? null : rowh.dataset.rowsel; render(); return; }

  const card = t.closest('.card[data-card]');
  if (card) {
    ui.sel = ui.sel?.type === 'card' && ui.sel.id === card.dataset.card ? null : { type: 'card', id: card.dataset.card };
    render();
    return;
  }
  const tcard = t.closest('.tcard[data-lesson]');
  if (tcard) {
    ui.sel = ui.sel?.type === 'lesson' && ui.sel.id === tcard.dataset.lesson ? null : { type: 'lesson', id: tcard.dataset.lesson };
    render();
    return;
  }
  const cell = t.closest('td.cell');
  if (cell && ui.sel) {
    const piece = activePiece();
    if (piece) place(piece, cell.dataset.day, cell.dataset.period);
  }
});

app.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'centre-sel') {
    ui.sel = null;
    ui.row = null;
    store.switchCentre(t.value).catch((e) => { flash(`No s'ha pogut canviar de centre: ${e.message}`); render(); });
    return;
  }
  if (t.matches('select[data-act="room"]') && ui.sel?.type === 'card') {
    const id = ui.sel.id;
    store.update((s) => { s.cards.find((c) => c.id === id).roomId = t.value || null; });
    return;
  }
  if (t.id === 'import-file' && t.files[0]) {
    t.files[0].text().then((txt) => {
      try { ui.sel = null; ui.row = null; store.importData(JSON.parse(txt)); flash('Fitxer importat.'); }
      catch (err) { flash(`No s'ha pogut importar: ${err.message}`); }
    });
  }
});

let cellW = 40;
try { cellW = parseInt(localStorage.getItem('horaris.cellW'), 10) || 40; } catch { /* ignore */ }
document.documentElement.style.setProperty('--cell-w', `${cellW}px`);

app.addEventListener('input', (e) => {
  if (e.target.id !== 'zoom') return;
  cellW = parseInt(e.target.value, 10);
  document.documentElement.style.setProperty('--cell-w', `${cellW}px`);
  try { localStorage.setItem('horaris.cellW', String(cellW)); } catch { /* ignore */ }
});

app.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.card[data-card]');
  const tcard = e.target.closest?.('.tcard[data-lesson]');
  if (card) {
    const c = store.getState().cards.find((x) => x.id === card.dataset.card);
    ui.drag = { lessonId: c.lessonId, cardId: c.id };
  } else if (tcard) {
    ui.drag = { lessonId: tcard.dataset.lesson, cardId: null };
  } else return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', ui.drag.cardId || ui.drag.lessonId);
  setTimeout(applyHighlight, 0);
});

let lastOver = null;
app.addEventListener('dragover', (e) => {
  if (!ui.drag) return;
  const cell = e.target.closest('td.cell');
  if (cell) {
    e.preventDefault();
    if (cell !== lastOver) {
      lastOver = cell;
      const ev = ui.evals?.get(`${cell.dataset.day}|${cell.dataset.period}`);
      flash(ev && !ev.ok ? `✗ ${ev.reasons.join(' · ')}` : ev?.warnings.length ? `△ ${ev.warnings.join(' · ')}` : '');
    }
    return;
  }
  if (ui.drag.cardId && e.target.closest('[data-drop="tray"]')) e.preventDefault();
});

app.addEventListener('drop', (e) => {
  if (!ui.drag) return;
  e.preventDefault();
  const piece = ui.drag;
  ui.drag = null;
  const cell = e.target.closest('td.cell');
  if (cell) place(piece, cell.dataset.day, cell.dataset.period);
  else if (piece.cardId && e.target.closest('[data-drop="tray"]')) unplace(piece.cardId);
});

app.addEventListener('dragend', () => {
  ui.drag = null;
  lastOver = null;
  applyHighlight();
});

document.addEventListener('keydown', (e) => {
  if (isEditorOpen()) { if (e.key === 'Escape') closeEditor(); return; }
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
  else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(); }
  else if (e.key === 'Escape') { ui.sel = null; ui.lock = false; render(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && ui.sel?.type === 'card') { e.preventDefault(); unplace(ui.sel.id); }
});

app.addEventListener('submit', (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  ui.loginError = '';
  store.login(String(f.get('email')).trim(), String(f.get('password')))
    .catch((err) => { ui.loginError = err.message; render(); });
});

window.addEventListener('beforeunload', (e) => {
  if (!store.hasUnsaved()) return;
  store.flush();
  if (store.isLocal()) return; // the local save is synchronous
  e.preventDefault();
  e.returnValue = '';
});

store.subscribe(render);
store.init()
  .then(render)
  .catch((e) => { app.innerHTML = `<div class="empty"><p>No es pot connectar amb el servidor.</p><p class="hint">${esc(e.message)}</p><p class="hint">Inicia’l amb <code>python server.py</code> (o <code>inicia.bat</code>).</p></div>`; });
