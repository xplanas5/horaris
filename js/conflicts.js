import { shortOf, sharesStudents } from './model.js';
import { ruleChecks, cardRuleIssues } from './rules.js';

export const slotKey = (dayId, periodId) => `${dayId}|${periodId}`;

// slotKey -> [{ card, lesson, k }] where k is the offset inside a multi-period session.
export function buildOccupancy(s, ix) {
  const occ = new Map();
  for (const card of s.cards) {
    const lesson = ix.lesson.get(card.lessonId);
    const pi = ix.periodIdx.get(card.periodId);
    if (!lesson || pi == null) continue;
    for (let k = 0; k < lesson.duration; k++) {
      const p = s.periods[pi + k];
      if (!p) break;
      const key = slotKey(card.dayId, p.id);
      if (!occ.has(key)) occ.set(key, []);
      occ.get(key).push({ card, lesson, k });
    }
  }
  return occ;
}

// Reasons why `a` cannot share a slot with existing lesson `b`.
function clashReasons(ix, a, b) {
  const r = [];
  const what = shortOf(ix.subject, b.subjectId);
  for (const t of a.teacherIds) if (b.teacherIds.includes(t)) r.push(`${shortOf(ix.teacher, t)} ja fa ${what} a aquesta hora`);
  for (const c of a.classIds) {
    if (b.classIds.includes(c) && sharesStudents(ix, a, b, c)) r.push(`${shortOf(ix.cls, c)} ja té ${what}`);
  }
  return r;
}

export function evaluatePlacement(s, ix, occ, lesson, dayId, periodId, ignoreCardId = null, preferRoomId = null) {
  const pi = ix.periodIdx.get(periodId);
  if (pi == null || !ix.dayIdx.has(dayId)) return { ok: false, reasons: ['Franja inexistent'], roomId: null };

  const reasons = [];
  const keys = [];
  for (let k = 0; k < lesson.duration; k++) {
    const p = s.periods[pi + k];
    if (!p) { reasons.push(`No hi cap: dura ${lesson.duration} franges`); break; }
    if (p.isBreak) { reasons.push(`${p.name} és una franja no lectiva`); continue; }
    const key = slotKey(dayId, p.id);
    keys.push(key);
    for (const t of lesson.teacherIds) {
      const tt = ix.teacher.get(t);
      if (tt?.unavailable.includes(key)) reasons.push(`${tt.short || tt.name} no està disponible`);
    }
    for (const o of occ.get(key) || []) {
      if (o.card.id !== ignoreCardId) reasons.push(...clashReasons(ix, lesson, o.lesson));
    }
  }

  let roomId = null;
  const candidates = preferRoomId ? [preferRoomId, ...lesson.roomIds] : lesson.roomIds;
  if (candidates.length) {
    const busy = new Set();
    for (const key of keys) {
      for (const o of occ.get(key) || []) if (o.card.id !== ignoreCardId && o.card.roomId) busy.add(o.card.roomId);
    }
    roomId = candidates.find((r) => !busy.has(r)) ?? null;
    if (!roomId) reasons.push('Cap de les aules possibles està lliure');
  }

  const rules = ruleChecks(s, ix, occ, lesson, dayId, periodId, ignoreCardId);
  reasons.push(...rules.filter((r) => r.hard).map((r) => r.msg));
  const warnings = [...new Set(rules.filter((r) => !r.hard).map((r) => r.msg))];

  const uniq = [...new Set(reasons)];
  return { ok: uniq.length === 0, reasons: uniq, warnings, roomId };
}

// conflicts: cardId -> [reasons] for sessions that break a hard constraint or an obligatory rule.
// warnings:  cardId -> [reasons] for sessions that break a preferred rule.
export function computeIssues(s, ix) {
  const out = new Map();
  const add = (id, r) => { if (!out.has(id)) out.set(id, new Set()); out.get(id).add(r); };
  const occ = buildOccupancy(s, ix);

  for (const [key, list] of occ) {
    const periodId = key.split('|')[1];
    const p = s.periods[ix.periodIdx.get(periodId)];
    for (const o of list) {
      if (p?.isBreak) add(o.card.id, `Ocupa una franja no lectiva (${p.name})`);
      for (const t of o.lesson.teacherIds) {
        const tt = ix.teacher.get(t);
        if (tt?.unavailable.includes(key)) add(o.card.id, `${tt.short || tt.name} no està disponible`);
      }
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const sameRoom = a.card.roomId && a.card.roomId === b.card.roomId
          ? [`Aula ${shortOf(ix.room, a.card.roomId)} ocupada dues vegades`] : [];
        [...clashReasons(ix, a.lesson, b.lesson), ...sameRoom].forEach((r) => add(a.card.id, r));
        [...clashReasons(ix, b.lesson, a.lesson), ...sameRoom].forEach((r) => add(b.card.id, r));
      }
    }
  }
  const warnings = new Map();
  for (const [id, list] of cardRuleIssues(s, ix, occ)) {
    for (const r of list) {
      if (r.hard) add(id, r.msg);
      else warnings.set(id, [...new Set([...(warnings.get(id) || []), r.msg])]);
    }
  }
  return { conflicts: new Map([...out].map(([k, v]) => [k, [...v]])), warnings };
}
