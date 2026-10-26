#!/usr/bin/env python3
"""
Servidor de l'aplicació d'horaris: fitxers estàtics + API amb usuaris, centres i horaris (SQLite).
Només fa servir la biblioteca estàndard de Python.

    python server.py                         inicia el servidor a http://localhost:8000
    python server.py --host 0.0.0.0          accessible des d'altres ordinadors de la xarxa
    python server.py admin correu@xtec.cat   crea un administrador o li canvia la contrasenya

En producció cal posar-lo darrere d'un servidor HTTPS (i usar --cookie-segura): sense HTTPS
les contrasenyes viatgen sense xifrar.
"""
import argparse
import getpass
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from contextlib import closing, contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(ROOT, 'data', 'horaris.db')
STATIC_DIRS = ('css', 'js', 'tests')
COOKIE = 'horaris_sessio'
SESSION_SECONDS = 14 * 24 * 3600
PBKDF2_ITERATIONS = 240_000
MAX_BODY = 10 * 1024 * 1024
MIN_PASSWORD = 8
LOGIN_WINDOW, LOGIN_MAX_FAILS = 15 * 60, 5
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'centre')), pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS centres (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS user_centres (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  centre_id INTEGER NOT NULL REFERENCES centres(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, centre_id));
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL);
"""


# ---------- passwords and database ----------

def hash_password(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, PBKDF2_ITERATIONS)
    return f'pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${h.hex()}'


def check_password(pw, stored):
    try:
        _, it, salt, h = stored.split('$')
        calc = hashlib.pbkdf2_hmac('sha256', pw.encode(), bytes.fromhex(salt), int(it))
        return hmac.compare_digest(calc.hex(), h)
    except ValueError:
        return False


def connect(path):
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys = ON')
    return db


@contextmanager
def transaction(path):
    """Connection that commits (or rolls back) and is closed at the end of the block."""
    with closing(connect(path)) as db, db:
        yield db


def init_db(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with transaction(path) as db:
        db.executescript(SCHEMA)
        db.execute('PRAGMA journal_mode = WAL')


def set_admin(path, email, password, name=''):
    """Creates the admin user, or resets its password and makes it admin if it exists."""
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise ValueError('Correu no vàlid')
    if len(password) < MIN_PASSWORD:
        raise ValueError(f'La contrasenya ha de tenir almenys {MIN_PASSWORD} caràcters')
    init_db(path)
    with transaction(path) as db:
        row = db.execute('SELECT id FROM users WHERE email = ?', (email,)).fetchone()
        if row:
            db.execute("UPDATE users SET role = 'admin', active = 1, pw_hash = ?, name = COALESCE(NULLIF(?, ''), name) WHERE id = ?",
                       (hash_password(password), name, row['id']))
            db.execute('DELETE FROM sessions WHERE user_id = ?', (row['id'],))
            return 'actualitzat'
        db.execute("INSERT INTO users (email, name, role, pw_hash, created_at) VALUES (?, ?, 'admin', ?, ?)",
                   (email, name, hash_password(password), int(time.time())))
        return 'creat'


# ---------- HTTP ----------

class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def user_json(u, centre_ids=None):
    out = {'id': str(u['id']), 'email': u['email'], 'name': u['name'], 'role': u['role'], 'active': bool(u['active'])}
    if centre_ids is not None:
        out['centreIds'] = centre_ids
    return out


class Handler(SimpleHTTPRequestHandler):
    server_version = 'Horaris'
    routes = []  # (method, regex, function name)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api/') else 'no-cache')
        super().end_headers()

    # ----- static files: only the app itself, never the database or the server code -----
    def static_allowed(self):
        path = urlparse(self.path).path
        if path in ('/', '/index.html'):
            return True
        parts = path.lstrip('/').split('/')
        return len(parts) > 1 and parts[0] in STATIC_DIRS and '..' not in parts and '' not in parts[1:]

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self.api('GET')
        if not self.static_allowed():
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        if not self.static_allowed():
            return self.send_error(404)
        return super().do_HEAD()

    def do_POST(self):
        self.api('POST')

    def do_PUT(self):
        self.api('PUT')

    def do_DELETE(self):
        self.api('DELETE')

    # ----- API plumbing -----
    def api(self, method):
        path = urlparse(self.path).path
        self.db = connect(self.server.db_path)
        self.out_cookie = None
        try:
            # Simple CSRF guard: browsers do not send custom headers cross-site without CORS.
            if method != 'GET' and self.headers.get('X-Horaris') != '1':
                raise ApiError(403, 'Petició no permesa')
            for m, rx, fn in self.routes:
                match = rx.fullmatch(path)
                if m == method and match:
                    with self.db:
                        result = getattr(self, fn)(*match.groups())
                    return self.send_json(200, result if result is not None else {'ok': True})
            raise ApiError(404, 'No trobat')
        except ApiError as e:
            self.send_json(e.status, {'error': e.message, **e.extra})
        except Exception as e:  # pragma: no cover - unexpected
            self.log_error('Error intern: %r', e)
            self.send_json(500, {'error': 'Error intern del servidor'})
        finally:
            self.db.close()

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if self.out_cookie:
            self.send_header('Set-Cookie', self.out_cookie)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY:
            raise ApiError(413, 'Les dades són massa grans')
        try:
            data = json.loads(self.rfile.read(n) or b'{}')
        except ValueError:
            raise ApiError(400, 'JSON no vàlid')
        if not isinstance(data, dict):
            raise ApiError(400, 'JSON no vàlid')
        return data

    def token(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            k, _, v = part.strip().partition('=')
            if k == COOKIE:
                return v
        return None

    def set_cookie(self, token, max_age):
        secure = '; Secure' if self.server.secure_cookie else ''
        self.out_cookie = f'{COOKIE}={token}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Strict{secure}'

    def user(self, admin=False):
        tok = self.token()
        if not tok:
            raise ApiError(401, 'Cal iniciar sessió')
        th = hashlib.sha256(tok.encode()).hexdigest()
        u = self.db.execute(
            'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1',
            (th, int(time.time()))).fetchone()
        if not u:
            raise ApiError(401, 'La sessió ha caducat. Torna a entrar.')
        if admin and u['role'] != 'admin':
            raise ApiError(403, 'Només per a administradors')
        return u

    def centre_ids(self, user_id):
        return [str(r[0]) for r in self.db.execute('SELECT centre_id FROM user_centres WHERE user_id = ? ORDER BY centre_id', (user_id,))]

    def centre_for(self, u, cid):
        c = self.db.execute('SELECT * FROM centres WHERE id = ?', (cid,)).fetchone()
        if not c:
            raise ApiError(404, 'Aquest centre no existeix')
        if u['role'] != 'admin' and str(c['id']) not in self.centre_ids(u['id']):
            raise ApiError(403, 'No tens accés a aquest centre')
        return c

    def visible_centres(self, u):
        if u['role'] == 'admin':
            rows = self.db.execute('SELECT id, name, updated_at FROM centres ORDER BY name COLLATE NOCASE')
        else:
            rows = self.db.execute('SELECT c.id, c.name, c.updated_at FROM centres c JOIN user_centres uc ON uc.centre_id = c.id '
                                   'WHERE uc.user_id = ? ORDER BY c.name COLLATE NOCASE', (u['id'],))
        return [{'id': str(r['id']), 'name': r['name'], 'updatedAt': r['updated_at']} for r in rows]

    # ----- sessions -----
    def login(self):
        b = self.body()
        email = str(b.get('email', '')).strip().lower()
        pw = str(b.get('password', ''))
        fails = self.server.fails
        now = time.time()
        with self.server.lock:
            recent = [t for t in fails.get(email, []) if now - t < LOGIN_WINDOW]
            fails[email] = recent
        if len(recent) >= LOGIN_MAX_FAILS:
            raise ApiError(429, 'Massa intents fallits. Torna-ho a provar d’aquí a uns minuts.')
        u = self.db.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()
        if not u or not u['active'] or not check_password(pw, u['pw_hash']):
            with self.server.lock:
                fails.setdefault(email, []).append(now)
            raise ApiError(401, 'Correu o contrasenya incorrectes')
        with self.server.lock:
            fails.pop(email, None)
        tok = secrets.token_urlsafe(32)
        self.db.execute('DELETE FROM sessions WHERE expires < ?', (int(now),))
        self.db.execute('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)',
                        (hashlib.sha256(tok.encode()).hexdigest(), u['id'], int(now) + SESSION_SECONDS))
        self.set_cookie(tok, SESSION_SECONDS)
        return {'user': user_json(u)}

    def logout(self):
        tok = self.token()
        if tok:
            self.db.execute('DELETE FROM sessions WHERE token_hash = ?', (hashlib.sha256(tok.encode()).hexdigest(),))
        self.set_cookie('', 0)

    def me(self):
        u = self.user()
        return {'user': user_json(u), 'centres': self.visible_centres(u)}

    def change_password(self):
        u = self.user()
        b = self.body()
        if not check_password(str(b.get('current', '')), u['pw_hash']):
            raise ApiError(400, 'La contrasenya actual no és correcta')
        new = str(b.get('new', ''))
        if len(new) < MIN_PASSWORD:
            raise ApiError(400, f'La contrasenya nova ha de tenir almenys {MIN_PASSWORD} caràcters')
        self.db.execute('UPDATE users SET pw_hash = ? WHERE id = ?', (hash_password(new), u['id']))
        # Close every other session of this user.
        th = hashlib.sha256(self.token().encode()).hexdigest()
        self.db.execute('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', (u['id'], th))

    # ----- centres -----
    def list_centres(self):
        return self.visible_centres(self.user())

    def get_centre(self, cid):
        c = self.centre_for(self.user(), cid)
        return {'id': str(c['id']), 'name': c['name'], 'version': c['version'], 'updatedAt': c['updated_at'],
                'data': json.loads(c['data'])}

    @staticmethod
    def check_data(data):
        if not isinstance(data, dict) or not isinstance(data.get('lessons'), list):
            raise ApiError(400, 'Les dades no són un horari vàlid')
        name = str((data.get('meta') or {}).get('name') or 'Centre sense nom').strip()[:200]
        return name, json.dumps(data, ensure_ascii=False)

    def create_centre(self):
        u = self.user(admin=True)
        name, data = self.check_data(self.body().get('data'))
        cur = self.db.execute('INSERT INTO centres (name, data, updated_at, updated_by) VALUES (?, ?, ?, ?)',
                              (name, data, int(time.time()), u['id']))
        return {'id': str(cur.lastrowid), 'name': name, 'version': 1}

    def save_centre(self, cid):
        u = self.user()
        c = self.centre_for(u, cid)
        b = self.body()
        name, data = self.check_data(b.get('data'))
        if not b.get('force') and b.get('version') != c['version']:
            who = self.db.execute('SELECT name, email FROM users WHERE id = ?', (c['updated_by'],)).fetchone()
            raise ApiError(409, 'Algú altre ha modificat aquest centre mentre hi treballaves',
                           version=c['version'], by=(who['name'] or who['email']) if who else '')
        version = c['version'] + 1
        self.db.execute('UPDATE centres SET name = ?, data = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = ?',
                        (name, data, version, int(time.time()), u['id'], c['id']))
        return {'id': str(c['id']), 'name': name, 'version': version}

    def delete_centre(self, cid):
        self.user(admin=True)
        if not self.db.execute('DELETE FROM centres WHERE id = ?', (cid,)).rowcount:
            raise ApiError(404, 'Aquest centre no existeix')

    # ----- users (admin) -----
    def list_users(self):
        self.user(admin=True)
        rows = self.db.execute('SELECT * FROM users ORDER BY role, email').fetchall()
        return [user_json(r, self.centre_ids(r['id'])) for r in rows]

    def set_user_centres(self, uid, ids):
        if not isinstance(ids, list):
            raise ApiError(400, 'Llista de centres no vàlida')
        valid = {str(r[0]) for r in self.db.execute('SELECT id FROM centres')}
        self.db.execute('DELETE FROM user_centres WHERE user_id = ?', (uid,))
        for cid in {str(x) for x in ids} & valid:
            self.db.execute('INSERT INTO user_centres (user_id, centre_id) VALUES (?, ?)', (uid, int(cid)))

    def create_user(self):
        self.user(admin=True)
        b = self.body()
        email = str(b.get('email', '')).strip().lower()
        if not EMAIL_RE.match(email):
            raise ApiError(400, 'Correu no vàlid')
        if self.db.execute('SELECT 1 FROM users WHERE email = ?', (email,)).fetchone():
            raise ApiError(400, 'Ja hi ha un usuari amb aquest correu')
        pw = str(b.get('password', ''))
        if len(pw) < MIN_PASSWORD:
            raise ApiError(400, f'La contrasenya ha de tenir almenys {MIN_PASSWORD} caràcters')
        role = 'admin' if b.get('role') == 'admin' else 'centre'
        cur = self.db.execute('INSERT INTO users (email, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)',
                              (email, str(b.get('name', '')).strip()[:200], role, hash_password(pw), int(time.time())))
        self.set_user_centres(cur.lastrowid, b.get('centreIds', []))
        u = self.db.execute('SELECT * FROM users WHERE id = ?', (cur.lastrowid,)).fetchone()
        return user_json(u, self.centre_ids(u['id']))

    def other_active_admins(self, uid):
        return self.db.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", (uid,)).fetchone()[0]

    def update_user(self, uid):
        me = self.user(admin=True)
        u = self.db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not u:
            raise ApiError(404, 'Aquest usuari no existeix')
        b = self.body()
        role = b.get('role', u['role'])
        role = 'admin' if role == 'admin' else 'centre'
        active = bool(b.get('active', u['active']))
        losing_admin = u['role'] == 'admin' and u['active'] and (role != 'admin' or not active)
        if losing_admin and int(uid) == me['id']:
            raise ApiError(400, 'No et pots treure el rol d’administrador ni desactivar-te a tu mateix')
        if losing_admin and not self.other_active_admins(int(uid)):
            raise ApiError(400, 'Ha de quedar almenys un administrador actiu')
        email = str(b.get('email', u['email'])).strip().lower()
        if not EMAIL_RE.match(email):
            raise ApiError(400, 'Correu no vàlid')
        if self.db.execute('SELECT 1 FROM users WHERE email = ? AND id <> ?', (email, uid)).fetchone():
            raise ApiError(400, 'Ja hi ha un usuari amb aquest correu')
        name = str(b.get('name', u['name'])).strip()[:200]
        self.db.execute('UPDATE users SET email = ?, name = ?, role = ?, active = ? WHERE id = ?', (email, name, role, int(active), uid))
        if 'password' in b and b['password']:
            if len(str(b['password'])) < MIN_PASSWORD:
                raise ApiError(400, f'La contrasenya ha de tenir almenys {MIN_PASSWORD} caràcters')
            self.db.execute('UPDATE users SET pw_hash = ? WHERE id = ?', (hash_password(str(b['password'])), uid))
            if int(uid) != me['id']:
                self.db.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
        if not active:
            self.db.execute('DELETE FROM sessions WHERE user_id = ?', (uid,))
        if 'centreIds' in b:
            self.set_user_centres(int(uid), b['centreIds'])
        u = self.db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        return user_json(u, self.centre_ids(u['id']))

    def delete_user(self, uid):
        me = self.user(admin=True)
        if int(uid) == me['id']:
            raise ApiError(400, 'No et pots eliminar a tu mateix')
        u = self.db.execute('SELECT * FROM users WHERE id = ?', (uid,)).fetchone()
        if not u:
            raise ApiError(404, 'Aquest usuari no existeix')
        if u['role'] == 'admin' and u['active'] and not self.other_active_admins(int(uid)):
            raise ApiError(400, 'Ha de quedar almenys un administrador actiu')
        self.db.execute('DELETE FROM users WHERE id = ?', (uid,))


Handler.routes = [(m, re.compile(p), fn) for m, p, fn in [
    ('POST', r'/api/login', 'login'),
    ('POST', r'/api/logout', 'logout'),
    ('GET', r'/api/me', 'me'),
    ('POST', r'/api/me/password', 'change_password'),
    ('GET', r'/api/centres', 'list_centres'),
    ('POST', r'/api/centres', 'create_centre'),
    ('GET', r'/api/centres/(\d+)', 'get_centre'),
    ('PUT', r'/api/centres/(\d+)', 'save_centre'),
    ('DELETE', r'/api/centres/(\d+)', 'delete_centre'),
    ('GET', r'/api/users', 'list_users'),
    ('POST', r'/api/users', 'create_user'),
    ('PUT', r'/api/users/(\d+)', 'update_user'),
    ('DELETE', r'/api/users/(\d+)', 'delete_user'),
]]


def make_server(db_path=DEFAULT_DB, host='127.0.0.1', port=8000, secure_cookie=False, quiet=False):
    init_db(db_path)
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.db_path, srv.secure_cookie, srv.quiet = db_path, secure_cookie, quiet
    srv.fails, srv.lock = {}, threading.Lock()
    return srv


def main():
    ap = argparse.ArgumentParser(description="Servidor de l'aplicació d'horaris")
    ap.add_argument('--host', default='127.0.0.1', help='127.0.0.1 = només aquest ordinador; 0.0.0.0 = tota la xarxa')
    ap.add_argument('--port', type=int, default=8000)
    ap.add_argument('--db', default=DEFAULT_DB, help='fitxer de la base de dades')
    ap.add_argument('--cookie-segura', action='store_true', help='marca la galeta com a Secure (cal HTTPS)')
    ap.add_argument('--silenci', action='store_true', help='no mostris cada petició')
    ap.add_argument('ordre', nargs='?', choices=['admin'], help='admin: crea un administrador o en canvia la contrasenya')
    ap.add_argument('correu', nargs='?')
    ap.add_argument('--nom', default='', help="nom de l'administrador")
    a = ap.parse_args()

    if a.ordre == 'admin':
        if not a.correu:
            ap.error('Cal indicar el correu: python server.py admin correu@xtec.cat')
        pw = getpass.getpass('Contrasenya: ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
        try:
            print(f'Administrador {a.correu} {set_admin(a.db, a.correu, pw, a.nom)}.')
        except ValueError as e:
            sys.exit(str(e))
        return

    srv = make_server(a.db, a.host, a.port, a.cookie_segura, a.silenci)
    with transaction(a.db) as db:
        if not db.execute("SELECT 1 FROM users WHERE role = 'admin'").fetchone():
            print('Encara no hi ha cap administrador. Crea-ne un amb:  python server.py admin correu@xtec.cat')
    print(f'Horaris a http://{"localhost" if a.host in ("127.0.0.1", "0.0.0.0") else a.host}:{a.port}  (Ctrl+C per aturar)')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
