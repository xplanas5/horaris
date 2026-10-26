import { buildIndex, placedCounts, dutyOf } from '../model.js';
import { buildOccupancy, evaluatePlacement } from '../conflicts.js';
import { cardRuleIssues, guardCoverage } from '../rules.js';
import { uid } from '../util.js';

/*
 * Col·locació voraç: posa cada sessió pendent a la millor franja vàlida, sense marxa enrere.
 * Respecta les restriccions dures i les normes obligatòries; evita les normes preferents si pot.
 * Si una sessió no hi cap, prova de moure'n una altra de les col·locades en aquest intent per fer-li lloc.
 * Fa diversos intents amb ordres una mica diferents i es queda el millor.
 * Les guàrdies i coordinacions van al final; les guàrdies, a les hores amb menys docents de guàrdia.
 * Muta `s` i retorna { added, pending, warnings, uncovered }.
 */

const SOFT_PENALTY = 30;
const MAX_ATTEMPTS = 40;
const TIME_BUDGET_MS = 1500;

function occupy(occ, s, ix, card, lesson) {
  const pi = ix.periodIdx.get(card.periodId);
  for (let k = 0; k < lesson.duration && s.periods[pi + k]; k++) {
    const key = `${card.dayId}|${s.periods[pi + k].id}`;
    if (!occ.has(key)) occ.set(key, []);
    occ.get(key).push({ card, lesson, k });
  }
}

function vacate(occ, card) {
  for (const list of occ.values()) {
    const i = list.findIndex((o) => o.card === card);
    if (i >= 0) list.splice(i, 1);
  }
}

const cloneOcc = (occ) => new Map([...occ].map(([k, v]) => [k, [...v]]));

// Valid (hard) slot with the fewest preferred-rule breaches, or null.
function bestSlot(s, ix, occ, lesson) {
  let best = null;
  for (const d of s.days) {
    for (const p of s.periods) {
      const ev = evaluatePlacement(s, ix, occ, lesson, d.id, p.id);
      if (ev.ok && (!best || ev.warnings.length < best.w)) best = { w: ev.warnings.length, dayId: d.id, periodId: p.id, roomId: ev.roomId };
    }
  }
  return best;
}

// For each session left out, move one session placed in this run elsewhere to make room for it.
function repair(s, ix, occ, cards, left) {
  const stillLeft = [];
  for (const l of left) {
    let done = false;
    for (const c of cards) {
      const cl = ix.lesson.get(c.lessonId);
      vacate(occ, c);
      const spot = bestSlot(s, ix, occ, l);
      if (spot) {
        const card = { id: uid('c'), lessonId: l.id, dayId: spot.dayId, periodId: spot.periodId, roomId: spot.roomId };
        occupy(occ, s, ix, card, l);
        const moved = bestSlot(s, ix, occ, cl);
        if (moved) {
          Object.assign(c, { dayId: moved.dayId, periodId: moved.periodId, roomId: moved.roomId });
          occupy(occ, s, ix, c, cl);
          cards.push(card);
          done = true;
          break;
        }
        vacate(occ, card);
      }
      occupy(occ, s, ix, c, cl);
    }
    if (!done) stillLeft.push(l);
  }
  return stillLeft;
}

const guardsAt = (ix, occ, k) => (occ.get(k) || []).filter((o) => dutyOf(ix, o.lesson) === 'guard').length;

function attempt(s, ix, baseOcc, todo, jitter, minGuards) {
  const occ = cloneOcc(baseOcc);
  const cards = [];
  const left = [];
  const days = new Map(); // lessonId -> Set(dayId) already used
  for (const c of s.cards) {
    if (!days.has(c.lessonId)) days.set(c.lessonId, new Set());
    days.get(c.lessonId).add(c.dayId);
  }

  for (const l of todo) {
    const usedDays = days.get(l.id) || new Set();
    let best = null;
    for (const d of s.days) {
      s.periods.forEach((p, pi) => {
        const ev = evaluatePlacement(s, ix, occ, l, d.id, p.id);
        if (!ev.ok) return;
        let score = (usedDays.has(d.id) ? 10 : 0) + ev.warnings.length * SOFT_PENALTY + pi * 0.05 + Math.random() * jitter;
        if (dutyOf(ix, l) === 'guard') {
          const n = guardsAt(ix, occ, `${d.id}|${p.id}`);
          score += n * 15 - (n < minGuards ? 60 : 0);
        }
        if (l.groupIds.length) {
          // Prefer slots where a sibling subgroup of the same class is already taught.
          const sibling = (occ.get(`${d.id}|${p.id}`) || [])
            .some((o) => o.lesson.groupIds.length && o.lesson.classIds.some((c) => l.classIds.includes(c)));
          if (sibling) score -= 20;
        }
        if (!best || score < best.score) best = { score, dayId: d.id, periodId: p.id, roomId: ev.roomId };
      });
    }
    if (!best) { left.push(l); continue; }
    const card = { id: uid('c'), lessonId: l.id, dayId: best.dayId, periodId: best.periodId, roomId: best.roomId };
    cards.push(card);
    occupy(occ, s, ix, card, l);
    if (!days.has(l.id)) days.set(l.id, new Set());
    days.get(l.id).add(best.dayId);
  }
  if (left.length) repair(s, ix, occ, cards, left);

  let warnings = 0;
  for (const list of cardRuleIssues({ ...s, cards: [...s.cards, ...cards] }, ix, occ).values()) {
    warnings += list.filter((r) => !r.hard).length;
  }
  const cov = guardCoverage({ ...s, cards: [...s.cards, ...cards] }, ix, occ);
  return { cards, warnings, uncovered: cov ? cov.short.length : 0 };
}

export function greedyFill(s) {
  const ix = buildIndex(s);
  const counts = placedCounts(s);
  const occ = buildOccupancy(s, ix);

  // How many slots each lesson could take right now: the fewer, the earlier it goes.
  const freedom = new Map();
  for (const l of s.lessons) {
    if ((counts.get(l.id) || 0) >= l.perWeek) continue;
    let n = 0;
    for (const d of s.days) for (const p of s.periods) if (evaluatePlacement(s, ix, occ, l, d.id, p.id).ok) n++;
    freedom.set(l.id, n);
  }

  const todo = [];
  for (const l of s.lessons) {
    for (let i = (counts.get(l.id) || 0); i < l.perWeek; i++) todo.push(l);
  }
  const cov = guardCoverage(s, ix, occ);
  if (!todo.length) return { added: 0, pending: 0, warnings: 0, uncovered: cov ? cov.short.length : 0 };
  const minGuards = cov ? cov.min : 1;

  const rank = (l, noise) => (dutyOf(ix, l) ? 100000 : 0) - l.duration * 1000 + freedom.get(l.id) * 10 - (l.groupIds.length ? 5 : 0)
    - (l.teacherIds.length + l.classIds.length) + Math.random() * noise;

  let best = null;
  const t0 = Date.now();
  for (let i = 0; i < MAX_ATTEMPTS && (i === 0 || Date.now() - t0 < TIME_BUDGET_MS); i++) {
    const noise = i === 0 ? 0 : 40;
    const keyed = todo.map((l) => ({ l, k: rank(l, noise) })).sort((a, b) => a.k - b.k).map((x) => x.l);
    const res = attempt(s, ix, occ, keyed, i === 0 ? 0.5 : 3, minGuards);
    const cost = (r) => (todo.length - r.cards.length) * 1000 + r.uncovered * 50 + r.warnings;
    if (!best || cost(res) < cost(best)) best = res;
    if (cost(best) === 0) break;
  }

  s.cards.push(...best.cards);
  return { added: best.cards.length, pending: todo.length - best.cards.length, warnings: best.warnings, uncovered: best.uncovered };
}
