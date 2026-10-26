"""Proves de l'API del servidor:  python -m unittest tests/test_server.py"""
import http.cookiejar
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import server  # noqa: E402

ADMIN, ADMIN_PW = 'admin@prova.cat', 'contrasenya-admin'
DATA = {'meta': {'name': 'Escola A'}, 'lessons': [], 'cards': []}


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def call(self, method, path, body=None, csrf=True):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode())
        req.add_header('Content-Type', 'application/json')
        if csrf:
            req.add_header('X-Horaris', '1')
        try:
            with self.opener.open(req) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {}

    def login(self, email, pw):
        return self.call('POST', '/api/login', {'email': email, 'password': pw})


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        db = os.path.join(cls.tmp.name, 'h.db')
        server.set_admin(db, ADMIN, ADMIN_PW, 'Admin')
        cls.srv = server.make_server(db, '127.0.0.1', 0, quiet=True)
        cls.base = f'http://127.0.0.1:{cls.srv.server_address[1]}'
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def admin(self):
        c = Client(self.base)
        self.assertEqual(c.login(ADMIN, ADMIN_PW)[0], 200)
        return c

    def test_login_required(self):
        self.assertEqual(Client(self.base).call('GET', '/api/me')[0], 401)

    def test_wrong_password_and_throttle(self):
        c = Client(self.base)
        email = 'nobody@prova.cat'
        for _ in range(server.LOGIN_MAX_FAILS):
            self.assertEqual(c.login(email, 'xxxxxxxxx')[0], 401)
        self.assertEqual(c.login(email, 'xxxxxxxxx')[0], 429)

    def test_csrf_header_required(self):
        c = self.admin()
        self.assertEqual(c.call('POST', '/api/centres', {'data': DATA}, csrf=False)[0], 403)

    def test_static_whitelist(self):
        c = Client(self.base)
        for path, code in [('/', 200), ('/js/main.js', 200), ('/server.py', 404), ('/data/horaris.db', 404),
                           ('/js/../server.py', 404), ('/README.md', 404)]:
            try:
                with c.opener.open(self.base + path) as r:
                    got = r.status
            except urllib.error.HTTPError as e:
                got = e.code
            self.assertEqual(got, code, path)

    def test_centre_user_flow(self):
        a = self.admin()
        st, c1 = a.call('POST', '/api/centres', {'data': DATA})
        self.assertEqual(st, 200)
        _, c2 = a.call('POST', '/api/centres', {'data': {**DATA, 'meta': {'name': 'Escola B'}}})
        st, u = a.call('POST', '/api/users', {'email': 'Centre@Prova.cat', 'name': 'Escola A', 'password': 'clau-centre',
                                              'centreIds': [c1['id']]})
        self.assertEqual(st, 200)
        self.assertEqual(u['email'], 'centre@prova.cat')
        self.assertEqual(u['centreIds'], [c1['id']])

        c = Client(self.base)
        self.assertEqual(c.login('centre@prova.cat', 'clau-centre')[0], 200)
        _, me = c.call('GET', '/api/me')
        self.assertEqual([x['id'] for x in me['centres']], [c1['id']])
        self.assertEqual(c.call('GET', f"/api/centres/{c2['id']}")[0], 403)
        self.assertEqual(c.call('POST', '/api/centres', {'data': DATA})[0], 403)
        self.assertEqual(c.call('GET', '/api/users')[0], 403)

        # Save with version check
        _, got = c.call('GET', f"/api/centres/{c1['id']}")
        data = {**got['data'], 'meta': {'name': 'Escola A nova'}}
        st, r = c.call('PUT', f"/api/centres/{c1['id']}", {'data': data, 'version': got['version']})
        self.assertEqual((st, r['version'], r['name']), (200, got['version'] + 1, 'Escola A nova'))
        st, r = a.call('PUT', f"/api/centres/{c1['id']}", {'data': data, 'version': got['version']})
        self.assertEqual(st, 409)
        self.assertEqual(r['by'], 'Escola A')
        self.assertEqual(a.call('PUT', f"/api/centres/{c1['id']}", {'data': data, 'version': 0, 'force': True})[0], 200)
        self.assertEqual(c.call('PUT', f"/api/centres/{c1['id']}", {'data': {'x': 1}, 'version': 99})[0], 400)

        # Password change closes other sessions; deactivation closes all.
        c_other = Client(self.base)
        c_other.login('centre@prova.cat', 'clau-centre')
        self.assertEqual(c.call('POST', '/api/me/password', {'current': 'dolenta', 'new': 'nova-clau-1'})[0], 400)
        self.assertEqual(c.call('POST', '/api/me/password', {'current': 'clau-centre', 'new': 'nova-clau-1'})[0], 200)
        self.assertEqual(c.call('GET', '/api/me')[0], 200)
        self.assertEqual(c_other.call('GET', '/api/me')[0], 401)
        self.assertEqual(a.call('PUT', f"/api/users/{u['id']}", {'active': False})[0], 200)
        self.assertEqual(c.call('GET', '/api/me')[0], 401)
        self.assertEqual(c.login('centre@prova.cat', 'nova-clau-1')[0], 401)

        # Delete centre removes the assignment.
        self.assertEqual(a.call('DELETE', f"/api/centres/{c1['id']}")[0], 200)
        _, users = a.call('GET', '/api/users')
        self.assertEqual(next(x for x in users if x['id'] == u['id'])['centreIds'], [])
        self.assertEqual(a.call('DELETE', f"/api/users/{u['id']}")[0], 200)

    def test_last_admin_protected(self):
        a = self.admin()
        _, me = a.call('GET', '/api/me')
        uid = me['user']['id']
        self.assertEqual(a.call('PUT', f'/api/users/{uid}', {'role': 'centre'})[0], 400)
        self.assertEqual(a.call('DELETE', f'/api/users/{uid}')[0], 400)
        self.assertEqual(a.call('POST', '/api/users', {'email': ADMIN, 'password': 'xxxxxxxxx'})[0], 400)
        self.assertEqual(a.call('POST', '/api/users', {'email': 'curt@prova.cat', 'password': 'curt'})[0], 400)

    def test_logout(self):
        a = self.admin()
        self.assertEqual(a.call('POST', '/api/logout')[0], 200)
        self.assertEqual(a.call('GET', '/api/me')[0], 401)


if __name__ == '__main__':
    unittest.main()
