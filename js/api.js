// Crides a l'API del servidor (server.py). Llança ApiError amb l'estat HTTP i el missatge del servidor.
// Sense servidor (allotjament estàtic) passa al mode local de local.js.
import { localApi } from './local.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// null until the first call tells whether server.py is there; true → requests are served by local.js.
let local = null;
export const isLocal = () => local === true;

function callLocal(method, path, body) {
  try {
    return localApi(method, path, body);
  } catch (e) {
    throw new ApiError(e.status || 500, e.message);
  }
}

export async function api(method, path, body) {
  if (local) return callLocal(method, path, body);
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Horaris': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'No hi ha connexió amb el servidor');
  }
  if (local === null) {
    // A static host (GitHub Pages…) answers /api/* with its own 404 page instead of server.py's JSON.
    local = res.status === 404 && !(res.headers.get('Content-Type') || '').includes('json');
    if (local) return callLocal(method, path, body);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  if (!res.ok) {
    const { error, ...extra } = data;
    throw new ApiError(res.status, error || `Error ${res.status}`, extra);
  }
  return data;
}
