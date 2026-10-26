// Crides a l'API del servidor (server.py). Llança ApiError amb l'estat HTTP i el missatge del servidor.

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export async function api(method, path, body) {
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
  let data = {};
  try { data = await res.json(); } catch { /* empty or not JSON */ }
  if (!res.ok) {
    const { error, ...extra } = data;
    throw new ApiError(res.status, error || `Error ${res.status}`, extra);
  }
  return data;
}
