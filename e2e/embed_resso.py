#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""嵌入模式（?embed=dzy）權限變更自動重進：只測網頁邏輯，後端與管理系統都用 Playwright route 模擬（不開任何伺服器、不連外）。

  cd e2e && python3 embed_resso.py      # 約 1 分鐘

情境（2026-10-26 Eason：admin 改了角色／品牌，已開著的嵌入頁要自己跟上，不用登出管理系統）：
  1. 進場：ready → 管理系統給券 → /sso → 核對頁
  2. 伺服器把 session 作廢（改角色 會計→admin）→ 下一個 API 401 → 自動再要一次券 → 重新載入成 admin，不出錯誤卡
  3. 60 秒內又 401 → 不再自動（防無限循環），顯示原本的「回管理系統重新整理」錯誤卡；按「重新連線」仍可手動進
  4. 尚未指派品牌的頁：從快取載入時悄悄重要券（沒變不重整）；admin 勾了品牌後重新整理或回到分頁 → 自動進核對頁；之後不再重整
"""
import json
import os
import re
import secrets
import sys
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(os.path.dirname(HERE), 'web')
PARENT = 'http://localhost:8777'
FRAME = 'http://localhost:8795'
API = 'http://localhost:8799/purchase/api'

PARENT_HTML = """<!doctype html><meta charset=utf-8><title>假管理系統</title>
<iframe id=f style="width:1000px;height:700px" src="%s"></iframe>
<script>
window.readyN = 0;
window.addEventListener('message', function (e) {
  var f = document.getElementById('f');
  if (e.source !== f.contentWindow || !e.data || e.data.type !== 'dzy-purchase-ready') return;
  window.readyN++;
  if (window.noTicket) return;
  var t = ''; for (var i = 0; i < 64; i++) t += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  f.contentWindow.postMessage({ type: 'dzy-purchase-sso', v: 1, ticket: t }, '%s');
});
</script>"""

fails = []
n = 0
CUR = {}          # 目前的 page：等待時用 page.wait_for_timeout 讓 Playwright 處理 route 回呼（time.sleep 會卡住回呼）


def nap(sec):
    CUR['page'].wait_for_timeout(int(sec * 1000))


def check(label, ok, info=''):
    global n
    n += 1
    print(('  ✔ ' if ok else '  ✖ ') + label + ('' if ok else f'  ← {info}'))
    if not ok:
        fails.append(label)


class FakeApi:
    def __init__(self):
        self.ident = {'role': 'accountant', 'name': '測試會計甲', 'brands': [{'id': 'X', 'name': '測試品牌'}]}
        self.valid = set()
        self.sso = 0
        self.logouts = 0

    def kill(self):
        self.valid.clear()

    def handle(self, route):
        req = route.request
        cors = {'Access-Control-Allow-Origin': FRAME, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'}
        if req.method == 'OPTIONS':
            return route.fulfill(status=204, headers=cors)
        path = re.sub(r'\?.*$', '', req.url[len(API):])

        def send(status, obj):
            route.fulfill(status=status, headers=dict(cors, **{'Content-Type': 'application/json'}), body=json.dumps(obj))
        if path == '/sso' and req.method == 'POST':
            self.sso += 1
            tok = secrets.token_hex(32)
            self.valid.add(tok)
            i = self.ident
            b = i['brands'][0]['id'] if i['role'] == 'accountant' and i['brands'] else None
            return send(200, {'ok': True, 'data': {'token': tok, 'expires_at': '2099-01-01T00:00:00Z', 'role': i['role'], 'must_change_password': False, 'name': i['name'],
                                                   'brand': b, 'brand_id': b, 'brands': i['brands'] if i['role'] == 'accountant' else [], 'store_id': None, 'store': None, 'embed': True}})
        auth = req.headers.get('authorization', '')
        tok = auth[7:] if auth.startswith('Bearer ') else ''
        if path == '/logout':
            self.logouts += 1
            self.valid.discard(tok)
            return send(200, {'ok': True, 'data': {}})
        if tok not in self.valid:
            return send(401, {'ok': False, 'error': 'AUTH', 'message': '登入已失效，請重新登入'})
        return send(200, {'ok': True, 'data': []})


def serve_web(route):
    p = re.sub(r'\?.*$', '', route.request.url[len(FRAME):]).lstrip('/') or 'index.html'
    f = os.path.normpath(os.path.join(WEB, p))
    if not f.startswith(WEB) or not os.path.isfile(f):
        return route.fulfill(status=404, body='')
    ct = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png'}.get(os.path.splitext(f)[1], 'application/octet-stream')
    with open(f, 'rb') as fh:
        route.fulfill(status=200, headers={'Content-Type': ct}, body=fh.read())


def open_ctx(browser, fake):
    ctx = browser.new_context()
    ctx.route(re.compile(r'^https?://(?!localhost)'), lambda r: r.abort())      # 不連外（字型等）
    ctx.route(re.compile('^' + re.escape(API)), fake.handle)
    ctx.route(re.compile('^' + re.escape(FRAME) + '/'), serve_web)
    src = f'{FRAME}/review.html?embed=dzy&api={API}#review'
    ctx.route(re.compile('^' + re.escape(PARENT) + '/'), lambda r: r.fulfill(status=200, headers={'Content-Type': 'text/html; charset=utf-8'}, body=PARENT_HTML % (src, FRAME)))
    page = ctx.new_page()
    CUR['page'] = page
    page.goto(PARENT + '/p.html')
    return ctx, page


def frame(page):
    for _ in range(100):
        f = [x for x in page.frames if x.url.startswith(FRAME)]
        if f:
            return f[0]
        nap(0.1)
    raise RuntimeError('iframe 沒出現')


def wait(cond, sec=10):
    t = time.time() + sec
    while time.time() < t:
        try:
            if cond():
                return True
        except Exception:
            pass
        nap(0.2)
    return False


def sess(page):
    return frame(page).evaluate("()=>JSON.parse(sessionStorage.getItem('purchase_embed_session')||'null')")


def shown(page, text):
    return text in frame(page).evaluate("()=>document.body.innerText")


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        # ---------- 1～3：已開著的頁，權限變更 ----------
        fake = FakeApi()
        ctx, page = open_ctx(browser, fake)
        check('進場：ready → 券 → /sso → 會計 session', wait(lambda: (sess(page) or {}).get('role') == 'accountant'), sess(page))
        check('進場：核對頁顯示（沒有等待卡）', wait(lambda: frame(page).evaluate("()=>!document.getElementById('app').classList.contains('hidden')")))
        sso0 = fake.sso
        tok0 = sess(page)['token']
        fake.kill()
        fake.ident = {'role': 'admin', 'name': '測試會計甲', 'brands': []}
        frame(page).evaluate("()=>Common.get('/review',{status:'review'}).catch(function(){})")
        check('改角色後 401 → 自動再要券並兌換（/sso 多 1 次）', wait(lambda: fake.sso == sso0 + 1), fake.sso - sso0)
        check('自動重進後 session 是 admin（不用登出管理系統）', wait(lambda: (sess(page) or {}).get('role') == 'admin'), sess(page))
        check('自動重進後畫面正常、沒有「重新整理」錯誤卡', wait(lambda: frame(page).evaluate("()=>!document.getElementById('app').classList.contains('hidden')")) and not shown(page, '請回管理系統重新整理'))
        check('自動重進後新 token ≠ 舊 token', sess(page)['token'] != tok0)
        nap(1)
        check('自動重進只發生一次（不循環）', fake.sso == sso0 + 1, fake.sso - sso0)
        # 60 秒內再 401：不自動，顯示錯誤卡
        sso1 = fake.sso
        fake.kill()
        frame(page).evaluate("()=>Common.get('/review',{status:'review'}).catch(function(){})")
        check('60 秒內又 401 → 顯示「回管理系統重新整理」錯誤卡', wait(lambda: shown(page, '請回管理系統重新整理')))
        nap(2)
        check('60 秒內又 401 → 不再自動要券', fake.sso == sso1, fake.sso - sso1)
        frame(page).click('#embedRetry')
        check('錯誤卡按「重新連線」→ 手動重進成功', wait(lambda: fake.sso == sso1 + 1 and frame(page).evaluate("()=>!document.getElementById('app').classList.contains('hidden')")), fake.sso - sso1)
        # 管理系統給不了券（例如權限被收回）：自動重進 15 秒後顯示錯誤卡
        frame(page).evaluate("()=>sessionStorage.removeItem('purchase_embed_resso_at')")
        page.evaluate("()=>{window.noTicket=true}")
        fake.kill()
        frame(page).evaluate("()=>Common.get('/review',{status:'review'}).catch(function(){})")
        check('自動重進時先顯示「正在重新登入」（不是錯誤）', wait(lambda: shown(page, '正在重新從鼎兆元管理系統登入')))
        check('管理系統沒給券 → 15 秒後改顯示錯誤卡', wait(lambda: shown(page, '請回管理系統重新整理'), 20))
        ctx.close()

        # ---------- 4：尚未指派品牌 ----------
        fake = FakeApi()
        fake.ident = {'role': 'accountant', 'name': '測試新同仁', 'brands': []}
        ctx, page = open_ctx(browser, fake)
        check('沒品牌：顯示「尚未指派品牌，請找 Eason」', wait(lambda: shown(page, '尚未指派品牌')))
        nap(1.5)
        check('沒品牌：剛兌過券就不再重要（/sso 只 1 次）', fake.sso == 1, fake.sso)
        frame(page).evaluate("()=>location.reload()")                   # 重新整理：sessionStorage 記著沒品牌
        check('沒品牌、從快取載入 → 悄悄重要一次券（/sso 共 2 次）', wait(lambda: fake.sso == 2), fake.sso)
        nap(1.5)
        check('品牌沒變 → 不重新載入、不循環', fake.sso == 2 and shown(page, '尚未指派品牌'), fake.sso)
        check('悄悄重要券時把舊 token 登出（不在伺服器累積 session）', wait(lambda: fake.logouts >= 1), fake.logouts)
        # 重新整理（sessionStorage 還在、記著沒品牌）：也會悄悄重要券
        fake.ident = {'role': 'accountant', 'name': '測試新同仁', 'brands': [{'id': 'X', 'name': '測試品牌'}]}
        fake.kill()
        frame(page).evaluate("()=>location.reload()")
        check('admin 勾品牌後重新整理 → 自動跟上、進核對頁', wait(lambda: not shown(page, '尚未指派品牌') and frame(page).evaluate("()=>!document.getElementById('app').classList.contains('hidden')"), 15))
        check('跟上後 session 帶新品牌', [b['id'] for b in (sess(page) or {}).get('brands', [])] == ['X'], sess(page))
        ctx.close()

        # 開著不動：回到分頁就跟上
        fake = FakeApi()
        fake.ident = {'role': 'accountant', 'name': '測試新同仁', 'brands': []}
        ctx, page = open_ctx(browser, fake)
        wait(lambda: shown(page, '尚未指派品牌'))
        nap(1)
        fake.ident = {'role': 'accountant', 'name': '測試新同仁', 'brands': [{'id': 'X', 'name': '測試品牌'}]}
        nap(21)                                                    # 悄悄重要券最少間隔 20 秒
        frame(page).evaluate("()=>window.dispatchEvent(new Event('focus'))")
        check('沒品牌頁開著：admin 勾品牌、回到分頁 → 自動進核對頁', wait(lambda: not shown(page, '尚未指派品牌') and (sess(page) or {}).get('brands'), 15), sess(page))
        s = fake.sso
        nap(2)
        check('進核對頁後不再重要券', fake.sso == s, fake.sso - s)
        ctx.close()
        browser.close()
    print(f'共 {n} 項檢查，通過 {n - len(fails)}，失敗 {len(fails)}')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
