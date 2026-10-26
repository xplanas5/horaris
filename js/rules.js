import { shortOf, sharesStudents, dutyOf } from './model.js';

/*
 * Normes per a la generació automàtica i la col·locació manual.
 * Cada norma pot ser obligatòria (hard: la cel·la queda vermella i el generador no la incompleix mai)
 * o preferent (el generador l'evita si pot; a la graella surt com a avís).
 *
 *  noConsecutive  Sessions de les matèries triades no poden anar seguides en un mateix grup.
 *                 Sense matèries = cap matèria pot anar dues vegades seguida. El pati separa.
 *  subjectSlots   Les matèries (o totes, si no se'n tria cap) només poden anar / no poden anar
 *                 a les franges marcades (mode 'only' | 'never').
 *  maxPerDay      Com a màxim `max` sessions d'una mateixa matèria al dia per grup.
 *  teacherBlock   Hores bloquejades per a uns docents (reunions, coordinacions…), amb una etiqueta.
 *  guardCoverage  A cada hora lectiva hi ha d'haver almenys `min` docents de guàrdia. No depèn d'una sessió
 *                 concreta sinó de tota la setmana: el generador hi reparteix les guàrdies i la graella en mostra el recompte.
 */

export const RULE_TYPES = {
  noConsecutive: { name: 'No seguides', icon: '⇄', make: () => ({ hard: false }) },
  subjectSlots: { name: 'Matèria en franges concretes', icon: '◷', make: () => ({ hard: true, mode: 'only' }) },
  maxPerDay: { name: 'Màxim de sessions al dia', icon: '≤', make: () => ({ hard: false, max: 1 }) },
  teacherBlock: { name: 'Bloqueig de docents', icon: '🔒', make: () => ({ hard: true, label: 'Reunió' }) },
  guardCoverage: { name: 'Cobertura de guàrdies', icon: '🛡', make: () => ({ hard: false, min: 1 }) },
};

const key = (dayId, periodId) => `${dayId}|${periodId}`;
const inList = (list, id) => !list.length || list.includes(id);
const scopedClasses = (r, lesson) => lesson.classIds.filter((c) => inList(r.classIds, c));

// Slots a lesson occupies when it starts at (dayId, periodId); breaks and overflow are left to the hard checks.
function span(s, ix, lesson, dayId, periodId) {
  const pi = ix.periodIdx.get(periodId);
  const out = [];
  for (let k = 0; k < lesson.duration && s.periods[pi + k]; k++) out.push(key(dayId, s.periods[pi + k].id));
  return { pi, slots: out };
}

// Other sessions occupying a slot (k > 0 for the later periods of a long session).
function others(occ, k, ignoreCardId) {
  return (occ.get(k) || []).filter((o) => o.card.id !== ignoreCardId);
}

const CHECKS = {
  noConsecutive(r, ctx) {
    const { s, ix, occ, lesson, dayId, pi, ignoreCardId } = ctx;
    if (!inList(r.subjectIds, lesson.subjectId)) return [];
    const classes = scopedClasses(r, lesson);
    if (!classes.length) return [];
    const matches = (other) => (r.subjectIds.length ? r.subjectIds.includes(other.subjectId) : other.subjectId === lesson.subjectId);
    const out = [];
    // Neighbouring periods just before the start and just after the end; a break in between separates them.
    for (const p of [s.periods[pi - 1], s.periods[pi + lesson.duration]]) {
      if (!p || p.isBreak) continue;
      for (const o of others(occ, key(dayId, p.id), ignoreCardId)) {
        if (!matches(o.lesson)) continue;
        const c = classes.find((cid) => o.lesson.classIds.includes(cid) && sharesStudents(ix, lesson, o.lesson, cid));
        if (c) out.push(`${shortOf(ix.subject, lesson.subjectId)} i ${shortOf(ix.subject, o.lesson.subjectId)} seguides a ${shortOf(ix.cls, c)}`);
      }
    }
    return out;
  },

  subjectSlots(r, ctx) {
    const { ix, lesson, slots } = ctx;
    if (!inList(r.subjectIds, lesson.subjectId) || !scopedClasses(r, lesson).length) return [];
    const bad = slots.some((k) => (r.mode === 'never') === r.slots.includes(k));
    if (!bad) return [];
    return [r.mode === 'never'
      ? `${shortOf(ix.subject, lesson.subjectId)} no pot anar en aquesta franja`
      : `${shortOf(ix.subject, lesson.subjectId)} només pot anar a les franges marcades`];
  },

  maxPerDay(r, ctx) {
    const { s, ix, occ, lesson, dayId, ignoreCardId } = ctx;
    if (!inList(r.subjectIds, lesson.subjectId)) return [];
    const out = [];
    for (const c of scopedClasses(r, lesson)) {
      const seen = new Set();
      for (const p of s.periods) {
        for (const o of others(occ, key(dayId, p.id), ignoreCardId)) {
          if (o.k === 0 && o.lesson.subjectId === lesson.subjectId && o.lesson.classIds.includes(c)
            && sharesStudents(ix, lesson, o.lesson, c)) seen.add(o.card.id);
        }
      }
      if (seen.size + 1 > r.max) {
        out.push(`Més de ${r.max} ${r.max === 1 ? 'sessió' : 'sessions'} de ${shortOf(ix.subject, lesson.subjectId)} el mateix dia a ${shortOf(ix.cls, c)}`);
      }
    }
    return out;
  },

  teacherBlock(r, ctx) {
    const { ix, lesson, slots } = ctx;
    if (!slots.some((k) => r.slots.includes(k))) return [];
    return lesson.teacherIds.filter((t) => r.teacherIds.includes(t))
      .map((t) => `${shortOf(ix.teacher, t)} té bloquejada aquesta hora${r.label ? ` (${r.label})` : ''}`);
  },
};

// Rule breaches if `lesson` starts at (dayId, periodId): [{ hard, msg }].
export function ruleChecks(s, ix, occ, lesson, dayId, periodId, ignoreCardId = null) {
  if (!s.rules?.length) return [];
  const { pi, slots } = span(s, ix, lesson, dayId, periodId);
  if (pi == null) return [];
  const ctx = { s, ix, occ, lesson, dayId, pi, slots, ignoreCardId };
  const out = [];
  for (const r of s.rules) {
    if (!r.on || !CHECKS[r.type]) continue;
    for (const msg of CHECKS[r.type](r, ctx)) out.push({ hard: r.hard, msg });
  }
  return out;
}

// Rule breaches of every placed session: Map cardId -> [{ hard, msg }].
export function cardRuleIssues(s, ix, occ) {
  const out = new Map();
  if (!s.rules?.some((r) => r.on)) return out;
  for (const card of s.cards) {
    const lesson = ix.lesson.get(card.lessonId);
    if (!lesson) continue;
    const found = ruleChecks(s, ix, occ, lesson, card.dayId, card.periodId, card.id);
    if (found.length) out.set(card.id, found);
  }
  return out;
}

// Guard teachers per teaching slot against the coverage rule, or null when there is no such rule.
// -> { min, count: Map slotKey -> n, short: [slotKeys below min] }
export function guardCoverage(s, ix, occ) {
  const r = s.rules?.find((x) => x.on && x.type === 'guardCoverage');
  if (!r) return null;
  const count = new Map();
  const short = [];
  for (const d of s.days) {
    for (const p of s.periods) {
      if (p.isBreak) continue;
      const k = key(d.id, p.id);
      const n = (occ.get(k) || []).filter((o) => dutyOf(ix, o.lesson) === 'guard').reduce((a, o) => a + o.lesson.teacherIds.length, 0);
      count.set(k, n);
      if (n < r.min) short.push(k);
    }
  }
  return { min: r.min, count, short };
}

// teacherId|slot -> labels of the blocks that cover it (for drawing the teacher view).
export function teacherBlocks(s) {
  const out = new Map();
  for (const r of s.rules || []) {
    if (!r.on || r.type !== 'teacherBlock') continue;
    for (const t of r.teacherIds) {
      for (const k of r.slots) {
        const id = `${t}|${k}`;
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(r.label || 'Bloquejat');
      }
    }
  }
  return out;
}

// One-line summary of a rule, for the rules list.
export function describeRule(s, r) {
  const names = (list, ids) => ids.map((id) => { const x = list.find((y) => y.id === id); return x ? (x.short || x.name) : '?'; }).join(', ');
  const subj = r.subjectIds.length ? names(s.subjects, r.subjectIds) : 'qualsevol matèria';
  const where = r.classIds.length ? ` · ${names(s.classes, r.classIds)}` : '';
  const n = r.slots.length;
  switch (r.type) {
    case 'noConsecutive':
      return r.subjectIds.length > 1 ? `${subj}: cap parella seguida${where}` : `${subj}: no dues sessions seguides${where}`;
    case 'subjectSlots':
      return `${subj} ${r.mode === 'never' ? 'mai' : 'només'} a ${n} ${n === 1 ? 'franja' : 'franges'}${where}`;
    case 'maxPerDay':
      return `${subj}: com a màxim ${r.max} al dia${where}`;
    case 'guardCoverage':
      return `Almenys ${r.min} ${r.min === 1 ? 'docent' : 'docents'} de guàrdia a cada hora lectiva`;
    case 'teacherBlock':
      return `${r.label || 'Bloqueig'}: ${r.teacherIds.length ? names(s.teachers, r.teacherIds) : 'cap docent'} · ${n} ${n === 1 ? 'franja' : 'franges'}`;
    default:
      return r.type;
  }
}
