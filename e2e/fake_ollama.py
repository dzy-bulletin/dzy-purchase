# -*- coding: utf-8 -*-
"""假 Ollama：依第一張照片的尺寸回傳「本次隨機資料集」對應的辨識 JSON（值一律字串）。
fail_first[code]=N：該貨單前 N 次請求回 500（模擬辨識失敗，之後「重新辨識」才成功）。"""
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from photos import jpeg_dims


class FakeOllama:
    def __init__(self):
        self.by_dims = {}        # (w,h) -> ai dict
        self.fail_first = {}     # (w,h) -> 次數
        self.hits = {}           # (w,h) -> 請求次數
        self.unknown = []
        self.prompts = {}        # (w,h) -> 最後一次的提示詞（驗證廠商記憶有附上）
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, obj):
                b = json.dumps(obj, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def do_GET(self):
                self._send(200, {'models': []})

            def do_POST(self):
                n = int(self.headers.get('Content-Length', 0))
                req = json.loads(self.rfile.read(n) or b'{}')
                imgs = req.get('images') or []
                raw = jpeg_dims(base64.b64decode(imgs[0])) if imgs else None
                dims = outer.match(raw)
                outer.hits[dims] = outer.hits.get(dims, 0) + 1
                outer.prompts[dims] = req.get('prompt', '')
                if dims not in outer.by_dims:
                    outer.unknown.append(dims)
                    return self._send(500, {'error': 'unknown slip'})
                if outer.hits[dims] <= outer.fail_first.get(dims, 0):
                    return self._send(500, {'error': 'fake failure'})
                self._send(200, {'response': json.dumps(outer.by_dims[dims], ensure_ascii=False)})

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def match(self, raw):
        """sips -Z 1600 會把小圖放大到長邊 1600（比例不變）→ 用寬高比找回是哪張貨單。"""
        if not raw:
            return None
        r = raw[0] / raw[1]
        best = min(self.by_dims, key=lambda k: abs(k[0] / k[1] - r), default=None)
        return best if best and abs(best[0] / best[1] - r) < 0.0008 else raw

    def start(self):
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
