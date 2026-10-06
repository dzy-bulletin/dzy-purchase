# -*- coding: utf-8 -*-
"""貨單辨識系統 e2e 的隨機資料與「獨立算式」。

規矩（data-drive-test skill）：
  1. 每次執行全部重抽（品牌下的門市、會計、廠商、品項、單位換算、貨單、價格、注入的錯誤）。
  2. 預期值照 docs/plan.md 規格自己算，絕不 import server/calc.js、web/js/rules.js。
  3. JS 捨入：Math.round 是「.5 進位」，Python round() 是銀行家捨入 → 一律用 floor(x+0.5)。
"""
import math
import random
import re
import unicodedata
from datetime import date, timedelta
from decimal import Decimal

BRANDS = {'X': '小辛辣', 'M': '墨竹亭', 'C': '央廚'}
COST_CATS = ['食材', '包材', '雜貨', '其他', '未分類']
CATS4 = COST_CATS[:4]
EPS = 2.220446049250313e-16


# ───────────── 數字／文字（規格重寫）─────────────
def jsround(x):
    return math.floor(x + 0.5)


def r2(x):                                   # round2 = Math.round((x+EPSILON)*100)/100
    return math.floor((x + EPS) * 100 + 0.5) / 100


def cents(x):
    return math.floor((x + EPS) * 100 + 0.5)


def near(a, b):
    return abs(a - b) < 0.01


def money_eq(x, ref):
    """規格（Eason 2026-10-07）：單上數字是整數 → 算出來的數四捨五入到整數再比；有小數 → 比到小數 2 位。"""
    if x is None or ref is None:
        return False
    if float(ref).is_integer():
        return jsround(x + 1e-9) == ref
    return near(r2(x), ref)


def parse_num(x):
    if x is None:
        return None
    s = unicodedata.normalize('NFKC', str(x))
    s = re.sub(r'[,，\s]', '', s)
    m = re.search(r'-?\d+(?:\.\d+)?', s)
    return r2(float(m.group(0))) if m else None


def pos(n):
    return n if (n is not None and n > 0) else None


def norm_text(s, mx=0):
    t = re.sub(r'[\x00-\x1f\x7f-\x9f]', ' ', '' if s is None else str(s)).strip()
    return t[:mx] if mx else t


def name_key(s):
    t = unicodedata.normalize('NFKC', norm_text(s))
    return re.sub(r'[\s()\[\]・·･]', '', t).lower()


STOP = ['合計', '小計', '總計', '總額', '稅額', '營業稅', '折扣', '折讓', '運費', '備註', '找零']


def ok_auto_vendor(n):
    n = norm_text(n)
    return 2 <= len(n) <= 60 and not re.fullmatch(r'[\d\s.,\-+*/%$]+', n)


def ok_auto_item(n):
    n = norm_text(n)
    return ok_auto_vendor(n) and not any(w in n for w in STOP)


def fmt(n):
    """畫面金額：千分位、小數為 0 不顯示（≤2 位）。"""
    if n is None:
        return ''
    c = cents(float(n))
    s = f'{abs(c) // 100:,}'
    f = f'{abs(c) % 100:02d}'.rstrip('0')
    return ('-' if c < 0 else '') + s + ('.' + f if f else '')


def tofixed1(x):
    """JS toFixed(1)：對「精確的二進位值」做 .5 進位（Python 格式化是偶數進位，不能用）。"""
    return str(Decimal(x).quantize(Decimal('0.1'), rounding='ROUND_HALF_UP'))


def sum_check(amounts, subtotal, tax, total, inc):
    missing = total is None or not amounts or any(a is None for a in amounts)
    s = r2(sum(a or 0 for a in amounts))
    if inc:
        ok = (not missing and money_eq(s, total) and (tax is None or (tax >= 0 and tax < total))
              and (subtotal is None or tax is None or money_eq(subtotal + tax, total)))
    else:
        ok = (not missing and money_eq(s + (tax or 0), total) and (subtotal is None or money_eq(s, subtotal)))
    return s, ok, missing


def sum_why(lines_amounts, subtotal, tax, total, inc):
    """核對頁「紅：…」白話說明（只檢查不相符時）。"""
    s, ok, missing = sum_check(lines_amounts, subtotal, tax, total, inc)
    if ok:
        return None
    if missing:
        return '總額或某一列金額沒有填，請對照照片補上。'
    if inc:
        if tax is not None and tax >= total:
            return '稅額 %s 不應大於或等於總額 %s，請檢查稅額是不是讀成了總計。' % (fmt(tax), fmt(total))
        if not money_eq(s, total):
            return ('品項加總 %s，但單上總額是 %s，差 %s。這張單已勾選「品項金額已含稅」，品項加總應該直接等於總額' % (fmt(s), fmt(total), fmt(r2(abs(s - total)))))
        us = r2(subtotal + tax)
        return '未稅合計 %s ＋ 稅額 %s ＝ %s，但總額是 %s，差 %s。' % (fmt(subtotal), fmt(tax), fmt(us), fmt(total), fmt(r2(abs(us - total))))
    t = tax or 0
    should = r2(s + t)
    if not money_eq(should, total):
        d = fmt(r2(abs(should - total)))
        if tax is not None:
            return '品項加總 %s ＋ 稅額 %s ＝ %s，但單上總額是 %s，差 %s。' % (fmt(s), fmt(t), fmt(should), fmt(total), d)
        return '品項加總 %s，但單上總額是 %s，差 %s。' % (fmt(s), fmt(total), d)
    return '品項加總 %s，但單上的未稅合計是 %s，差 %s。' % (fmt(s), fmt(subtotal), fmt(r2(abs(s - subtotal))))


FLAG_TEXT = {
    'AMOUNT_FIXED': '金額漏零，已改用數量×單價', 'AMOUNT_MISMATCH': '數量×單價≠金額', 'PRICE_MISSING': '缺單價',
    'HANDWRITTEN': '有手寫修改', 'ITEM_UNMAPPED': '品名還沒對到統一品名', 'UNIT_UNCONVERTED': '這個單位還沒設定換算',
}
RED = {'AMOUNT_MISMATCH', 'SUM_MISMATCH', 'PRICE_MISSING'}
NO_HAND = {'', '無', '无', '沒有', '没有', '無手寫', '無修改', '無手寫修改', 'none', 'null', 'n/a', 'na', '-', '無手寫修改說明'}


# ───────────── 隨機名稱 ─────────────
ITEM_POOL = ['高麗菜', '雞胸肉', '米粉', '紙碗', '洗潔精', '豬五花', '金針菇', '凍豆腐', '寬粉', '花椒油', '辣椒粉', '塑膠袋',
             '手套', '玉米筍', '鴨血', '牛腱', '蒜頭', '青江菜', '餐巾紙', '免洗筷', '竹輪', '魚板', '豆皮', '木耳', '香菜',
             '檸檬', '醬油', '白醋', '沙拉油', '衛生紙', '垃圾袋', '漂白水', '蝦仁', '蛤蜊', '花枝', '年糕']
FRESH_POOL = ['冷凍花枝丸', '特選牛百葉', '手工魚餃', '招牌丸子', '干貝醬', '昆布高湯包', '黑胡椒粒', '乾燥辣椒']
VENDOR_CHARS = '鑫旺福祥源興泰盛達豐億昌榮聯合順安'
UNKNOWN_CHARS = '甲乙丙丁戊己庚辛壬癸'
PLACES = ['光復', '美村', '南昌', '金山', '六張犁', '竹北', '中壢', '板橋', '三重']
UNITS_B = ['公斤', '包', '個', '瓶', '袋', '盒']
UNITS_C = ['箱', '袋', '台斤', '打', '籃']


def pw(rng, n=10):
    return ''.join(rng.choice('abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789') for _ in range(n))


def taipei_today():
    from datetime import datetime, timezone
    return datetime.now(timezone(timedelta(hours=8))).date()


# ───────────── 資料集 ─────────────
def make_dataset(rng, today):
    D = {'today': today, 'brands': BRANDS}
    bids = list(BRANDS)
    rng.shuffle(bids)
    D['brand_order'] = bids
    # 帳號
    multi = bids[:2]
    D['acc_multi'] = {'username': 'acc' + pw(rng, 4).lower(), 'name': '會計多品牌', 'brands': multi, 'pass0': pw(rng), 'pass1': pw(rng)}
    D['acc_single'] = {'username': 'acc' + pw(rng, 4).lower(), 'name': '會計單品牌', 'brands': [bids[2]], 'pass0': pw(rng), 'pass1': pw(rng)}
    D['admin'] = {'username': 'adm' + pw(rng, 4).lower(), 'pass': pw(rng)}
    # 門市
    used_codes = set()
    D['stores'] = []
    for b in bids:
        for i in range(rng.randint(1, 3)):
            while True:
                code = ''.join(rng.choice('ABCDEFGHJKLMNPQRSTUVWXYZ') for _ in range(rng.randint(2, 4))) + rng.choice(['', str(rng.randint(1, 9))])
                if code not in used_codes:
                    used_codes.add(code)
                    break
            D['stores'].append({'code': code, 'brand': b, 'name': f'{BRANDS[b]}{rng.choice(PLACES)}{i + 1}店',
                                'pass0': pw(rng), 'pass1': pw(rng), 'unit_code': None})
    for b in bids:                           # 每品牌至少一家有損益代號，其他隨機
        ss = [s for s in D['stores'] if s['brand'] == b]
        for k, s in enumerate(ss):
            if k == 0 or rng.random() < 0.5:
                s['unit_code'] = 'PNL' + pw(rng, 5).upper()
    # 廠商
    D['vendors'] = {}
    D['items'] = {}
    used_names = set()
    for b in bids:
        vs = []
        n = rng.randint(4, 8)
        while len(vs) < n:
            nm = ''.join(rng.choice(VENDOR_CHARS) for _ in range(3)) + rng.choice(['行', '商行', '企業', '食品'])
            if nm in used_names:
                continue
            used_names.add(nm)
            vs.append({'name': nm, 'kind': None, 'raw_style': {}})
        D['vendors'][b] = vs
        its = []
        for nm in rng.sample(ITEM_POOL, rng.randint(6, 9)):
            base = rng.choice(UNITS_B)
            conv = {}
            for u in rng.sample(UNITS_C, rng.randint(1, 3)):
                if u != base:
                    conv[u] = rng.choice([2, 5, 6, 10, 12, 20, 24, 0.6, 1.2, 0.5])
            its.append({'name': nm, 'cat': rng.choice(CATS4), 'base': base, 'conv': conv, 'price': rng.choice([12, 18, 25, 40, 55, 80, 120, 160, 210]), 'active': True})
        D['items'][b] = its
    return D


def model_conv_units(it):
    return list(it['conv'])


def make_slips(rng, D):
    """產生貨單（真值）。回傳 slips，依處理順序（wave1 在前）。"""
    today = D['today']
    days = [today - timedelta(days=i) for i in range(0, 56)]
    months = sorted({(d.year, d.month) for d in days})
    by_month = {m: [d for d in days if (d.year, d.month) == m] for m in months}
    kinds_cycle = ['inc', 'ex', 'none']
    rng.shuffle(kinds_cycle)
    slips = []
    ki = 0
    for b in D['brand_order']:
        stores = [s for s in D['stores'] if s['brand'] == b]
        used = rng.sample(D['vendors'][b], 3 if len(D['vendors'][b]) >= 6 else 2)
        for v in used:
            v['kind'] = kinds_cycle[ki % 3]
            ki += 1
            v['items'] = rng.sample(D['items'][b], min(len(D['items'][b]), rng.randint(3, 5)))
            for it in v['items']:
                v['raw_style'][it['name']] = it['name'] + rng.choice(['', '', '(大)', ' 特級', 'A'])
        fresh_names = rng.sample(FRESH_POOL, 2)
        for fn in fresh_names:
            pass
        D.setdefault('fresh', {})[b] = [{'name': n, 'unit': rng.choice(UNITS_C), 'price': rng.choice([300, 480, 600, 960]),
                                         'cat': rng.choice(CATS4), 'base': rng.choice(UNITS_B), 'factor': rng.choice([5, 10, 12, 20]),
                                         'change_base': rng.random() < 0.6, 'do_conv': rng.random() < 0.75} for n in fresh_names]
        nslips = 0
        for v in used:
            k = rng.randint(2, 4)
            for j in range(k):
                slips.append({'brand': b, 'vendor': v, 'wave': 1 if j == 0 else 2, 'store': rng.choice(stores)})
                nslips += 1
        while sum(1 for s in slips if s['brand'] == b) < 5:
            slips.append({'brand': b, 'vendor': used[0], 'wave': 2, 'store': rng.choice(stores)})
    rng.shuffle(slips)
    # UI 門市：第一個品牌的第一家門市，至少 4 張
    ui_store = [s for s in D['stores'] if s['brand'] == D['brand_order'][0]][0]
    ui_slips = [s for s in slips if s['brand'] == ui_store['brand']]
    w1 = [s for s in ui_slips if s['wave'] == 1]
    w2 = [s for s in ui_slips if s['wave'] == 2]
    pick = [w1[0], w2[0], w2[1]]
    rest = [s for s in ui_slips if s not in pick]
    pick.append(rest[0])
    for s in pick:
        s['store'] = ui_store
    D['ui_store'] = ui_store
    # 日期（月份輪流）、單價走勢
    mcycle = list(months) * 20
    rng.shuffle(mcycle)
    for i, s in enumerate(slips):
        s['idx'] = i
        s['doc_date'] = rng.choice(by_month[mcycle[i]])
    # 依日期排序走價格
    price_state = {}
    for s in sorted(slips, key=lambda x: x['doc_date']):
        b, v = s['brand'], s['vendor']
        lines = []
        for it in rng.sample(v['items'], rng.randint(2, min(4, len(v['items'])))):
            key = (b, it['name'])
            cur = price_state.get(key, it['price'])
            r = rng.random()
            if r < 0.35:
                cur = cur * rng.choice([1.1, 1.2, 1.35])
            elif r < 0.7:
                cur = cur * rng.choice([0.9, 0.8, 0.7])
            cur = max(5, round(cur, 1))
            price_state[key] = cur
            unit = rng.choice([it['base']] + list(it['conv']))
            f = 1 if unit == it['base'] else it['conv'][unit]
            price = Decimal(str(round(cur * f, 1)))
            qty = Decimal(str(rng.choice([1, 2, 3, 4, 5, 6, 8, 10, 12, 0.5, 1.5, 2.5])))
            raw = v['raw_style'][it['name']]
            lines.append({'kind': 'master', 'item': it['name'], 'raw': raw, 'qty': qty, 'unit': unit, 'price': price, 'extra': None})
        s['lines'] = lines
    for s in slips:                          # 雜項行
        b = s['brand']
        if rng.random() < 0.25:
            fr = rng.choice(D['fresh'][b])
            s['lines'].append({'kind': 'fresh', 'fresh': fr, 'item': fr['name'], 'raw': fr['name'], 'qty': Decimal(str(rng.choice([1, 2, 3]))),
                               'unit': fr['unit'], 'price': Decimal(fr['price']), 'extra': None})
        if rng.random() < 0.2:
            s['lines'].append({'kind': 'fee', 'item': None, 'raw': '運費', 'qty': Decimal(1), 'unit': '趟',
                               'price': Decimal(rng.choice([100, 150, 200, 300])), 'extra': None})
    # 保證每品牌至少有一個 fresh 行（測自動建檔／待補分類）；第一個 fresh 品項在 wave1 才有意義
    for b in D['brand_order']:
        bs = [s for s in slips if s['brand'] == b]
        if not any(l['kind'] == 'fresh' for s in bs for l in s['lines']):
            s = rng.choice(bs)
            fr = D['fresh'][b][0]
            s['lines'].append({'kind': 'fresh', 'fresh': fr, 'item': fr['name'], 'raw': fr['name'], 'qty': Decimal(2), 'unit': fr['unit'],
                               'price': Decimal(fr['price']), 'extra': None})
    # 一張全形空白品名：raw 與某統一品名 name_key 相同（自動對到，不新建）
    cand = [s for s in slips if s['wave'] == 1]
    s = rng.choice(cand)
    l = [x for x in s['lines'] if x['kind'] == 'master' and len(x['item']) >= 2][0] if any(x['kind'] == 'master' and len(x['item']) >= 2 for x in s['lines']) else None
    if l:
        l['raw'] = l['item'][0] + '　' + l['item'][1:] + '　'
        l['raw'] = l['raw'].strip() if False else l['raw']
        l['mode'] = 'autofw'
    # 稅額、金額
    for s in slips:
        v = s['vendor']
        for l in s['lines']:
            l['amount'] = l['qty'] * l['price']
        S = sum(l['amount'] for l in s['lines'])
        s['sum'] = S
        kind = v['kind']
        s['tax_kind'] = kind
        if kind == 'none':
            s['truth'] = {'subtotal': None, 'tax': None, 'total': S, 'inc': 0}
        elif kind == 'ex':
            tax = Decimal(jsround(float(S) * 0.05))
            s['truth'] = {'subtotal': S, 'tax': tax, 'total': S + tax, 'inc': 0}
        else:
            sub = Decimal(jsround(float(S) / 1.05))
            s['truth'] = {'subtotal': sub, 'tax': S - sub, 'total': S, 'inc': 1}
        s['doc_no'] = 'AB' + str(rng.randint(10000, 99999))
        s['photos'] = rng.choice([1, 1, 2, 3])
        s['ui'] = s['store'] is ui_store
        s['dims'] = (420 + s['idx'], 600)
        s['inj'] = {}
        s['vendor_typed'] = None
    return slips


def plan_injections(rng, D, slips):
    """每種錯誤至少出現一次（分散在不同貨單）。"""
    w1 = [s for s in slips if s['wave'] == 1]
    w2 = [s for s in slips if s['wave'] == 2]
    ui2 = [s for s in w2 if s['ui']]
    pool = list(slips)
    rng.shuffle(pool)

    def take(lst, pred=lambda s: True):
        c = [s for s in lst if pred(s)]
        return rng.choice(c) if c else None

    # 未知廠商（店員手打）：wave1、非 inc 以免與含稅記憶情境糾纏
    s = take(w1, lambda s: s['tax_kind'] != 'inc' and not s['ui'])
    if s:
        nm = ''.join(rng.choice(UNKNOWN_CHARS) for _ in range(3)) + '商行'
        s['vendor_typed'] = nm
        s['inj']['unknown_vendor'] = nm
    zero = take(pool, lambda s: any(l['kind'] == 'master' for l in s['lines']))
    l = [l for l in zero['lines'] if l['kind'] == 'master'][0]
    l['qty'] = Decimal(10)
    l['price'] = Decimal(int(l['price'] // 10 * 10) or 10)
    l['amount'] = l['qty'] * l['price']
    zero['inj']['zero'] = zero['lines'].index(l)

    def recompute(s):
        S = sum(l['amount'] for l in s['lines'])
        s['sum'] = S
        k = s['tax_kind']
        if k == 'none':
            s['truth'] = {'subtotal': None, 'tax': None, 'total': S, 'inc': 0}
        elif k == 'ex':
            tax = Decimal(jsround(float(S) * 0.05))
            s['truth'] = {'subtotal': S, 'tax': tax, 'total': S + tax, 'inc': 0}
        else:
            sub = Decimal(jsround(float(S) / 1.05))
            s['truth'] = {'subtotal': sub, 'tax': S - sub, 'total': S, 'inc': 1}
    recompute(zero)
    for key in ['mismatch', 'price_missing']:
        s = take(pool, lambda s: 'zero' not in s['inj'] and key not in s['inj'] and len(s['lines']) >= 2)
        if s:
            s['inj'][key] = rng.randrange(len(s['lines']))
    for key, val in [('date', 'roc'), ('date', 'twodigit'), ('date', 'blank'), ('date', 'faryear')]:
        s = take(pool, lambda s: 'date' not in s['inj'])
        if s:
            s['inj']['date'] = val
    s = take(pool, lambda s: 'hand' not in s['inj'])
    s['inj']['hand'] = 'keep'
    s = take(pool, lambda s: 'hand' not in s['inj'])
    s['inj']['hand'] = 'clear'
    s = take(pool, lambda s: 'extra' not in s['inj'])
    s['inj']['extra'] = True
    s = take(pool, lambda s: 'drop' not in s['inj'] and len(s['lines']) >= 3 and 'zero' not in s['inj'] and 'mismatch' not in s['inj'])
    if s:
        s['inj']['drop'] = rng.randrange(len(s['lines']))
    s = take(pool, lambda s: 'bad_total' not in s['inj'] and 'drop' not in s['inj'])
    s['inj']['bad_total'] = True
    s = take(pool, lambda s: 'comma' not in s['inj'] and s['sum'] >= 1000)
    if s:
        s['inj']['comma'] = True
    # 失敗：wave2 兩張（一張從清單鈕、一張從詳情鈕重新辨識）
    f = [s for s in w2 if not s['ui']][:0]
    cands = [s for s in w2 if not s['ui']]
    rng.shuffle(cands)
    for k, s in enumerate(cands[:2]):
        s['inj']['fail'] = 'list' if k == 0 else 'detail'
    # 退回：UI 門市的 wave2 一張
    if ui2:
        s = rng.choice(ui2)
        s['inj']['return'] = rng.choice(['照片太糊，請重拍', '少拍了一頁，請補拍'])
    # 取消入帳再入帳：任一張（非失敗）
    s = take(pool, lambda s: 'fail' not in s['inj'])
    s['inj']['unconfirm'] = True
    return slips


def plan_modes(rng, D, slips):
    """依處理順序模擬廠商記憶，決定每列要怎麼對照品名（memory／pick／pick_kb／suggest／autofw／inline／auto／none）。"""
    memory = {}
    order = sorted(slips, key=lambda s: (s['wave'], s['idx']))
    n_inline = {b: 0 for b in D['brand_order']}
    for s in order:
        for l in s['lines']:
            key = (s['brand'], s['vendor']['name'] if not s['vendor_typed'] else s['vendor_typed'], norm_text(l['raw'], 200))
            if l['kind'] == 'fee':
                l['mode'] = 'none'
                continue
            if key in memory and s['wave'] == 2:
                l['mode'] = 'memory'
                continue
            if l['kind'] == 'fresh':
                fr = l['fresh']
                if 'inline_done' not in fr and n_inline[s['brand']] < 1 and s['wave'] == 1:
                    l['mode'] = 'inline'
                    fr['inline_done'] = True
                    n_inline[s['brand']] += 1
                else:
                    l['mode'] = 'auto'
                memory[key] = l['item']
                continue
            if l.get('mode') == 'autofw':
                memory[key] = l['item']
                continue
            l['mode'] = rng.choice(['pick', 'pick_kb', 'suggest', 'suggest'])
            memory[key] = l['item']
    D['memory_plan'] = memory


# ───────────── AI 辨識輸出（含注入）─────────────
def fnum(d, comma=False):
    d = Decimal(d)
    s = format(d.normalize(), 'f')
    if comma and abs(d) >= 1000:
        ip, _, fp = s.partition('.')
        s = f'{int(ip):,}' + ('.' + fp if fp else '')
    return s


def build_ai(rng, D, s):
    inj = s['inj']
    shot = D['today']
    t = s['truth']
    lines = []
    ai_map = []
    for i, l in enumerate(s['lines']):
        if inj.get('drop') == i:
            ai_map.append(('dropped', i))
            continue
        amt = l['amount']
        price = l['price']
        a_str = fnum(amt, inj.get('comma', False))
        if inj.get('zero') == i:
            a_str = fnum(int(amt) // 10)
        if inj.get('mismatch') == i:
            for delta in (Decimal(37), Decimal(53), Decimal(11), -Decimal(23)):
                cand = amt + delta
                calc = float(l['qty'] * l['price'])
                if cand > 0 and not (calc > float(cand) and float(cand).is_integer() and str(jsround(calc)).startswith(str(int(cand)))):
                    a_str = fnum(cand)
                    break
        p_str = fnum(price)
        if inj.get('price_missing') == i:
            p_str = ''
        lines.append({'name': l['raw'], 'qty': fnum(l['qty']), 'unit': l['unit'], 'unit_price': p_str, 'amount': a_str})
        ai_map.append(('line', i))
    if inj.get('extra'):
        lines.append({'name': '合計', 'qty': '', 'unit': '', 'unit_price': '', 'amount': fnum(s['sum'])})
        ai_map.append(('extra', None))
        if t['tax'] is not None:
            lines.append({'name': '營業稅', 'qty': '', 'unit': '', 'unit_price': '', 'amount': fnum(t['tax'])})
            ai_map.append(('extra', None))
    d = s['doc_date']
    dk = inj.get('date')
    if dk == 'roc':
        date_str = rng.choice([f'{d.year - 1911}/{d.month:02d}/{d.day:02d}', f'{d.year - 1911}年{d.month}月{d.day}日', f'{d.year - 1911}.{d.month:02d}.{d.day:02d}'])
    elif dk == 'twodigit':
        date_str = f'{str(d.year)[2:]}/{d.month:02d}/{d.day:02d}'
    elif dk == 'blank':
        date_str = ''
    elif dk == 'faryear':
        date_str = f'{d.year - 1}-{d.month:02d}-{d.day:02d}'
    else:
        date_str = d.isoformat()
    total = t['total']
    hand = ''
    if inj.get('hand'):
        hand = f'總額手寫修改為 {fnum(total)}'
    total_str = fnum(total)
    if inj.get('bad_total'):
        total_str = fnum(total + Decimal(rng.choice([10, 20, 50, 100])))
    if inj.get('drop') is not None and False:
        pass
    ai = {'vendor': s['vendor_typed'] or s['vendor']['name'], 'date': date_str, 'doc_no': s['doc_no'], 'lines': lines,
          'subtotal': '' if t['subtotal'] is None else fnum(t['subtotal']),
          'tax': '' if t['tax'] is None else fnum(t['tax']), 'total': total_str, 'handwritten_changes': hand}
    return ai, ai_map


# ───────────── 辨識後處理（規格重寫）→ 預期畫面 ─────────────
def expected_recognition(ai, shot, ctx):
    """ctx: resolve(raw)->item dict|None（廠商記憶）、tax_included(0/1)。回傳預期的貨單狀態。"""
    flags = set()
    # 日期
    dstr = ai['date']
    m = re.search(r'(\d{1,4})\s*[^\d\s]\s*(\d{1,2})\s*[^\d\s]\s*(\d{1,2})', unicodedata.normalize('NFKC', dstr))
    note = None
    if not m:
        doc_date = shot
        flags.add('DATE_FIXED')
        note = '日期讀不出，暫用拍照日'
    else:
        y = int(m.group(1))
        if len(m.group(1)) < 3:
            doc_date = shot
            flags.add('DATE_FIXED')
            note = '年份只有兩位數，暫用拍照日'
        else:
            if y < 1000:
                y += 1911
            dd = date(y, int(m.group(2)), int(m.group(3)))
            if abs((dd - shot).days) <= 60:
                doc_date = dd
            else:
                best = None
                for yy in (shot.year, shot.year - 1):
                    try:
                        c = date(yy, dd.month, dd.day)
                    except ValueError:
                        continue
                    diff = (c - shot).days
                    if diff > 7:
                        continue
                    if best is None or abs(diff) < best[1]:
                        best = (c, abs(diff))
                doc_date = best[0]
                flags.add('DATE_FIXED')
                note = '年份離拍照日太遠，已改用拍照日附近的年份'
    hand = norm_text(ai['handwritten_changes'])
    if hand.lower() in NO_HAND:
        hand = ''
    if hand:
        flags.add('HANDWRITTEN')
    lines = []
    for x in ai['lines']:
        q, p, a = (pos(parse_num(x[k])) for k in ('qty', 'unit_price', 'amount'))
        lf = set()
        if q is not None and p is not None:
            calc = r2(q * p)
            if a is None:
                a = calc
            elif (not money_eq(q * p, a)) and a > 0 and calc > a and float(a).is_integer() and str(jsround(calc)).startswith(str(int(a))):
                a = calc
                lf.add('AMOUNT_FIXED')
        raw = norm_text(x['name'], 200)
        unit = norm_text(x['unit'], 20)
        lines.append({'raw': raw, 'qty': q, 'unit': unit, 'price': p, 'amount': a, 'flags': lf})
    sub, tax, tot = (pos(parse_num(ai[k])) for k in ('subtotal', 'tax', 'total'))
    inc = ctx['tax_included']
    for l in lines:
        f = l['flags']
        if l['price'] is None:
            f.add('PRICE_MISSING')
        elif l['qty'] is not None and l['amount'] is not None and not money_eq(l['qty'] * l['price'], l['amount']):
            f.add('AMOUNT_MISMATCH')
        it = ctx['resolve'](l['raw'])
        l['item'] = it['name'] if it else None
        if not it:
            f.add('ITEM_UNMAPPED')
        elif not l['unit'] or (l['unit'] != it['base'] and l['unit'] not in it['conv']):
            f.add('UNIT_UNCONVERTED')
    _, ok, _ = sum_check([l['amount'] for l in lines], sub, tax, tot, inc)
    if lines and not ok:
        flags.add('SUM_MISMATCH')
    return {'doc_date': doc_date, 'note': note, 'flags': flags, 'lines': lines, 'subtotal': sub, 'tax': tax, 'total': tot,
            'inc': inc, 'hand': hand, 'doc_no': norm_text(ai['doc_no'])}


def line_view(l):
    """核對頁前端對單列的顯示判斷：(class, 說明文字集合)。l: qty/price/amount/raw/item/flags(後端)"""
    f = {c for c in l['flags'] if c not in RED and c != 'ITEM_UNMAPPED'}
    if not l['item'] and (l['raw'] or '').strip():
        f.add('ITEM_UNMAPPED')
    if l['price'] is None:
        f.add('PRICE_MISSING')
    elif l['qty'] is not None and l['amount'] is not None and not money_eq(l['qty'] * l['price'], l['amount']):
        f.add('AMOUNT_MISMATCH')
    bad = any(l[k] is None or l[k] <= 0 for k in ('qty', 'price', 'amount'))
    hasr = bad or any(c in RED for c in f)
    cls = 'red' if hasr else ('yellow' if f else '')
    return cls, {FLAG_TEXT[c] for c in f}, bad


# ───────────── 模型：已入帳資料與報表（獨立算式）─────────────
class Model:
    def __init__(self, D):
        self.D = D
        self.items = {b: {} for b in BRANDS}      # brand -> name -> {cat, base, conv, active, auto}
        self.vendors = {b: {} for b in BRANDS}    # brand -> name -> {active, inc, auto}
        self.alias = {}                           # (brand, vendor, raw) -> item name
        self.slips = {}                           # sid -> state
        self.seq = 0
        self.alerts = []                          # dict(sid, seq, line_i, ...)
        self.pnlmap = {}                          # (brand, vendor, cat) -> acc
        self.stores = {s['code']: s for s in D['stores']}
        self.stores_by_name = {s['name']: s for s in D['stores']}

    # 主檔
    def add_item(self, b, name, cat, base, conv=None, auto=False):
        self.items[b][name] = {'name': name, 'cat': cat, 'base': base, 'conv': dict(conv or {}), 'active': True, 'auto': auto}

    def find_item(self, b, name):
        k = name_key(name)
        for it in sorted(self.items[b].values(), key=lambda x: not x['active']):
            if name_key(it['name']) == k:
                return it
        return None

    def find_vendor(self, b, name):
        k = name_key(name)
        for v in self.vendors[b].values():
            if name_key(v['name']) == k:
                return v
        return None

    def resolve(self, b, vendor, raw):
        nm = self.alias.get((b, vendor, norm_text(raw, 200)))
        it = self.items[b].get(nm) if nm else None
        return it if it and it['active'] else None

    # 貨單
    def register(self, sid, s, state):
        self.slips[sid] = state

    def factor(self, it, unit):
        if not unit:
            return None
        if unit == it['base']:
            return 1
        f = it['conv'].get(unit)
        return f if f and f > 0 else None

    def line_calc(self, st, ln):
        """已入帳列的 base_qty / unit_cost / net；未對品名或未換算 → converted False。"""
        it = self.items[st['brand']].get(ln['item']) if ln['item'] else None
        f = self.factor(it, ln['unit']) if it else None
        ok = f is not None and ln['qty'] > 0 and ln['amount'] is not None
        ratio = 1
        if st['inc'] and st['tax'] is not None and st['total'] > 0 and 0 <= st['tax'] < st['total']:
            ratio = (st['total'] - st['tax']) / st['total']
        net = ln['amount'] * ratio
        base = jsround(ln['qty'] * f * 10000) / 10000 if ok else None
        return {'ok': ok, 'base': base, 'net': net, 'cost': r2(net / base) if ok else None, 'item': it}

    def confirm(self, sid):
        st = self.slips[sid]
        b = st['brand']
        if st['vendor'] is None and ok_auto_vendor(st['vendor_raw']):
            v = self.find_vendor(b, st['vendor_raw'])
            if not v:
                nm = norm_text(st['vendor_raw'])
                v = {'name': nm, 'active': True, 'inc': 0, 'auto': True}
                self.vendors[b][nm] = v
            st['vendor'] = v['name']
        for ln in st['lines']:
            rn = norm_text(ln['raw'])
            if ln['item'] or not ok_auto_item(rn):
                continue
            it = self.find_item(b, rn)
            if not it:
                self.add_item(b, rn, None, norm_text(ln['unit'], 20) or None, auto=True)
                it = self.items[b][rn]
            ln['item'] = it['name']
        self.seq += 1
        st['status'] = 'confirmed'
        st['seq'] = self.seq
        if st['vendor']:
            self.vendors[b][st['vendor']]['inc'] = 1 if st['inc'] else 0
            for ln in st['lines']:
                rn = norm_text(ln['raw'], 200)
                if ln['item'] and rn:
                    self.alias[(b, st['vendor'], rn)] = ln['item']
        self.gen_alerts(sid)

    def key(self, st, i):
        return (st['doc_date'], st['seq'], st['sid'], i)

    def gen_alerts(self, sid):
        st = self.slips[sid]
        b = st['brand']
        for i, ln in enumerate(st['lines']):
            c = self.line_calc(st, ln)
            if not c['ok']:
                continue
            prevs = []
            for sid2, st2 in self.slips.items():
                if st2['status'] != 'confirmed' or st2['brand'] != b or sid2 == sid:
                    continue
                for j, l2 in enumerate(st2['lines']):
                    if l2['item'] != ln['item']:
                        continue
                    c2 = self.line_calc(st2, l2)
                    if c2['ok'] and self.key(st2, j) < self.key(st, i):
                        prevs.append((self.key(st2, j), c2['cost']))
            if not prevs:
                continue
            prev = max(prevs)[1]
            if not prev > 0 or abs(cents(c['cost']) - cents(prev)) < 1:
                continue
            pct = jsround(((c['cost'] - prev) / prev) * 1000) / 10
            self.alerts.append({'sid': sid, 'seq': st['seq'], 'i': i, 'item': ln['item'], 'vendor': st['vendor'] or st['vendor_raw'], 'store': st['store_name'],
                                'prev': prev, 'new': c['cost'], 'pct': pct, 'dir': 'up' if c['cost'] > prev else 'down', 'doc_date': st['doc_date']})

    def unconfirm(self, sid):
        st = self.slips[sid]
        st['status'] = 'review'
        self.alerts = [a for a in self.alerts if a['sid'] != sid]

    def confirmed(self, brand=None):
        return [(sid, st) for sid, st in self.slips.items() if st['status'] == 'confirmed' and (brand is None or st['brand'] == brand)]

    def ordered_lines(self, brand, frm=None, to=None, store=None, item=None):
        out = []
        for sid, st in self.confirmed(brand):
            if frm and st['doc_date'] < frm or to and st['doc_date'] > to or store and st['store_code'] != store:
                continue
            for i, ln in enumerate(st['lines']):
                if item and ln['item'] != item:
                    continue
                out.append((self.key(st, i), sid, st, i, ln))
        out.sort(key=lambda x: x[0])
        return out

    # 稅額分攤 → 每張各類別（分）
    def slip_cats(self, st):
        cat = {c: 0 for c in COST_CATS}
        for ln in st['lines']:
            it = self.items[st['brand']].get(ln['item']) if ln['item'] else None
            c = it['cat'] if it and it['cat'] in CATS4 else '未分類'
            cat[c] += cents(ln['amount'])
        if st['inc'] or not st['tax']:
            return cat
        tx = cents(st['tax'])
        pos_cats = [c for c in COST_CATS if cat[c] > 0]
        s = sum(cat[c] for c in pos_cats)
        if not pos_cats or s <= 0:
            cat['未分類'] += tx
            return cat
        used = 0
        for k, c in enumerate(pos_cats):
            share = tx - used if k == len(pos_cats) - 1 else jsround(tx * cat[c] / s)
            used += share
            cat[c] += share
        return cat

    def vname(self, st):
        return st['vendor'] or st['vendor_raw'] or '（未指定廠商）'

    def cost(self, brand, month, store=None):
        frm, to = month_range(month)
        cat = {c: 0 for c in COST_CATS}
        vend, stor = {}, {}
        for sid, st in self.confirmed(brand):
            if not (frm <= st['doc_date'] <= to) or (store and st['store_code'] != store):
                continue
            c = self.slip_cats(st)
            for k in COST_CATS:
                cat[k] += c[k]
            tot = sum(c.values())
            vend[self.vname(st)] = vend.get(self.vname(st), 0) + tot
            stor[st['store_name']] = stor.get(st['store_name'], 0) + tot
        return {'total': sum(cat.values()), 'cat': cat, 'vendor': vend, 'store': stor}

    def price(self, brand, item, month, months=6):
        frm = month_shift(month, months - 1)[0]
        _, to = month_range(month)
        pts = []
        for key, sid, st, i, ln in self.ordered_lines(brand, frm, to, item=item):
            c = self.line_calc(st, ln)
            if c['ok']:
                pts.append({'date': st['doc_date'], 'vendor': self.vname(st), 'cost': c['cost'], 'sid': sid})
        return pts, self.avg(brand, item, month, 1), self.avg(brand, item, month, 3)

    def avg(self, brand, item, month, months):
        frm = month_shift(month, months - 1)[0]
        _, to = month_range(month)
        amt, qty = 0, 0
        for key, sid, st, i, ln in self.ordered_lines(brand, frm, to, item=item):
            c = self.line_calc(st, ln)
            if c['ok']:
                amt += cents(c['net'])
                qty += c['base']
        return r2(amt / 100 / qty) if qty > 0 else None

    def daily(self, brand, frm, to, store=None):
        rows = []
        for key, sid, st, i, ln in self.ordered_lines(brand, frm, to, store):
            c = self.line_calc(st, ln)
            rows.append((st['doc_date'], st['store_name'], self.vname(st), ln['item'] or '', ln['raw'], ln['qty'], ln['unit'], ln['price'], ln['amount'],
                         c['base'], c['cost']))
        return rows

    def legacy(self, brand, month, store=None):
        frm, to = month_range(month)
        cells, vendors = {}, set()
        for sid, st in self.confirmed(brand):
            if not (frm <= st['doc_date'] <= to) or (store and st['store_code'] != store):
                continue
            tot = sum(self.slip_cats(st).values())
            k = (int(st['doc_date'][8:10]), self.vname(st))
            cells[k] = cells.get(k, 0) + tot
            vendors.add(self.vname(st))
        return sorted(vendors), cells

    def alerts_for(self, brand, month):
        frm, to = month_range(month)
        al = [a for a in self.alerts if self.slips[a['sid']]['brand'] == brand and frm <= a['doc_date'] <= to]
        al.sort(key=lambda a: (a['seq'], a['i']), reverse=True)
        return al

    # 損益推送
    def acc_of(self, b, vendor, cat):
        if cat == '未分類' or not vendor:
            return None
        return self.pnlmap.get((b, vendor, cat))

    def pnl_month(self, store_code, month):
        st0 = self.stores[store_code]
        frm, to = month_range(month)
        ent, unm = {}, 0
        for sid, st in self.confirmed(st0['brand']):
            if st['store_code'] != store_code or not (frm <= st['doc_date'] <= to):
                continue
            c = self.slip_cats(st)
            for k in COST_CATS:
                if not c[k]:
                    continue
                a = self.acc_of(st['brand'], st['vendor'], k)
                if a:
                    ent[a] = ent.get(a, 0) + c[k]
                else:
                    unm += c[k]
        return ent, unm

    def unmapped_rows(self):
        rows = {}
        for sid, st in self.slips.items():
            if st['status'] != 'confirmed':
                continue
            s0 = self.stores[st['store_code']]
            if not s0['unit_code']:
                continue
            c = self.slip_cats(st)
            for k in COST_CATS:
                if not c[k] or self.acc_of(st['brand'], st['vendor'], k):
                    continue
                key = (s0['name'], st['doc_date'][:7], self.vname(st), k)
                rows[key] = rows.get(key, 0) + c[k]
        return rows


def month_range(month):
    y, m = int(month[:4]), int(month[5:7])
    last = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return f'{y}-{m:02d}-01', f'{y}-{m:02d}-{last:02d}'


def month_shift(month, back):
    y, m = int(month[:4]), int(month[5:7])
    idx = y * 12 + (m - 1) - back
    return f'{idx // 12}-{idx % 12 + 1:02d}-01', None
