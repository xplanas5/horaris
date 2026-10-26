"""
Executa totes les proves:  python tests/run.py

- Proves de l'API (tests/test_server.py).
- Proves al navegador (Microsoft Edge sense finestra) contra un servidor temporal amb una base de dades buida.
- Validació amb Python dels fitxers Excel i PDF que genera l'aplicació.
- Mode local (sense servidor, com a GitHub Pages) servint la carpeta amb un servidor estàtic.
"""
import base64
import html
import io
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import server  # noqa: E402

EDGE = [r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', r'C:\Program Files\Microsoft\Edge\Application\msedge.exe']
EMAIL, PW = 'prova@prova.cat', 'contrasenya-prova'


def browser(url, profile):
    exe = next((p for p in EDGE if os.path.exists(p)), None)
    if not exe:
        sys.exit('No trobo Microsoft Edge')
    r = subprocess.run([exe, '--headless=new', '--disable-gpu', f'--user-data-dir={profile}', '--virtual-time-budget=120000',
                        '--dump-dom', url], capture_output=True, text=True, encoding='utf-8', timeout=600)
    return r.stdout


def pre(dom, ident):
    m = re.search(rf'<pre id="{ident}">(.*?)</pre>', dom, re.S)
    return html.unescape(m.group(1)) if m else None


def check_xlsx(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.testzip() is None, 'CRC incorrecte'
    for name in z.namelist():
        if name.endswith('.xml') or name.endswith('.rels'):
            ET.fromstring(z.read(name))
    sheets = [n for n in z.namelist() if n.startswith('xl/worksheets/')]
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    names = [s.get('name') for s in ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets', ns)]
    assert len(names) == len(set(n.lower() for n in names)) == len(sheets), 'noms de fulls repetits'
    assert all(len(n) <= 31 for n in names)
    return f'{len(sheets)} fulls, XML vàlid'


def check_pdf(data):
    text = data.decode('latin-1')
    assert text.startswith('%PDF-1.4')
    xref = int(re.search(r'startxref\n(\d+)', text).group(1))
    assert text[xref:xref + 4] == 'xref'
    offsets = re.findall(r'(\d{10}) 00000 n ', text[xref:])
    for i, off in enumerate(offsets, start=1):
        assert text[int(off):].startswith(f'{i} 0 obj'), f'objecte {i} fora de lloc'
    for length, body in re.findall(r'<< /Length (\d+) >>\nstream\n(.*?)\nendstream', text, re.S):
        assert int(length) == len(body), 'longitud de stream incorrecta'
    return f'{len(offsets)} objectes, xref correcta'


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    failures = 0
    print('== API ==')
    res = unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.discover(HERE, 'test_server.py'))
    failures += len(res.failures) + len(res.errors)

    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, 'prova.db')
        server.set_admin(db, EMAIL, PW, 'Prova')
        srv = server.make_server(db, '127.0.0.1', 0, quiet=True)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{srv.server_address[1]}'
        try:
            for page in ['rules.html', 'export.html', f'smoke.html?{urlencode({"email": EMAIL, "pw": PW})}']:
                print(f'\n== {page.split("?")[0]} ==')
                dom = browser(f'{base}/tests/{page}', os.path.join(tmp, 'edge'))
                result = pre(dom, 'done')
                if result is None:
                    print('FAIL la pàgina no ha acabat:', (pre(dom, 'out') or dom[:500]))
                    failures += 1
                    continue
                print(result)
                failures += result.count('FAIL')
                if page == 'export.html':
                    for kind, fn in [('xlsx', check_xlsx), ('pdf', check_pdf)]:
                        try:
                            print(f'OK   {kind} validat amb Python: {fn(base64.b64decode(pre(dom, kind)))}')
                        except Exception as e:  # noqa: BLE001
                            print(f'FAIL {kind}: {e}')
                            failures += 1
        finally:
            srv.shutdown()
            srv.server_close()

        print('\n== local.html (sense servidor) ==')
        quiet = type('Quiet', (SimpleHTTPRequestHandler,), {'log_message': lambda *a: None})
        static = ThreadingHTTPServer(('127.0.0.1', 0), partial(quiet, directory=os.path.join(HERE, '..')))
        threading.Thread(target=static.serve_forever, daemon=True).start()
        try:
            dom = browser(f'http://127.0.0.1:{static.server_address[1]}/tests/local.html', os.path.join(tmp, 'edge-local'))
            result = pre(dom, 'done')
            print(result if result is not None else f'FAIL la pàgina no ha acabat: {pre(dom, "out") or dom[:500]}')
            failures += 1 if result is None else result.count('FAIL')
        finally:
            static.shutdown()
            static.server_close()

    print(f'\n{"TOT CORRECTE" if not failures else f"{failures} ERRORS"}')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
