import { uid, byId } from './util.js';

/*
 * Model de dades d'un centre (un fitxer JSON per centre):
 *  meta      { name, stage, year }
 *  days      [{ id, name, short }]
 *  periods   [{ id, name, start, end, isBreak }]             franges horàries, en ordre
 *  subjects  [{ id, name, short, color, duty }]                duty: '' | 'guard' | 'coord' (hores no lectives)
 *  classes   [{ id, name, short, divisions: [{ id, name, groups: [{ id, name }] }] }]
 *  teachers  [{ id, name, short, unavailable: ['dayId|periodId'] }]
 *  rooms     [{ id, name, short, capacity }]
 *  lessons   [{ id, subjectId, classIds, groupIds, teacherIds, roomIds, perWeek, duration }]
 *            càrrega lectiva; groupIds buit = grup sencer; roomIds en ordre de preferència
 *  cards     [{ id, lessonId, dayId, periodId, roomId }]       sessions col·locades
 *  rules     [{ id, type, on, hard, subjectIds, classIds, teacherIds, slots, mode, max, label }]
 *            normes per a la generació (vegeu rules.js); hard = obligatòria, si no és preferent
 *  absences  [{ id, teacherId, from, to, reason }]           baixes i absències (dates AAAA-MM-DD)
 *  subs      [{ id, date, cardId, teacherId }]               substitucions assignades per a un dia concret
 */

export const PALETTE = [
  '#e74c3c', '#f39c12', '#8e44ad', '#2e86de', '#27ae60', '#a0522d', '#16a085', '#f1c40f',
  '#ff7eb6', '#34495e', '#5dade2', '#7f8c8d', '#c0392b', '#d35400', '#2ecc71', '#9b59b6',
];

const DAYS = [['Dilluns', 'Dl'], ['Dimarts', 'Dt'], ['Dimecres', 'Dc'], ['Dijous', 'Dj'], ['Divendres', 'Dv']];
const PERIODS = [
  ['p1', '1a', '08:00', '09:00'], ['p2', '2a', '09:00', '10:00'], ['p3', '3a', '10:00', '11:00'],
  ['pati', 'Pati', '11:00', '11:30', true],
  ['p4', '4a', '11:30', '12:30'], ['p5', '5a', '12:30', '13:30'], ['p6', '6a', '13:30', '14:30'],
];

export function emptySchool() {
  return {
    version: 1,
    meta: { name: 'Nou centre', stage: '', year: '' },
    days: DAYS.map(([name, short], i) => ({ id: `d${i + 1}`, name, short })),
    periods: PERIODS.map(([id, name, start, end, isBreak = false]) => ({ id, name, start, end, isBreak })),
    subjects: [], classes: [], teachers: [], rooms: [], lessons: [], cards: [], rules: [], absences: [], subs: [],
  };
}

// Fills in missing fields so older or hand-made files load safely.
export function upgrade(raw) {
  const base = emptySchool();
  const s = { ...base, ...raw, meta: { ...base.meta, ...(raw?.meta || {}) } };
  for (const k of ['days', 'periods', 'subjects', 'classes', 'teachers', 'rooms', 'lessons', 'cards', 'rules', 'absences', 'subs']) {
    if (!Array.isArray(s[k])) s[k] = base[k];
  }
  s.classes.forEach((c) => { c.divisions = Array.isArray(c.divisions) ? c.divisions : []; });
  s.teachers.forEach((t) => { t.unavailable = Array.isArray(t.unavailable) ? t.unavailable : []; });
  s.lessons.forEach((l) => {
    for (const k of ['classIds', 'groupIds', 'teacherIds', 'roomIds']) l[k] = Array.isArray(l[k]) ? l[k] : [];
  });
  s.rules.forEach((r) => {
    for (const k of ['subjectIds', 'classIds', 'teacherIds', 'slots']) r[k] = Array.isArray(r[k]) ? r[k] : [];
    r.on = r.on !== false;
    r.hard = !!r.hard;
  });
  return s;
}

// Removes dangling references after edits (deleted subjects, groups, periods...).
export function normalize(s) {
  const ids = (arr) => new Set(arr.map((x) => x.id));
  const subj = ids(s.subjects), cls = ids(s.classes), tch = ids(s.teachers), rm = ids(s.rooms);
  const days = ids(s.days), per = ids(s.periods);
  const groups = new Set(s.classes.flatMap((c) => c.divisions.flatMap((d) => d.groups.map((g) => g.id))));

  s.lessons = s.lessons.filter((l) => subj.has(l.subjectId));
  for (const l of s.lessons) {
    l.classIds = l.classIds.filter((id) => cls.has(id));
    l.groupIds = l.groupIds.filter((id) => groups.has(id));
    l.teacherIds = l.teacherIds.filter((id) => tch.has(id));
    l.roomIds = l.roomIds.filter((id) => rm.has(id));
    l.perWeek = Math.max(0, parseInt(l.perWeek, 10) || 0);
    l.duration = Math.max(1, parseInt(l.duration, 10) || 1);
  }

  const lessons = byId(s.lessons);
  const count = new Map();
  s.cards = s.cards.filter((c) => {
    const l = lessons.get(c.lessonId);
    if (!l || !days.has(c.dayId) || !per.has(c.periodId)) return false;
    const n = (count.get(l.id) || 0) + 1;
    if (n > l.perWeek) return false;
    count.set(l.id, n);
    if (c.roomId && !rm.has(c.roomId)) c.roomId = null;
    return true;
  });

  const validSlot = (k) => { const [d, p] = k.split('|'); return days.has(d) && per.has(p); };
  for (const t of s.teachers) t.unavailable = t.unavailable.filter(validSlot);
  for (const r of s.rules) {
    r.subjectIds = r.subjectIds.filter((id) => subj.has(id));
    r.classIds = r.classIds.filter((id) => cls.has(id));
    r.teacherIds = r.teacherIds.filter((id) => tch.has(id));
    r.slots = r.slots.filter(validSlot);
    if (r.type === 'maxPerDay') r.max = Math.max(1, parseInt(r.max, 10) || 1);
    if (r.type === 'guardCoverage') r.min = Math.max(1, parseInt(r.min, 10) || 1);
  }
  for (const x of s.subjects) x.duty = DUTIES[x.duty] ? x.duty : '';

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  s.absences = s.absences.filter((a) => tch.has(a.teacherId) && DATE.test(a.from));
  for (const a of s.absences) if (!DATE.test(a.to) || a.to < a.from) a.to = a.from;
  const cardIds = new Set(s.cards.map((c) => c.id));
  s.subs = s.subs.filter((x) => cardIds.has(x.cardId) && tch.has(x.teacherId) && DATE.test(x.date));
  return s;
}

// Non-teaching duties, kept as special subjects so they are placed and shown like any other session.
export const DUTIES = {
  guard: { name: 'Guàrdia', short: 'Gu', color: '#9ca3af' },
  coord: { name: 'Coordinació', short: 'Coo', color: '#c4b5fd' },
};

// Subject used for a duty, created if missing and `create` is set.
export function dutySubject(s, type, create = false) {
  let subj = s.subjects.find((x) => x.duty === type);
  if (!subj && create) {
    subj = { id: uid('s'), ...DUTIES[type], duty: type };
    s.subjects.push(subj);
  }
  return subj || null;
}

export const dutyOf = (ix, lesson) => ix.subject.get(lesson.subjectId)?.duty || '';

// Weekly duty hours of one teacher (lessons of a duty subject taught only by them).
export function dutyLesson(s, teacherId, type) {
  const subj = dutySubject(s, type);
  return subj ? s.lessons.find((l) => l.subjectId === subj.id && !l.classIds.length
    && l.teacherIds.length === 1 && l.teacherIds[0] === teacherId) || null : null;
}

export function buildIndex(s) {
  const group = new Map();
  for (const c of s.classes) for (const d of c.divisions) for (const g of d.groups) group.set(g.id, { group: g, division: d, cls: c });
  return {
    subject: byId(s.subjects), cls: byId(s.classes), teacher: byId(s.teachers), room: byId(s.rooms),
    lesson: byId(s.lessons), group,
    dayIdx: new Map(s.days.map((d, i) => [d.id, i])),
    periodIdx: new Map(s.periods.map((p, i) => [p.id, i])),
  };
}

// Part of a class a lesson takes: null = whole class, else one division's groups.
function classPart(ix, lesson, classId) {
  const gs = lesson.groupIds.map((g) => ix.group.get(g)).filter((x) => x && x.cls.id === classId);
  if (!gs.length) return null;
  return { div: gs[0].division.id, groups: new Set(gs.map((x) => x.group.id)) };
}

// Two lessons of the same class can coexist only if they take disjoint groups of the same division.
export function sharesStudents(ix, a, b, classId) {
  const pa = classPart(ix, a, classId), pb = classPart(ix, b, classId);
  if (!pa || !pb || pa.div !== pb.div) return true;
  for (const g of pa.groups) if (pb.groups.has(g)) return true;
  return false;
}

export function placedCounts(s) {
  const m = new Map();
  for (const c of s.cards) m.set(c.lessonId, (m.get(c.lessonId) || 0) + 1);
  return m;
}

export const shortOf = (map, id) => { const x = map.get(id); return x ? (x.short || x.name) : '?'; };

// "1A (Fr)" style label for the classes and subgroups of a lesson.
export function classesLabel(ix, lesson) {
  const groups = lesson.groupIds.map((g) => ix.group.get(g)).filter(Boolean);
  return lesson.classIds.map((cid) => {
    const own = groups.filter((g) => g.cls.id === cid).map((g) => g.group.name);
    return shortOf(ix.cls, cid) + (own.length ? ` (${own.join(', ')})` : '');
  }).join(', ');
}

export function sampleSchool() {
  const s = emptySchool();
  s.meta = { name: "Institut d'exemple", stage: 'ESO', year: '2026-2027' };

  const subj = (name, short, color) => { const o = { id: uid('s'), name, short, color }; s.subjects.push(o); return o; };
  const S = {
    cat: subj('Llengua catalana', 'Cat', '#e74c3c'), cas: subj('Llengua castellana', 'Cas', '#f39c12'),
    ang: subj('Anglès', 'Ang', '#8e44ad'), mat: subj('Matemàtiques', 'Mat', '#2e86de'),
    cn: subj('Ciències de la natura', 'CN', '#27ae60'), cs: subj('Ciències socials', 'CS', '#a0522d'),
    ef: subj('Educació física', 'EF', '#16a085'), mus: subj('Música', 'Mus', '#f1c40f'),
    vp: subj('Educació visual i plàstica', 'VP', '#ff7eb6'), tec: subj('Tecnologia', 'Tec', '#34495e'),
    tut: subj('Tutoria', 'Tut', '#bdc3c7'), fr: subj('Francès', 'Fr', '#5dade2'), rob: subj('Robòtica', 'Rob', '#7f8c8d'),
  };

  const tch = (name, short) => { const o = { id: uid('t'), name, short, unavailable: [] }; s.teachers.push(o); return o; };
  const T = {
    apu: tch('Anna Puig', 'APu'), jvi: tch('Jordi Vila', 'JVi'), mso: tch('Marta Soler', 'MSo'), pfo: tch('Pere Font', 'PFo'),
    lri: tch('Laura Riera', 'LRi'), dma: tch('David Mas', 'DMa'), nca: tch('Núria Camps', 'NCa'), xro: tch('Xavier Roca', 'XRo'),
    ese: tch('Elena Serra', 'ESe'), jfe: tch('Joan Ferrer', 'JFe'), mco: tch('Marc Coll', 'MCo'), cbo: tch('Clara Bosch', 'CBo'),
    spo: tch('Sílvia Pons', 'SPo'), apr: tch('Albert Prat', 'APr'), mvi: tch('Montse Vidal', 'MVi'), osa: tch('Oriol Sala', 'OSa'),
  };
  T.nca.unavailable = ['d5|p5', 'd5|p6'];

  const room = (name, short, capacity = '') => { const o = { id: uid('r'), name, short, capacity }; s.rooms.push(o); return o; };
  const R = {
    gim: room('Gimnàs', 'Gim'), lab: room('Laboratori', 'Lab', 24), mus: room('Aula de música', 'AMu', 30),
    pla: room('Aula de plàstica', 'APl', 30), tal: room('Taller de tecnologia', 'Tal', 24),
    inf: room('Aula d\'informàtica', 'Inf', 20), idi: room('Aula d\'idiomes', 'Idi', 20),
  };

  const names = [['1r ESO A', '1A'], ['1r ESO B', '1B'], ['1r ESO C', '1C'], ['2n ESO A', '2A'], ['2n ESO B', '2B'], ['3r ESO A', '3A'], ['3r ESO B', '3B']];
  const add = (subject, cls, teachers, rooms, perWeek, duration = 1, groupIds = []) => s.lessons.push({
    id: uid('l'), subjectId: subject.id, classIds: [cls.id], groupIds,
    teacherIds: teachers.map((t) => t.id), roomIds: rooms.map((r) => r.id), perWeek, duration,
  });

  names.forEach(([name, short], i) => {
    const c = {
      id: uid('g'), name, short,
      divisions: [{ id: uid('dv'), name: 'Optatives', groups: [{ id: uid('sg'), name: 'Fr' }, { id: uid('sg'), name: 'Rob' }] }],
    };
    s.classes.push(c);
    const home = room(`Aula ${short}`, `A${short}`, 30);
    const pick = (arr) => arr[i % arr.length];
    const tutor = pick([T.apu, T.jvi]);
    add(S.cat, c, [tutor], [home], 3);
    add(S.cas, c, [pick([T.mso, T.pfo])], [home], 3);
    add(S.ang, c, [pick([T.lri, T.dma])], [home], 3);
    add(S.mat, c, [pick([T.nca, T.xro])], [home], 4);
    add(S.cn, c, [T.ese], [R.lab, home], 3);
    add(S.cs, c, [T.jfe], [home], 3);
    add(S.ef, c, [T.mco], [R.gim], 1, 2);
    add(S.mus, c, [T.cbo], [R.mus], 2);
    add(S.vp, c, [T.spo], [R.pla], 2);
    add(S.tec, c, [T.apr], [R.tal], 2);
    add(S.tut, c, [tutor], [home], 1);
    const [fr, rob] = c.divisions[0].groups;
    add(S.fr, c, [T.mvi], [R.idi], 2, 1, [fr.id]);
    add(S.rob, c, [T.osa], [R.inf], 2, 1, [rob.id]);
  });

  // Guàrdies (2 h per docent) i coordinació; una norma demana almenys un docent de guàrdia a cada hora.
  const duty = (type, t, perWeek) => s.lessons.push({
    id: uid('l'), subjectId: dutySubject(s, type, true).id, classIds: [], groupIds: [], teacherIds: [t.id], roomIds: [], perWeek, duration: 1,
  });
  Object.values(T).forEach((t) => duty('guard', t, 2));
  duty('coord', T.apu, 2);
  duty('coord', T.jvi, 2);
  s.rules.push({ id: uid('n'), type: 'guardCoverage', on: true, hard: false, min: 1, subjectIds: [], classIds: [], teacherIds: [], slots: [] });
  return s;
}
