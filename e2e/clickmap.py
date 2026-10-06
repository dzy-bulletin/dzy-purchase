# -*- coding: utf-8 -*-
"""按鈕與連結的覆蓋稽核。

Eason 2026-09-03：「要測試全部每一個按鍵或連結是否可以正確且正常導入到目的地」。
所以不能只挑幾顆點——每進到一個畫面就把當下的可點元素全部登記，點過的登記為已測，
最後把「登記過但沒被點過」的印出來，漏一顆就報失敗。

key 的規則（KEY_JS 與 SCAN_JS 共用同一段邏輯，不可分岔，否則會誤報漏測）：
  有 id → #id；有 data-r → a[data-r=名字]；
  下拉與輸入 → tag+class（選項文字會隨登入者而變，拿來當識別會每個人都不同）；
  其他 → tag「前 24 字」。
"""

_KEY_LOGIC = """
  const id = e.id ? '#' + e.id : '';
  const dr = e.dataset && e.dataset.r ? ('a[data-r=' + e.dataset.r + ']') : '';
  if (id) return id;
  if (dr) return dr;
  // 本系統補充：側欄連結文字含會變動的筆數 → 用 data-page#data-key；建議鈕文字隨品名變 → 固定 key；
  // 同 class 的輸入用 data-k／data-bk／data-p 區分，避免所有勾選框共用一個 key
  if (e.dataset && e.dataset.page) return 'nav[' + e.dataset.page + '#' + e.dataset.key + ']';
  if (e.closest && e.closest('.sug')) return 'button.sug';
  if (e.classList && e.classList.contains('sthumb')) return 'button.sthumb';   // 我的上傳縮圖：張數文字會變
  if (e.dataset && e.dataset.p !== undefined && e.tagName === 'BUTTON') return 'button.photo';
  const cls = (typeof e.className === 'string' && e.className.trim())
    ? '.' + e.className.trim().split(/\\s+/)[0] : '';
  if (e.tagName === 'SELECT' || e.tagName === 'INPUT') {
    const kk = e.dataset && (e.dataset.k || e.dataset.bk) ? '[' + (e.dataset.k || e.dataset.bk) + ']' : '';
    return e.tagName.toLowerCase() + cls + kk;
  }
  const txt = (e.textContent || e.value || '').trim().replace(/\\s+/g, ' ').slice(0, 24);
  return e.tagName.toLowerCase() + '「' + txt + '」';
"""

KEY_JS = """
(sel) => {
  const e = document.querySelector(sel);
  if (!e) return null;
  const keyOf = (e) => {%s};
  return keyOf(e);
}
""" % _KEY_LOGIC

SCAN_JS = """
() => {
  const keyOf = (e) => {%s};
  const sel = 'button, a[href], a[data-r], summary, input[type=checkbox], select';
  return [...document.querySelectorAll(sel)]
    .filter(e => e.offsetParent !== null || e.tagName === 'SUMMARY')
    .map(keyOf);
}
""" % _KEY_LOGIC

# 刻意不點、附理由（會列在報告裡，不算漏測）
SKIP = {
}


class ClickMap:
    def __init__(self):
        self.seen = {}      # key -> 第一次看到它的畫面
        self.clicked = {}   # key -> 驗證了什麼

    def scan(self, page, screen):
        for k in page.evaluate(SCAN_JS):
            if k:
                self.seen.setdefault(k, screen)

    def mark(self, key, verified):
        if key:
            self.clicked[key] = verified

    def report(self):
        missed = {k: v for k, v in self.seen.items() if k not in self.clicked and k not in SKIP}
        # clicked 裡有、seen 裡沒有的 → 代表 key 算法不一致（誤報漏測的根源）
        extra = {k: v for k, v in self.clicked.items() if k not in self.seen}
        return {
            'total': len(self.seen),
            'clicked': len(self.clicked),
            'skipped': {k: SKIP[k] for k in self.seen if k in SKIP},
            'missed': missed,
            'extra': extra,
        }
