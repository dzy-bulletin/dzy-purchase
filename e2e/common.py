# -*- coding: utf-8 -*-
"""共用：檢查登記、截圖、按鈕稽核包裝、API 小工具、對話框處理。"""
import json
import os
import urllib.request
import urllib.error
import uuid

from clickmap import ClickMap, KEY_JS

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, 'artifacts')
RESULTS = []
CM = ClickMap()
DLG = {'log': [], 'dismiss': False, 'prompt': None}
ENV = {}          # API、前端網址等（run.py 填）


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok), str(detail)))
    print(('✅ ' if ok else '❌ ') + name + (f'　{detail}' if (detail and not ok) else ''), flush=True)


def eq(name, got, want):
    ok = got == want
    check(name, ok, f'實際={got!r} 預期={want!r}')
    return ok


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    try:
        page.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=True)
    except Exception:
        pass


def on_dialog(d):
    DLG['log'].append((d.type, d.message))
    if DLG['dismiss']:
        d.dismiss()
    elif d.type == 'prompt':
        d.accept(DLG['prompt'] if DLG['prompt'] is not None else d.default_value)
    else:
        d.accept()


def last_dialog():
    return DLG['log'][-1] if DLG['log'] else (None, '')


# ── 按鈕稽核 ──
def scan(page, screen):
    CM.scan(page, screen)


def ck(page, selector, why, force_js=False, timeout=4000):
    """點一個元素並登記；元素不可點（disabled）時回 False 且不登記。"""
    k = page.evaluate(KEY_JS, selector)
    if k is None:
        return False
    if selector in ('#brandSwitch', '#brandPick', '#chpw', '#logout') and page.evaluate("()=>!!document.getElementById('snav')"):
        page.hover('#snav a')                       # 側欄收合時這幾個要先移入展開才看得到
        page.wait_for_timeout(350)
    try:
        if force_js:
            page.evaluate("(s)=>document.querySelector(s).click()", selector)
        else:
            page.click(selector, timeout=timeout)
    except Exception as e:
        return False
    CM.mark(k, why)
    if selector.startswith('#snav') or selector in ('#brandSwitch', '#brandPick', '#chpw', '#logout'):
        away(page)
    return True


def away(page):
    """把滑鼠移離側欄（不然側欄一直展開，蓋住左邊的清單）。"""
    try:
        page.evaluate("()=>{if(document.activeElement)document.activeElement.blur()}")
        page.mouse.move(1100, 650)
        page.wait_for_timeout(700)
    except Exception:
        pass


def mark(page, selector, why):
    k = page.evaluate(KEY_JS, selector)
    if k:
        CM.mark(k, why)


def txt(page, sel):
    return page.evaluate("(s)=>{const e=document.querySelector(s);return e?e.innerText:''}", sel)


def val(page, sel):
    return page.evaluate("(s)=>{const e=document.querySelector(s);return e?e.value:null}", sel)


# ── API ──
def api(method, path, token=None, body=None, raw=None, headers=None, expect_json=True):
    h = dict(headers or {})
    if token:
        h['Authorization'] = 'Bearer ' + token
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h['Content-Type'] = 'application/json'
    req = urllib.request.Request(ENV['API'] + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            b = r.read()
            code = r.status
            ct = r.headers.get('Content-Type', '')
    except urllib.error.HTTPError as e:
        b = e.read()
        code = e.code
        ct = e.headers.get('Content-Type', '')
    if 'json' in ct:
        return code, json.loads(b)
    return code, b


def login(account, password):
    code, j = api('POST', '/login', body={'account': account, 'password': password})
    return (j['data'] if j.get('ok') else None), code, j


def upload_api(token, client_id, files, vendor_id=None, vendor_name=None):
    bd = '----e2e' + uuid.uuid4().hex
    parts = []

    def field(k, v):
        parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    field('client_id', client_id)
    if vendor_id is not None:
        field('vendor_id', vendor_id)
    if vendor_name is not None:
        field('vendor_name', vendor_name)
    for i, f in enumerate(files):
        with open(f, 'rb') as fh:
            parts.append(f'--{bd}\r\nContent-Disposition: form-data; name="photos[]"; filename="p{i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + fh.read() + b'\r\n')
    parts.append(f'--{bd}--\r\n'.encode())
    return api('POST', '/slips', token=token, raw=b''.join(parts), headers={'Content-Type': f'multipart/form-data; boundary={bd}'})
