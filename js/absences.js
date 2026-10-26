import * as store from './store.js';
import { buildIndex, classesLabel, shortOf, dutyOf } from './model.js';
import { buildOccupancy } from './conflicts.js';
import { teacherBlocks } from './rules.js';
import { esc, uid, downloadBlob } from './util.js';
import { Pdf } from './export/pdf.js';
import { fileName } from './export/timetable.js';

/*
 * Gestor de baixes: absències del professorat per dates i substitucions de cada dia.
 * Per a cada sessió sense docent proposa substituts: primer els que són de guàrdia a aquella hora,
 * després els que coneixen el grup o la matèria, i reparteix la càrrega entre els docents.
 */

const root = document.getElementById('modal');
let date = isoDate(new Date());
let msg = null;

export function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const parse = (iso) => new Date(`${iso}T12:00:00`);
const addDays = (iso, n) => { const d = parse(iso); d.setDate(d.getDate() + n); return isoDate(d); };
const fmt = (iso, opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) => parse(iso).toLocaleDateString('ca-ES', opts);

// Timetable day for a calendar date: Monday is the first configured day, Tuesday the second…
export function dayOfDate(s, iso) {
  const wd = (parse(iso).getDay() + 6) % 7;
  return s.days[wd] || null;
}

export const isAbsent = (s, teacherId, iso) => s.absences.some((a) => a.teacherId === teacherId && a.from <= iso && iso <= a.to);

// Monday..Sunday of the week that contains `iso`.
function weekOf(iso) {
  const wd = (parse(iso).getDay() + 6) % 7;
  return [addDays(iso, -wd), addDays(iso, 6 - wd)];
}

// Teaching sessions on `iso` whose teacher (or one of them) is absent.
export function sessionsToCover(s, ix, iso) {
  const day = dayOfDate(s, iso);
  if (!day) return [];
  return s.cards.filter((c) => c.dayId === day.id)
    .map((card) => ({ card, lesson: ix.lesson.get(card.lessonId) }))
    .filter(({ lesson }) => lesson && !dutyOf(ix, lesson) && lesson.teacherIds.some((t) => isAbsent(s, t, iso)))
    .map((x) => ({ ...x, pi: ix.periodIdx.get(x.card.periodId), absent: x.lesson.teacherIds.filter((t) => isAbsent(s, t, iso)) }))
    .sort((a, b) => a.pi - b.pi);
}

const spanKeys = (s, item) => {
  const out = [];
  for (let k = 0; k < item.lesson.duration && s.periods[item.pi + k]; k++) out.push(`${item.card.dayId}|${s.periods[item.pi + k].id}`);
  return out;
};

// Candidate substitutes for one session, best first: [{ teacherId, score, why }].
export function candidates(s, ix, occ, iso, item, ctx = context(s, iso)) {
  const keys = spanKeys(s, item);
  const out = [];
  for (const t of s.teachers) {
    if (item.lesson.teacherIds.includes(t.id) || isAbsent(s, t.id, iso)) continue;
    let guard = 0, coord = 0, busy = false;
    for (const k of keys) {
      if (t.unavailable.includes(k) || ctx.blocks.has(`${t.id}|${k}`)) { busy = true; break; }
      if ((ctx.taken.get(k) || new Set()).has(t.id)) { busy = true; break; }
      const mine = (occ.get(k) || []).filter((o) => o.lesson.teacherIds.includes(t.id));
      // Teaching another class at that time; guard and coordination hours still allow covering.
      if (mine.some((o) => !dutyOf(ix, o.lesson))) { busy = true; break; }
      if (mine.some((o) => dutyOf(ix, o.lesson) === 'guard')) guard++;
      if (mine.some((o) => dutyOf(ix, o.lesson) === 'coord')) coord++;
    }
    if (busy) continue;
    const knowsGroup = s.lessons.some((l) => l.teacherIds.includes(t.id) && l.classIds.some((c) => item.lesson.classIds.includes(c)));
    const sameSubject = s.lessons.some((l) => l.teacherIds.includes(t.id) && l.subjectId === item.lesson.subjectId);
    const week = ctx.weekCount.get(t.id) || 0;
    const today = ctx.dayCount.get(t.id) || 0;
    const onGuard = guard === keys.length;
    const score = (onGuard ? 100 : 0) - (coord ? 40 : 0) + (knowsGroup ? 20 : 0) + (sameSubject ? 10 : 0) - week * 5 - today * 12;
    const why = [onGuard ? 'de guàrdia' : coord ? 'té coordinació' : 'hora lliure', knowsGroup && 'coneix el grup', sameSubject && 'mateixa matèria',
      week && `${week} subst. aquesta setmana`].filter(Boolean);
    out.push({ teacherId: t.id, score, why: why.join(' · '), onGuard });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Who is already substituting at each slot of that date, and how many substitutions each teacher has.
function context(s, iso, exceptCardId = null) {
  const [mon, sun] = weekOf(iso);
  const day = dayOfDate(s, iso);
  const ix = buildIndex(s);
  const taken = new Map();
  const dayCount = new Map();
  const weekCount = new Map();
  for (const x of s.subs) {
    if (x.date >= mon && x.date <= sun) weekCount.set(x.teacherId, (weekCount.get(x.teacherId) || 0) + 1);
    if (x.date !== iso || x.cardId === exceptCardId) continue;
    dayCount.set(x.teacherId, (dayCount.get(x.teacherId) || 0) + 1);
    const card = s.cards.find((c) => c.id === x.cardId);
    const lesson = card && ix.lesson.get(card.lessonId);
    if (!lesson || !day) continue;
    for (const k of spanKeys(s, { card, lesson, pi: ix.periodIdx.get(card.periodId) })) {
      if (!taken.has(k)) taken.set(k, new Set());
      taken.get(k).add(x.teacherId);
    }
  }
  return { taken, dayCount, weekCount, blocks: teacherBlocks(s) };
}

// Fills every uncovered session of `iso` with the best available substitute. Returns how many it assigned.
export function proposeSubstitutions(s, iso) {
  const ix = buildIndex(s);
  const occ = buildOccupancy(s, ix);
  let n = 0;
  for (const item of sessionsToCover(s, ix, iso)) {
    if (s.subs.some((x) => x.date === iso && x.cardId === item.card.id)) continue;
    const best = candidates(s, ix, occ, iso, item)[0];
    if (!best) continue;
    s.subs.push({ id: uid('sb'), date: iso, cardId: item.card.id, teacherId: best.teacherId });
    n++;
  }
  return n;
}

// ---------- PDF: daily substitution sheet ----------

export function substitutionSheet(s, iso) {
  const ix = buildIndex(s);
  const items = sessionsToCover(s, ix, iso);
  const pdf = new Pdf().page(595, 842);
  const M = 36, W = 595 - 2 * M;
  pdf.text([s.meta.name, s.meta.year].filter(Boolean).join(' · '), M, M + 8, { size: 9, color: '#64707d', width: W });
  pdf.text('Substitucions', M, M + 30, { size: 18, bold: true, width: W });
  pdf.text(fmt(iso), M, M + 48, { size: 12, color: '#1f2933', width: W });
  const absent = [...new Set(s.absences.filter((a) => a.from <= iso && iso <= a.to).map((a) => a.teacherId))]
    .map((t) => ix.teacher.get(t)?.name).filter(Boolean);
  pdf.text(`Absents: ${absent.join(', ') || '—'}`, M, M + 66, { size: 9, color: '#64707d', width: W });

  const cols = [['Hora', 70], ['Grup', 95], ['Matèria', 110], ['Aula', 50], ['Absent', 95], ['Substitut', W - 420]];
  let y = M + 80;
  const row = (vals, opts = {}) => {
    let x = M;
    pdf.rect(M, y, W, 22, { fill: opts.fill || null, stroke: '#b0b7c3' });
    vals.forEach((v, i) => { pdf.text(v, x + 4, y + 14, { size: 9, bold: !!opts.bold || (i === 5 && !opts.head), color: opts.colors?.[i] || '#1f2933', width: cols[i][1] - 8 }); x += cols[i][1]; });
    y += 22;
  };
  row(cols.map((c) => c[0]), { bold: true, fill: '#eef0f3', head: true });
  if (!items.length) pdf.text('No hi ha cap sessió per cobrir.', M + 4, y + 16, { size: 10, color: '#64707d' });
  for (const it of items) {
    if (y > 842 - M - 22) { pdf.page(595, 842); y = M; row(cols.map((c) => c[0]), { bold: true, fill: '#eef0f3', head: true }); }
    const p = s.periods[it.pi];
    const end = s.periods[it.pi + it.lesson.duration - 1] || p;
    const sub = s.subs.find((x) => x.date === iso && x.cardId === it.card.id);
    row([`${p.name} ${p.start}–${end.end}`, classesLabel(ix, it.lesson), ix.subject.get(it.lesson.subjectId)?.name || '',
      it.card.roomId ? shortOf(ix.room, it.card.roomId) : '', it.absent.map((t) => ix.teacher.get(t)?.name).join(', '),
      sub ? ix.teacher.get(sub.teacherId)?.name || '?' : 'SENSE COBRIR'], { colors: { 5: sub ? '#15803d' : '#d62828' } });
  }
  pdf.text(`Generat el ${new Date().toLocaleString('ca-ES')}`, M, 842 - M + 14, { size: 7, color: '#8a93a3' });
  return pdf.output();
}

// ---------- panel ----------

export function openAbsences(iso = null) {
  if (iso) date = iso;
  msg = null;
  draw();
}

function absencesList(s) {
  const today = isoDate(new Date());
  const list = [...s.absences].sort((a, b) => b.from.localeCompare(a.from));
  const rows = list.map((a) => {
    const t = s.teachers.find((x) => x.id === a.teacherId);
    const now = a.from <= date && date <= a.to;
    const past = a.to < today;
    return `<tr class="${now ? 'now' : ''} ${past ? 'past' : ''}">
      <td><b>${esc(t?.name || '?')}</b></td>
      <td>${esc(fmt(a.from, { day: 'numeric', month: 'short' }))}${a.to !== a.from ? ` – ${esc(fmt(a.to, { day: 'numeric', month: 'short' }))}` : ''}</td>
      <td class="hint">${esc(a.reason)}</td>
      <td class="rowacts"><button data-abs-goto="${a.from}" title="Mostra el primer dia">→</button><button class="danger" data-abs-del="${a.id}" title="Elimina">✕</button></td>
    </tr>`;
  }).join('');
  return `<section class="abs-left">
    <h3>Baixes i absències</h3>
    <form id="abs-add" class="abs-form">
      <select name="teacher" required><option value="">Docent…</option>${s.teachers.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <label>Des de <input type="date" name="from" value="${date}" required></label>
      <label>Fins a <input type="date" name="to" value="${date}"></label>
      <input name="reason" placeholder="Motiu (baixa, curs, sortida…)">
      <button type="submit" class="primary">Afegeix</button>
    </form>
    <table class="etable abs-list"><tbody>${rows || '<tr><td class="hint">No hi ha cap absència registrada.</td></tr>'}</tbody></table>
  </section>`;
}

function dayView(s) {
  const ix = buildIndex(s);
  const day = dayOfDate(s, date);
  const head = `<div class="abs-day">
      <button data-abs-shift="-1" title="Dia anterior">◀</button>
      <input type="date" data-abs-date value="${date}">
      <button data-abs-shift="1" title="Dia següent">▶</button>
      <button data-abs-today>Avui</button>
      <b class="abs-dayname">${esc(fmt(date))}</b>
    </div>`;
  if (!day) return `<section class="abs-right">${head}<p class="hint">Aquest dia no és lectiu a l’horari.</p></section>`;
  const items = sessionsToCover(s, ix, date);
  const occ = buildOccupancy(s, ix);
  const covered = items.filter((it) => s.subs.some((x) => x.date === date && x.cardId === it.card.id)).length;
  const rows = items.map((it) => {
    const p = s.periods[it.pi];
    const sub = s.subs.find((x) => x.date === date && x.cardId === it.card.id);
    const cands = candidates(s, ix, occ, date, it, context(s, date, it.card.id));
    if (sub && !cands.some((c) => c.teacherId === sub.teacherId)) cands.unshift({ teacherId: sub.teacherId, why: 'ja no està lliure', score: -999 });
    const subj = ix.subject.get(it.lesson.subjectId);
    return `<tr class="${sub ? 'ok' : 'todo'}">
      <td><b>${esc(p.name)}</b> <small>${esc(p.start)}</small></td>
      <td>${esc(classesLabel(ix, it.lesson))}</td>
      <td><span class="swatch" style="background:${esc(subj?.color)}"></span> ${esc(subj?.name)}</td>
      <td>${esc(it.absent.map((t) => shortOf(ix.teacher, t)).join(', '))}</td>
      <td><select data-abs-sub="${it.card.id}">
        <option value="">— Sense cobrir —</option>
        ${cands.map((c) => `<option value="${c.teacherId}" ${sub?.teacherId === c.teacherId ? 'selected' : ''}>${esc(ix.teacher.get(c.teacherId)?.name)} · ${esc(c.why)}</option>`).join('')}
      </select>${cands.length ? '' : ' <span class="err">ningú lliure</span>'}</td>
    </tr>`;
  }).join('');
  return `<section class="abs-right">${head}
    <div class="toolbar-row">
      <span class="${covered < items.length ? 'pending' : 'done'}">${items.length ? `${covered} de ${items.length} sessions cobertes` : 'Cap sessió per cobrir aquest dia'}</span>
      <button data-abs-propose ${items.length > covered ? '' : 'disabled'}>⚡ Proposa substitucions</button>
      <button data-abs-pdf>📄 Full del dia (PDF)</button>
    </div>
    ${items.length ? `<table class="etable wide abs-subs"><thead><tr><th>Hora</th><th>Grup</th><th>Matèria</th><th>Absent</th><th>Substitut</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
    <p class="hint">Les propostes prioritzen el professorat de guàrdia a aquella hora, després qui coneix el grup o la matèria, i reparteixen les substitucions de la setmana.</p>
  </section>`;
}

function draw() {
  const s = store.getState();
  if (!s) return;
  const top = root.querySelector('.modal-body')?.scrollTop || 0;
  root.innerHTML = `
  <div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="Baixes i substitucions" data-panel="absences">
    <header><h3>🩺 Baixes i substitucions</h3><button class="x" data-close-btn title="Tanca (Esc)">×</button></header>
    <div class="modal-body abs">
      ${msg ? `<p class="${msg.ok ? 'okmsg' : 'err'}">${esc(msg.text)}</p>` : ''}
      <div class="abs-grid">${absencesList(s)}${dayView(s)}</div>
    </div>
  </div></div>`;
  root.querySelector('.modal-body').scrollTop = top;
}

const isOpen = () => root.querySelector('[data-panel]')?.dataset.panel === 'absences';

root.addEventListener('click', (e) => {
  if (!isOpen()) return;
  const t = e.target;
  const shift = t.closest('[data-abs-shift]');
  if (shift) { date = addDays(date, Number(shift.dataset.absShift)); msg = null; draw(); return; }
  if (t.closest('[data-abs-today]')) { date = isoDate(new Date()); msg = null; draw(); return; }
  const go = t.closest('[data-abs-goto]');
  if (go) { date = go.dataset.absGoto; draw(); return; }
  const del = t.closest('[data-abs-del]');
  if (del) {
    store.update((s) => { s.absences = s.absences.filter((a) => a.id !== del.dataset.absDel); });
    draw();
    return;
  }
  if (t.closest('[data-abs-propose]')) {
    const n = store.update((s) => proposeSubstitutions(s, date));
    const left = sessionsToCover(store.getState(), buildIndex(store.getState()), date)
      .filter((it) => !store.getState().subs.some((x) => x.date === date && x.cardId === it.card.id)).length;
    msg = { ok: !left, text: `S’han proposat ${n} substitucions.${left ? ` En queden ${left} sense ningú disponible.` : ''}` };
    draw();
    return;
  }
  if (t.closest('[data-abs-pdf]')) {
    const s = store.getState();
    downloadBlob(`${fileName(s.meta.name)} - Substitucions ${date}.pdf`, substitutionSheet(s, date), 'application/pdf');
  }
});

root.addEventListener('change', (e) => {
  if (!isOpen()) return;
  const t = e.target;
  if (t.matches('[data-abs-date]') && t.value) { date = t.value; msg = null; draw(); return; }
  if (t.matches('[data-abs-sub]')) {
    const cardId = t.dataset.absSub;
    store.update((s) => {
      s.subs = s.subs.filter((x) => !(x.date === date && x.cardId === cardId));
      if (t.value) s.subs.push({ id: uid('sb'), date, cardId, teacherId: t.value });
    });
    draw();
  }
});

root.addEventListener('submit', (e) => {
  if (e.target.id !== 'abs-add') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const from = String(f.get('from'));
  const to = String(f.get('to') || from);
  store.update((s) => {
    s.absences.push({ id: uid('ab'), teacherId: String(f.get('teacher')), from, to: to < from ? from : to, reason: String(f.get('reason') || '').trim() });
  });
  date = from;
  msg = { ok: true, text: 'Absència afegida. Revisa les substitucions del dia.' };
  draw();
});
