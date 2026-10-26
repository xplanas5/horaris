import { buildIndex, classesLabel, shortOf } from '../model.js';
import { teacherBlocks } from '../rules.js';
import { textColor } from '../util.js';
import { Pdf } from './pdf.js';
import { xlsx, colName } from './xlsx.js';

// Horaris individuals (setmanals) d'un grup, docent, matèria o aula, i la seva sortida en PDF i Excel.

export const KINDS = {
  class: { label: 'Grups', one: 'Grup', list: (s) => s.classes },
  teacher: { label: 'Professorat', one: 'Docent', list: (s) => s.teachers },
  subject: { label: 'Matèries', one: 'Matèria', list: (s) => s.subjects },
  room: { label: 'Aules', one: 'Aula', list: (s) => s.rooms },
};

const names = (map, ids) => ids.map((id) => map.get(id)?.name).filter(Boolean).join(', ');
const shorts = (map, ids) => ids.map((id) => shortOf(map, id)).join(', ');

// What each session shows, depending on whose timetable it is.
function item(ix, kind, card, lesson) {
  const subj = ix.subject.get(lesson.subjectId);
  const room = card.roomId ? shortOf(ix.room, card.roomId) : '';
  const groups = lesson.groupIds.map((g) => ix.group.get(g)?.group.name).filter(Boolean).join(', ');
  const teachers = shorts(ix.teacher, lesson.teacherIds);
  const base = { color: subj?.color || '#cccccc' };
  switch (kind) {
    case 'class':
      return { ...base, title: subj?.name || '?', short: subj?.short || '?', lines: [[groups, teachers].filter(Boolean).join(' · '), room] };
    case 'teacher':
      return { ...base, title: subj?.name || '?', short: subj?.short || '?', lines: [classesLabel(ix, lesson), room] };
    case 'subject':
      return { ...base, title: classesLabel(ix, lesson), short: shorts(ix.cls, lesson.classIds), lines: [names(ix.teacher, lesson.teacherIds), room] };
    default:
      return { ...base, title: subj?.name || '?', short: subj?.short || '?', lines: [classesLabel(ix, lesson), teachers] };
  }
}

export function timetableOf(s, kind, id, ix = buildIndex(s)) {
  const entity = KINDS[kind].list(s).find((x) => x.id === id);
  const matches = {
    class: (c, l) => l.classIds.includes(id),
    teacher: (c, l) => l.teacherIds.includes(id),
    subject: (c, l) => l.subjectId === id,
    room: (c) => c.roomId === id,
  }[kind];
  const cells = s.periods.map(() => s.days.map(() => []));
  let taught = 0;
  for (const card of s.cards) {
    const lesson = ix.lesson.get(card.lessonId);
    const di = ix.dayIdx.get(card.dayId);
    const pi = ix.periodIdx.get(card.periodId);
    if (!lesson || di == null || pi == null || !matches(card, lesson)) continue;
    const it = item(ix, kind, card, lesson);
    for (let k = 0; k < lesson.duration && pi + k < s.periods.length; k++) cells[pi + k][di].push(it);
    taught += lesson.duration;
  }
  // A subject's hours add up across groups; anyone else's are the slots they are busy (split groups overlap).
  const hours = kind === 'subject' ? taught : cells.flat().filter((c) => c.length).length;
  if (kind === 'teacher') {
    // Meetings and other blocked hours are part of a teacher's week too.
    const blocks = teacherBlocks(s);
    s.periods.forEach((p, pi) => s.days.forEach((d, di) => {
      for (const label of blocks.get(`${id}|${d.id}|${p.id}`) || []) cells[pi][di].push({ color: '#e5e7eb', title: label, short: label, lines: [] });
    }));
  }
  return {
    kind, id, name: entity?.name || '?', short: entity?.short || '',
    heading: `${KINDS[kind].one}: ${entity?.name || '?'}`,
    meta: s.meta, days: s.days, periods: s.periods, cells, hours,
  };
}

// ---------- PDF ----------

const PAGE_W = 842, PAGE_H = 595, M = 28;

function drawPage(pdf, tt) {
  pdf.page(PAGE_W, PAGE_H);
  const school = [tt.meta.name, tt.meta.stage, tt.meta.year].filter(Boolean).join(' · ');
  pdf.text(school, M, M + 10, { size: 9, color: '#64707d', width: PAGE_W - 2 * M });
  pdf.text(tt.heading, M, M + 30, { size: 17, bold: true, color: '#1f2933', width: PAGE_W - 2 * M - 120 });
  pdf.text(`${tt.hours} h setmanals`, PAGE_W - M - 120, M + 30, { size: 10, color: '#64707d', width: 120, align: 'right' });

  const top = M + 44, labelW = 62, headH = 20, breakH = 14, footer = 22;
  const dayW = (PAGE_W - 2 * M - labelW) / Math.max(1, tt.days.length);
  const lessons = tt.periods.filter((p) => !p.isBreak).length;
  const breaks = tt.periods.length - lessons;
  const rowH = Math.min(78, (PAGE_H - top - headH - breaks * breakH - footer - M) / Math.max(1, lessons));
  const line = '#b0b7c3';

  pdf.rect(M, top, labelW + dayW * tt.days.length, headH, { fill: '#eef0f3', stroke: line });
  tt.days.forEach((d, i) => pdf.text(d.name, M + labelW + dayW * i, top + 14, { size: 10, bold: true, width: dayW, align: 'center' }));

  let y = top + headH;
  tt.periods.forEach((p, pi) => {
    if (p.isBreak) {
      pdf.rect(M, y, labelW + dayW * tt.days.length, breakH, { fill: '#f1f2f4', stroke: line });
      pdf.text(`${p.name}  ${p.start}–${p.end}`, M, y + 10, { size: 7, color: '#64707d', width: labelW + dayW * tt.days.length, align: 'center' });
      y += breakH;
      return;
    }
    pdf.rect(M, y, labelW, rowH, { fill: '#f6f7f9', stroke: line });
    pdf.text(p.name, M + 4, y + 14, { size: 10, bold: true, width: labelW - 8 });
    pdf.text(`${p.start}–${p.end}`, M + 4, y + 25, { size: 7, color: '#64707d', width: labelW - 8 });
    tt.days.forEach((d, di) => {
      const x = M + labelW + dayW * di;
      pdf.rect(x, y, dayW, rowH, { stroke: line });
      const items = tt.cells[pi][di];
      const h = (rowH - 2) / Math.max(1, items.length);
      items.forEach((it, k) => drawItem(pdf, it, x + 1.5, y + 1 + h * k, dayW - 3, h - 1));
    });
    y += rowH;
  });

  const today = new Date().toLocaleDateString('ca-ES');
  pdf.text(`Generat el ${today}`, M, PAGE_H - M + 6, { size: 7, color: '#8a93a3' });
}

function drawItem(pdf, it, x, y, w, h) {
  const fg = textColor(it.color);
  pdf.rect(x, y, w, h, { fill: it.color });
  const pad = 4, tw = w - 2 * pad;
  const lines = it.lines.filter(Boolean);
  if (h >= 30) {
    const size = Math.min(10, h / 3.2);
    const used = size + lines.length * (size * 0.85);
    let by = y + (h - used) / 2 + size * 0.8;
    pdf.text(it.title, x + pad, by, { size, bold: true, color: fg, width: tw, align: 'center' });
    for (const l of lines) {
      if (by + size * 0.85 > y + h - 2) break;
      by += size * 0.95;
      pdf.text(l, x + pad, by, { size: size * 0.78, color: fg, width: tw, align: 'center' });
    }
  } else {
    // Small box (several sessions share the slot): one line, title plus first detail.
    const size = Math.max(5.5, Math.min(8, h * 0.55));
    pdf.text([it.short || it.title, lines[0]].filter(Boolean).join(' · '), x + pad, y + h / 2 + size * 0.35, { size, bold: true, color: fg, width: tw, align: 'center' });
  }
}

export function timetablesPdf(list) {
  const pdf = new Pdf();
  for (const tt of list) drawPage(pdf, tt);
  return pdf.output();
}

// ---------- Excel ----------

function sheetOf(tt) {
  const n = tt.days.length;
  const border = { border: true };
  const rows = [
    { height: 16, cells: [{ v: [tt.meta.name, tt.meta.stage, tt.meta.year].filter(Boolean).join(' · '), color: '#64707d', size: 9 }] },
    { height: 26, cells: [{ v: tt.heading, bold: true, size: 15 }, ...Array(n - 1).fill(null), { v: `${tt.hours} h setmanals`, color: '#64707d', align: 'center' }] },
    { height: 20, cells: [{ v: '', fill: '#eef0f3', ...border }, ...tt.days.map((d) => ({ v: d.name, bold: true, align: 'center', fill: '#eef0f3', ...border }))] },
  ];
  const last = colName(n);
  const merges = [`A1:${last}1`];
  if (n > 1) merges.push(`A2:${colName(n - 1)}2`);
  tt.periods.forEach((p, pi) => {
    if (p.isBreak) {
      rows.push({ height: 14, cells: [{ v: `${p.name} ${p.start}–${p.end}`, size: 8, color: '#64707d', align: 'center', fill: '#f1f2f4', ...border },
        ...tt.days.map(() => ({ v: '', fill: '#f1f2f4', ...border }))] });
      merges.push(`A${rows.length}:${last}${rows.length}`);
      return;
    }
    const cells = tt.days.map((d, di) => {
      const items = tt.cells[pi][di];
      if (!items.length) return { v: '', ...border };
      const text = items.length === 1
        ? [items[0].title, ...items[0].lines.filter(Boolean)].join('\n')
        : items.map((it) => [it.short || it.title, it.lines.filter(Boolean)[0]].filter(Boolean).join(' · ')).join('\n');
      return { v: text, fill: items[0].color, color: textColor(items[0].color), bold: items.length > 1, align: 'center', wrap: true, size: 9, ...border };
    });
    const maxLines = Math.max(3, ...tt.days.map((d, di) => tt.cells[pi][di].length));
    rows.push({ height: Math.min(80, 14 * maxLines), cells: [{ v: `${p.name}\n${p.start}–${p.end}`, bold: true, wrap: true, size: 9, fill: '#f6f7f9', ...border }, ...cells] });
  });
  return { name: tt.name, cols: [12, ...tt.days.map(() => 24)], rows, merges };
}

export function timetablesXlsx(list) {
  return xlsx(list.map(sheetOf));
}

// File-system safe name for downloads.
export const fileName = (s) => String(s || 'horari').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'horari';
