import { emptySchool, sampleSchool, upgrade, normalize } from './model.js';
import { greedyFill } from './solver/greedy.js';
import { api } from './api.js';

/*
 * Sessió d'usuari i centre obert. Les dades es desen al servidor automàticament poc després de cada canvi;
 * el servidor rebutja el desat (409) si algú altre ha modificat el centre mentrestant.
 */
const HISTORY = 100;
const SAVE_DELAY = 700;
const K_CURRENT = 'horaris.actual';

let me = null;            // { user, centres: [{ id, name }] }
let state = null;
let currentId = null;
let version = 0;
let past = [];
let future = [];
let dirty = false;
let saveTimer = null;
let saving = null;
let save = { status: 'saved', error: '', by: '' }; // status: saved | pending | saving | error | conflict
const subs = new Set();

export const subscribe = (fn) => subs.add(fn);
const emit = () => subs.forEach((fn) => fn(state));

export const getState = () => state;
export const getUser = () => me?.user || null;
export const isAdmin = () => me?.user.role === 'admin';
export const listCentres = () => me?.centres || [];
export const currentCentreId = () => currentId;
export const canUndo = () => past.length > 0;
export const canRedo = () => future.length > 0;
export const saveInfo = () => save;
export const hasUnsaved = () => dirty || !!saving;

const remember = (id) => { try { localStorage.setItem(K_CURRENT, id); } catch { /* ignore */ } };
const remembered = () => { try { return localStorage.getItem(K_CURRENT); } catch { return null; } };

async function load(id) {
  const c = await api('GET', `/api/centres/${id}`);
  currentId = c.id;
  version = c.version;
  state = normalize(upgrade(c.data));
  past = [];
  future = [];
  dirty = false;
  save = { status: 'saved', error: '', by: '' };
  remember(currentId);
}

async function openPreferred() {
  const list = listCentres();
  state = null;
  currentId = null;
  if (!list.length) return;
  const cur = remembered();
  await load(list.some((c) => c.id === cur) ? cur : list[0].id);
}

// Returns the logged-in user, or null if the login screen must be shown.
export async function init() {
  try {
    me = await api('GET', '/api/me');
  } catch (e) {
    if (e.status === 401) { me = null; state = null; return null; }
    throw e;
  }
  await openPreferred();
  return me.user;
}

export async function login(email, password) {
  await api('POST', '/api/login', { email, password });
  const u = await init();
  emit();
  return u;
}

export async function logout() {
  await flush();
  await api('POST', '/api/logout');
  me = null;
  state = null;
  currentId = null;
  emit();
}

// Reloads the user's centre list (after admin changes) and keeps the open centre if still visible.
export async function refreshCentres() {
  me = await api('GET', '/api/me');
  if (!listCentres().some((c) => c.id === currentId)) await openPreferred();
  emit();
}

function scheduleSave() {
  dirty = true;
  if (save.status !== 'conflict') save = { status: 'pending', error: '', by: '' };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

export async function flush({ force = false } = {}) {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty || !currentId || (save.status === 'conflict' && !force)) return;
  const id = currentId;
  dirty = false;
  save = { status: 'saving', error: '', by: '' };
  emit();
  saving = api('PUT', `/api/centres/${id}`, { data: state, version, force })
    .then((r) => {
      if (id === currentId) version = r.version;
      const entry = me?.centres.find((c) => c.id === id);
      if (entry) entry.name = r.name;
      save = { status: dirty ? 'pending' : 'saved', error: '', by: '' };
    })
    .catch((e) => {
      dirty = true;
      save = { status: e.status === 409 ? 'conflict' : 'error', error: e.message, by: e.extra?.by || '' };
    })
    .finally(() => { saving = null; emit(); });
  await saving;
}

// Discards local changes and loads the version stored on the server.
export async function reload() {
  clearTimeout(saveTimer);
  dirty = false;
  if (currentId) await load(currentId);
  emit();
}

export function update(fn, { record = true } = {}) {
  if (record) {
    past.push(JSON.stringify(state));
    if (past.length > HISTORY) past.shift();
    future = [];
  }
  const result = fn(state);
  normalize(state);
  scheduleSave();
  emit();
  return result;
}

export function undo() {
  if (!past.length) return;
  future.push(JSON.stringify(state));
  state = JSON.parse(past.pop());
  scheduleSave();
  emit();
}

export function redo() {
  if (!future.length) return;
  past.push(JSON.stringify(state));
  state = JSON.parse(future.pop());
  scheduleSave();
  emit();
}

export async function switchCentre(id) {
  if (id === currentId) return;
  await flush();
  if (dirty) throw new Error('No s’ha pogut desar el centre actual');
  await load(id);
  emit();
}

function sampleData() {
  const s = sampleSchool();
  greedyFill(s);
  return s;
}

export async function createCentre(name, template, data = null) {
  const s = data ? upgrade(data) : template === 'exemple' ? sampleData() : emptySchool();
  if (name) s.meta.name = name;
  const c = await api('POST', '/api/centres', { data: s });
  await flush();
  me = await api('GET', '/api/me');
  await load(c.id);
  emit();
  return c.id;
}

export async function deleteCentre(id) {
  await api('DELETE', `/api/centres/${id}`);
  if (id === currentId) { dirty = false; clearTimeout(saveTimer); currentId = null; }
  me = await api('GET', '/api/me');
  if (!currentId) await openPreferred();
  emit();
}

export function importData(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lessons)) throw new Error('El fitxer no és un horari vàlid');
  update(() => { state = upgrade(raw); });
}

export const exportData = () => JSON.stringify(state, null, 2);

// Centres saved in this browser by the earlier, server-less version of the app.
export function browserCentres() {
  try {
    const index = JSON.parse(localStorage.getItem('horaris.centres')) || [];
    return index.map((c) => {
      try { return { name: c.name, data: JSON.parse(localStorage.getItem(`horaris.centre.${c.id}`)) }; } catch { return null; }
    }).filter((c) => c?.data && Array.isArray(c.data.lessons));
  } catch {
    return [];
  }
}
