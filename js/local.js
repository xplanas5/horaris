// Mode local: quan no hi ha servidor (p. ex. a GitHub Pages) les crides a l'API es resolen aquí
// i els centres es desen al localStorage d'aquest navegador. No hi ha usuaris ni inici de sessió.

const K_INDEX = 'horaris.centres';
const kCentre = (id) => `horaris.centre.${id}`;
const USER = { id: 'local', email: '', name: 'Aquest navegador', role: 'admin', active: true };

const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { throw new Error('No s’ha pogut desar al navegador (potser no hi ha espai)'); }
};
const now = () => Math.floor(Date.now() / 1000);
const nameOf = (data) => String(data?.meta?.name || 'Centre sense nom').trim().slice(0, 200);

function index() {
  return read(K_INDEX, []).filter((c) => c && c.id).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ca'));
}

function getCentre(id) {
  const entry = index().find((c) => c.id === id);
  const data = read(kCentre(id), null);
  if (!entry || !data) throw Object.assign(new Error('Aquest centre no existeix'), { status: 404 });
  return { id, name: entry.name, version: entry.version || 1, updatedAt: entry.updatedAt || 0, data };
}

function putCentre(id, data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.lessons)) throw Object.assign(new Error('Dades no vàlides'), { status: 400 });
  const list = index();
  const entry = list.find((c) => c.id === id) || (list.push({ id }), list.at(-1));
  write(kCentre(id), data);
  Object.assign(entry, { name: nameOf(data), version: (entry.version || 0) + 1, updatedAt: now() });
  write(K_INDEX, list);
  return { id, name: entry.name, version: entry.version };
}

function deleteCentre(id) {
  write(K_INDEX, index().filter((c) => c.id !== id));
  try { localStorage.removeItem(kCentre(id)); } catch { /* ignore */ }
}

export function localApi(method, path, body) {
  const m = path.match(/^\/api\/centres\/([^/]+)$/);
  const route = m ? `${method} /api/centres/:id` : `${method} ${path}`;
  const id = m ? decodeURIComponent(m[1]) : '';
  switch (route) {
    case 'GET /api/me': return { user: USER, centres: index().map(({ id: cid, name, updatedAt }) => ({ id: cid, name, updatedAt })) };
    case 'POST /api/logout': return {};
    case 'GET /api/centres': return index();
    case 'POST /api/centres': return putCentre(`c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, body?.data);
    case 'GET /api/centres/:id': return getCentre(id);
    case 'PUT /api/centres/:id': return putCentre(id, body?.data);
    case 'DELETE /api/centres/:id': deleteCentre(id); return {};
    case 'GET /api/users': return [];
    default: throw Object.assign(new Error('No disponible sense servidor'), { status: 400 });
  }
}
