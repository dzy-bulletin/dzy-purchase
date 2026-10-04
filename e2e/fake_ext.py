# -*- coding: utf-8 -*-
"""假損益端（purchasePush）與假備份端（backup）：記下收到的 payload 供獨立算式驗證。"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Base:
    def __init__(self, key):
        self.key = key
        self.payloads = []
        self.lock = threading.Lock()
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                n = int(self.headers.get('Content-Length', 0))
                try:
                    p = json.loads(self.rfile.read(n))
                except Exception:
                    p = {}
                with outer.lock:
                    resp = outer.handle(p)
                b = json.dumps(resp, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(b)))
                self.end_headers()
                self.wfile.write(b)

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.port = self.httpd.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}/'
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakePnl(_Base):
    def __init__(self, key):
        super().__init__(key)
        self.lock_once = {}      # (unit, month) -> 剩餘回 LOCKED 的次數

    def handle(self, p):
        if p.get('key') != self.key or p.get('action') != 'purchasePush':
            return {'ok': False, 'code': 'AUTH', 'message': 'bad key'}
        k = (p['store_id'], p['month'])
        if self.lock_once.get(k, 0) > 0:
            self.lock_once[k] -= 1
            self.payloads.append(dict(p, _resp='LOCKED'))
            return {'ok': False, 'code': 'LOCKED', 'message': '該月已定稿', 'live': {}}
        self.payloads.append(dict(p, _resp='OK'))
        return {'ok': True, 'data': {'store_id': p['store_id'], 'month': p['month'], 'written': sorted(p['entries']),
                                     'skipped_manual': [], 'voided': 0}}


class FakeBackup(_Base):
    def handle(self, p):
        if p.get('key') != self.key or p.get('action') != 'backup':
            return {'ok': False, 'code': 'AUTH'}
        self.payloads.append(p)
        return {'ok': True, 'data': {'month': p['month']}}
