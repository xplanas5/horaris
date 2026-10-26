import * as store from './store.js';
import { api } from './api.js';
import { openNewCentre } from './editor.js';
import { esc } from './util.js';

// Pantalla d'inici de sessió, compte propi (canvi de contrasenya) i administració de centres i usuaris.

const root = document.getElementById('modal');
const K_IMPORTED = 'horaris.navegador.importat';

// ---------- login ----------

export function loginHtml(error = '') {
  return `<div class="login">
    <form id="login-form" class="login-box" autocomplete="on">
      <div class="brand big">Horaris</div>
      <p class="hint">Entra amb el correu i la contrasenya del teu centre.</p>
      <label>Correu <input name="email" type="email" autocomplete="username" required autofocus></label>
      <label>Contrasenya <input name="password" type="password" autocomplete="current-password" required></label>
      ${error ? `<p class="err">${esc(error)}</p>` : ''}
      <button type="submit" class="primary">Entra</button>
    </form>
  </div>`;
}

// ---------- own account ----------

let accountMsg = null; // { ok, text }

export function openAccount() {
  accountMsg = null;
  drawAccount();
}

function drawAccount() {
  const u = store.getUser();
  root.innerHTML = `
  <div class="overlay"><div class="modal small" role="dialog" aria-modal="true" aria-label="El meu compte" data-panel="account">
    <header><h3>El meu compte</h3><button class="x" data-close-btn title="Tanca">×</button></header>
    <div class="modal-body">
      <p><b>${esc(u.name || u.email)}</b><br><span class="hint">${esc(u.email)} · ${u.role === 'admin' ? 'Administrador' : 'Usuari de centre'}</span></p>
      <form id="acc-password" class="form">
        <h3>Canvia la contrasenya</h3>
        <label>Contrasenya actual <input name="current" type="password" autocomplete="current-password" required></label>
        <label>Contrasenya nova <input name="new" type="password" autocomplete="new-password" minlength="8" required></label>
        <label>Repeteix-la <input name="again" type="password" autocomplete="new-password" minlength="8" required></label>
        ${accountMsg ? `<p class="${accountMsg.ok ? 'okmsg' : 'err'}">${esc(accountMsg.text)}</p>` : ''}
        <div class="actions"><button type="submit" class="primary">Desa la contrasenya</button></div>
      </form>
    </div>
  </div></div>`;
}

// ---------- admin ----------

let tab = 'centres';
let users = [];
let editing = null; // user id being edited, 'new', or null
let msg = null;     // { ok, text }

export async function openAdmin(t = 'centres') {
  tab = t;
  editing = null;
  msg = null;
  await loadUsers();
  drawAdmin();
}

async function loadUsers() {
  users = await api('GET', '/api/users');
}

const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString('ca-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function centresTab() {
  const centres = store.listCentres();
  const local = (() => { try { return localStorage.getItem(K_IMPORTED) ? [] : store.browserCentres(); } catch { return []; } })();
  const rows = centres.map((c) => {
    const who = users.filter((u) => u.centreIds.includes(c.id));
    return `<tr>
      <td><b>${esc(c.name)}</b></td>
      <td>${who.map((u) => `<span class="chip plain">${esc(u.name || u.email)}</span>`).join(' ') || '<span class="hint">Cap usuari</span>'}</td>
      <td class="hint">${fmtDate(c.updatedAt)}</td>
      <td class="rowacts">
        <button data-adm-open="${c.id}">Obre</button>
        <button class="danger" data-adm-del-centre="${c.id}" title="Elimina el centre">✕</button>
      </td></tr>`;
  }).join('');
  return `
    <div class="toolbar-row"><button class="primary" data-adm-new-centre>＋ Nou centre</button>
      <span class="hint">${centres.length} ${centres.length === 1 ? 'centre' : 'centres'}. Els usuaris es vinculen als centres des de la pestanya <b>Usuaris</b>.</span></div>
    ${local.length ? `<div class="notice">Aquest navegador té ${local.length} ${local.length === 1 ? 'centre desat' : 'centres desats'} amb la versió anterior (sense servidor):
      ${local.map((c) => `<b>${esc(c.name)}</b>`).join(', ')}.
      <button data-adm-import-local>Importa’ls al servidor</button></div>` : ''}
    <table class="etable wide"><thead><tr><th>Centre</th><th>Usuaris</th><th>Última modificació</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="hint">Encara no hi ha cap centre.</td></tr>'}</tbody></table>`;
}

function userForm(u) {
  const centres = store.listCentres();
  const isNew = !u;
  u = u || { email: '', name: '', role: 'centre', active: true, centreIds: [] };
  return `<form id="adm-user" class="userform">
    <h3>${isNew ? 'Nou usuari' : `Edita ${esc(u.email)}`}</h3>
    <div class="form inline">
      <label>Correu <input name="email" type="email" value="${esc(u.email)}" required></label>
      <label>Nom <input name="name" value="${esc(u.name)}" placeholder="Escola … o nom de la persona"></label>
      <label>Rol <select name="role">
        <option value="centre" ${u.role !== 'admin' ? 'selected' : ''}>Usuari de centre</option>
        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador (tots els centres)</option></select></label>
      <label>${isNew ? 'Contrasenya' : 'Contrasenya nova'} <input name="password" type="password" autocomplete="new-password" minlength="8" ${isNew ? 'required' : 'placeholder="Deixa-ho buit per no canviar-la"'}></label>
    </div>
    <div class="centre-picks"><span class="lbl">Centres als quals té accés</span>
      ${centres.map((c) => `<label><input type="checkbox" name="centre" value="${c.id}" ${u.centreIds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<span class="hint">Encara no hi ha cap centre.</span>'}
    </div>
    ${isNew ? '' : `<label class="inline-check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Actiu (pot entrar)</label>`}
    <div class="actions"><button type="button" data-adm-cancel>Cancel·la</button> <button type="submit" class="primary">${isNew ? 'Crea l’usuari' : 'Desa'}</button></div>
  </form>`;
}

function usersTab() {
  const centreName = new Map(store.listCentres().map((c) => [c.id, c.name]));
  const me = store.getUser();
  const rows = users.map((u) => `<tr class="${u.active ? '' : 'inactive'}">
      <td><b>${esc(u.email)}</b>${u.id === me.id ? ' <span class="hint">(tu)</span>' : ''}</td>
      <td>${esc(u.name)}</td>
      <td>${u.role === 'admin' ? '<span class="chip admin">Administrador</span>' : 'Centre'}</td>
      <td>${u.role === 'admin' ? '<span class="hint">Tots</span>' : u.centreIds.map((id) => `<span class="chip plain">${esc(centreName.get(id) || '?')}</span>`).join(' ') || '<span class="hint">Cap</span>'}</td>
      <td>${u.active ? 'Actiu' : '<span class="hint">Desactivat</span>'}</td>
      <td class="rowacts"><button data-adm-edit="${u.id}">Edita</button>${u.id === me.id ? '' : `<button class="danger" data-adm-del-user="${u.id}" title="Elimina l’usuari">✕</button>`}</td>
    </tr>`).join('');
  return `
    ${editing ? userForm(editing === 'new' ? null : users.find((u) => u.id === editing)) : '<div class="toolbar-row"><button class="primary" data-adm-new-user>＋ Nou usuari</button></div>'}
    <table class="etable wide"><thead><tr><th>Correu</th><th>Nom</th><th>Rol</th><th>Centres</th><th>Estat</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Els usuaris de centre només veuen i editen els seus centres. Els administradors veuen tots els centres i gestionen els usuaris.</p>`;
}

function drawAdmin() {
  const top = root.querySelector('.modal-body')?.scrollTop || 0;
  root.innerHTML = `
  <div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="Administració" data-panel="admin">
    <header>
      <nav class="tabs"><button data-adm-tab="centres" class="${tab === 'centres' ? 'on' : ''}">🏫 Centres</button><button data-adm-tab="users" class="${tab === 'users' ? 'on' : ''}">👤 Usuaris</button></nav>
      <button class="x" data-close-btn title="Tanca (Esc)">×</button>
    </header>
    <div class="modal-body">
      ${msg ? `<p class="${msg.ok ? 'okmsg' : 'err'}">${esc(msg.text)}</p>` : ''}
      ${tab === 'centres' ? centresTab() : usersTab()}
    </div>
  </div></div>`;
  root.querySelector('.modal-body').scrollTop = top;
}

async function run(fn, okText) {
  try {
    await fn();
    msg = okText ? { ok: true, text: okText } : null;
  } catch (e) {
    msg = { ok: false, text: e.message };
  }
  drawAdmin();
}

const panel = () => root.querySelector('[data-panel]')?.dataset.panel;

root.addEventListener('click', (e) => {
  if (panel() !== 'admin') return;
  const t = e.target;
  const tb = t.closest('[data-adm-tab]');
  if (tb) { tab = tb.dataset.admTab; editing = null; msg = null; drawAdmin(); return; }
  if (t.closest('[data-adm-new-centre]')) { openNewCentre(); return; }
  const open = t.closest('[data-adm-open]');
  if (open) {
    root.innerHTML = '';
    store.switchCentre(open.dataset.admOpen).catch((err) => alert(err.message));
    return;
  }
  const delC = t.closest('[data-adm-del-centre]');
  if (delC) {
    const c = store.listCentres().find((x) => x.id === delC.dataset.admDelCentre);
    if (!c || !confirm(`Segur que vols eliminar «${c.name}» i tots els seus horaris? No es pot desfer.`)) return;
    run(async () => { await store.deleteCentre(c.id); await loadUsers(); }, `S’ha eliminat «${c.name}».`);
    return;
  }
  if (t.closest('[data-adm-import-local]')) {
    run(async () => {
      const local = store.browserCentres();
      for (const c of local) await store.createCentre(c.name, null, c.data);
      try { localStorage.setItem(K_IMPORTED, '1'); } catch { /* ignore */ }
      await loadUsers();
    }, 'Centres importats al servidor.');
    return;
  }
  if (t.closest('[data-adm-new-user]')) { editing = 'new'; msg = null; drawAdmin(); return; }
  const ed = t.closest('[data-adm-edit]');
  if (ed) { editing = ed.dataset.admEdit; msg = null; drawAdmin(); root.querySelector('#adm-user')?.scrollIntoView({ block: 'nearest' }); return; }
  if (t.closest('[data-adm-cancel]')) { editing = null; drawAdmin(); return; }
  const delU = t.closest('[data-adm-del-user]');
  if (delU) {
    const u = users.find((x) => x.id === delU.dataset.admDelUser);
    if (!u || !confirm(`Segur que vols eliminar l’usuari ${u.email}?`)) return;
    run(async () => { await api('DELETE', `/api/users/${u.id}`); await loadUsers(); }, `S’ha eliminat ${u.email}.`);
  }
});

root.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id === 'adm-user') {
    e.preventDefault();
    const d = new FormData(f);
    const body = {
      email: String(d.get('email')).trim(), name: String(d.get('name')).trim(), role: d.get('role'),
      centreIds: d.getAll('centre'),
    };
    if (d.get('password')) body.password = d.get('password');
    const isNew = editing === 'new';
    if (!isNew) body.active = d.get('active') === 'on';
    run(async () => {
      await api(isNew ? 'POST' : 'PUT', isNew ? '/api/users' : `/api/users/${editing}`, body);
      editing = null;
      await loadUsers();
      await store.refreshCentres();
    }, isNew ? `S’ha creat l’usuari ${body.email}.` : 'Canvis desats.');
  } else if (f.id === 'acc-password') {
    e.preventDefault();
    const d = new FormData(f);
    if (d.get('new') !== d.get('again')) { accountMsg = { ok: false, text: 'Les dues contrasenyes noves no coincideixen' }; drawAccount(); return; }
    api('POST', '/api/me/password', { current: d.get('current'), new: d.get('new') })
      .then(() => { accountMsg = { ok: true, text: 'Contrasenya canviada.' }; })
      .catch((err) => { accountMsg = { ok: false, text: err.message }; })
      .finally(drawAccount);
  }
});
