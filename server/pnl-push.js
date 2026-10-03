'use strict';
// T17：損益推送（Mac mini 端）。plan.md「P3 共用契約」：
//  - 觸發（入帳、取消入帳、對照表變更、門市損益代號變更）→ 寫 pnl_outbox（同店同月合併一筆）
//  - 每 60 秒處理 outbox：組「該店該月完整最新合計」送 purchasePush；成功刪 outbox 並記 jobs_log；失敗保留、指數退避（上限 30 分鐘）
//  - entries 必須是該店該月「所有曾推過的科目」的完整合計：某科目變 0 也要送 0（pnl_pushed 記著曾推過哪些）
//  - 金額一律以「分」累加、輸出元；稅額分攤規則照 P2（calc.slipCosts）
//  - PNL_PUSH_URL／PNL_PURCHASE_KEY 沒設 → 不推（outbox 保留），/health 顯示「損益推送未設定」（黃）
const calc = require('./calc');
const { jobLog } = require('./db');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (d) => String(d || '').slice(0, 7);
const BACKOFF_CAP_MS = 30 * 60e3;
const backoffMs = (attempts) => Math.min(BACKOFF_CAP_MS, 60e3 * Math.pow(2, Math.max(0, attempts - 1)));   // 1、2、4、8、16 分，之後 30 分

// ---------- outbox 寫入（可在呼叫端的交易內執行）----------
function markDirty(db, storeId, docDate, at) {
  const month = MONTH_RE.test(String(docDate)) ? String(docDate) : monthOf(docDate);
  if (!storeId || !MONTH_RE.test(month)) return false;
  db.prepare(`INSERT INTO pnl_outbox (store_id, month, dirty_at, ver) VALUES (?,?,?,1)
    ON CONFLICT(store_id, month) DO UPDATE SET ver = ver + 1, dirty_at = excluded.dirty_at, next_at = NULL`).run(storeId, month, at || new Date().toISOString());
  return true;
}
// 該店所有有已入帳貨單的月份（門市損益代號變更時用）
function markAllForStore(db, storeId, at) {
  let n = 0;
  for (const r of db.prepare("SELECT DISTINCT substr(doc_date,1,7) m FROM slips WHERE store_id = ? AND status = 'confirmed' AND doc_date IS NOT NULL").all(storeId)) if (markDirty(db, storeId, r.m, at)) n++;
  return n;
}
// 某廠商某類別的對照變更 → 受影響的店×月
function markForVendorCategory(db, vendorId, category, at) {
  let n = 0;
  for (const r of db.prepare(`SELECT DISTINCT s.store_id, substr(s.doc_date,1,7) m FROM slips s JOIN slip_lines l ON l.slip_id = s.id JOIN items i ON i.id = l.item_id
    WHERE s.status = 'confirmed' AND s.vendor_id = ? AND i.category = ? AND s.doc_date IS NOT NULL`).all(vendorId, category)) if (markDirty(db, r.store_id, r.m, at)) n++;
  return n;
}
// 品項類別變更 → 含該品項已入帳列的店×月
function markForItem(db, itemId, at) {
  let n = 0;
  for (const r of db.prepare(`SELECT DISTINCT s.store_id, substr(s.doc_date,1,7) m FROM slips s JOIN slip_lines l ON l.slip_id = s.id
    WHERE s.status = 'confirmed' AND l.item_id = ? AND s.doc_date IS NOT NULL`).all(itemId)) if (markDirty(db, r.store_id, r.m, at)) n++;
  return n;
}

// ---------- 計算 ----------
function loadMap(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT vendor_id, category, acc_id FROM pnl_map').all()) m.set(`${r.vendor_id}|${r.category}`, r.acc_id);
  return m;
}
const accOf = (map, vendorId, category) => (category === '未分類' || !vendorId ? null : map.get(`${vendorId}|${category}`) || null);

// 該店該月：{ entries:{acc_id: 分}, unmapped: 分 }（只含已入帳；未分類／查不到對照的不推，歸 unmapped）
function computeMonth(db, storeId, month) {
  const p = calc.periodOf(month, 1);
  const map = loadMap(db);
  const entries = {}; let unmapped = 0;
  for (const s of calc.slipCosts(db, { storeId, from: p.from, to: p.to })) {
    for (const c of calc.COST_CATS) {
      const v = s.cats[c]; if (!v) continue;
      const acc = accOf(map, s.vendor_id, c);
      if (acc) entries[acc] = (entries[acc] || 0) + v; else unmapped += v;
    }
  }
  return { entries, unmapped };
}

// 「待補對照」清單：已入帳但沒有對照的金額，依 店×月×廠商×類別（只看有設損益代號的門市——沒設的本來就不推）
function unmappedReport(db, opts) {
  opts = opts || {};
  const map = loadMap(db);
  const stores = new Map(db.prepare("SELECT id, code, name, brand_id FROM stores WHERE pnl_unit_code IS NOT NULL AND pnl_unit_code <> ''").all().map((s) => [s.id, s]));
  const vendors = new Map(db.prepare('SELECT id, name FROM vendors').all().map((v) => [v.id, v.name]));
  const acc = new Map(); let total = 0;
  for (const s of calc.slipCosts(db, { brandId: opts.brandId || undefined })) {
    const st = stores.get(s.store_id); if (!st) continue;
    for (const c of calc.COST_CATS) {
      const v = s.cats[c]; if (!v || accOf(map, s.vendor_id, c)) continue;
      const vendor = (s.vendor_id && vendors.get(s.vendor_id)) || s.vendor_name_raw || '（未指定廠商）';
      const key = [s.store_id, monthOf(s.doc_date), s.vendor_id || '', vendor, c].join('\t');
      acc.set(key, (acc.get(key) || 0) + v); total += v;
    }
  }
  const rows = [...acc.entries()].map(([k, v]) => {
    const [sid, month, vid, vendor, category] = k.split('\t'); const st = stores.get(Number(sid));
    return { store_id: Number(sid), store_code: st.code, store_name: st.name, month, vendor_id: vid ? Number(vid) : null, vendor, category, amount: calc.fromCents(v) };
  }).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.store_code < b.store_code ? -1 : a.store_code > b.store_code ? 1 : a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : a.category < b.category ? -1 : 1));
  return { rows, total: calc.fromCents(total) };
}

// ---------- 推送器 ----------
function createPnlPush(o) {
  const { db, cfg } = o;
  const now = o.now || (() => new Date());
  const doFetch = o.fetchImpl || ((...a) => fetch(...a));
  const log = o.log || (() => {});
  let timer = null, running = false;

  const configured = () => !!(cfg.PNL_PUSH_URL && cfg.PNL_PURCHASE_KEY);

  async function post(payload) {
    let text;
    try {
      const res = await doFetch(cfg.PNL_PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload),
        redirect: 'follow', signal: AbortSignal.timeout(cfg.PNL_TIMEOUT_MS || 60000) });
      text = await res.text();
    } catch (e) {
      const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      const err = new Error(t ? 'TIMEOUT' : 'NETWORK'); err.code = err.message; throw err;
    }
    let j; try { j = JSON.parse(text); } catch (e) { const err = new Error('NOT_JSON'); err.code = 'NOT_JSON'; throw err; }
    if (!j || j.ok !== true) { const c = String((j && (j.code || j.error)) || 'REJECTED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'REJECTED'; const err = new Error(c); err.code = c; throw err; }
    return j.data || {};
  }

  function fail(row, code) {
    const at = now(); const attempts = row.attempts + 1;
    db.prepare('UPDATE pnl_outbox SET attempts = ?, next_at = ?, first_fail_at = COALESCE(first_fail_at, ?), last_error = ? WHERE store_id = ? AND month = ?')
      .run(attempts, new Date(at.getTime() + backoffMs(attempts)).toISOString(), at.toISOString(), code, row.store_id, row.month);
    jobLog(db, 'pnl_push', false, `store=${row.store_id} month=${row.month} code=${code} attempts=${attempts}`);
    log(`pnl_push 失敗 ${row.store_id} ${row.month} ${code}（第 ${attempts} 次）`);
  }
  const drop = (row) => db.prepare('DELETE FROM pnl_outbox WHERE store_id = ? AND month = ? AND ver = ?').run(row.store_id, row.month, row.ver);

  async function pushOne(row) {
    const store = db.prepare('SELECT pnl_unit_code FROM stores WHERE id = ?').get(row.store_id);
    if (!store || !store.pnl_unit_code) { drop(row); jobLog(db, 'pnl_skip', true, `store=${row.store_id} month=${row.month} 門市沒設損益代號，略過`); return 'skipped'; }
    const calcd = computeMonth(db, row.store_id, row.month);
    const entries = {};
    for (const [a, c] of Object.entries(calcd.entries)) entries[a] = calc.fromCents(c);
    for (const r of db.prepare('SELECT acc_id FROM pnl_pushed WHERE store_id = ? AND month = ?').all(row.store_id, row.month)) if (!(r.acc_id in entries)) entries[r.acc_id] = 0;   // 曾推過、現在沒了 → 送 0
    if (!Object.keys(entries).length) { drop(row); jobLog(db, 'pnl_skip', true, `store=${row.store_id} month=${row.month} 沒有可推的科目（pending_unmapped=${calc.fromCents(calcd.unmapped)}），不送`); return 'empty'; }
    let data;
    try {
      data = await post({ action: 'purchasePush', key: cfg.PNL_PURCHASE_KEY, store_id: store.pnl_unit_code, month: row.month, entries, pending_unmapped: calc.fromCents(calcd.unmapped) });
    } catch (e) { fail(row, e.code || 'ERROR'); return 'failed'; }
    db.tx(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO pnl_pushed (store_id, month, acc_id) VALUES (?,?,?)');
      Object.keys(entries).forEach((a) => ins.run(row.store_id, row.month, a));
      drop(row);                                                       // ver 變了（送出期間又被改）→ 不刪，下一輪再推
    });
    const sk = Array.isArray(data.skipped_manual) ? data.skipped_manual.map((x) => String(x).slice(0, 30)).join(',') : '';
    jobLog(db, 'pnl_push', true, `store=${row.store_id} month=${row.month} accounts=${Object.keys(entries).length} skipped_manual=[${sk}] voided=${Number(data.voided) || 0}`);
    return 'ok';
  }

  // 處理到期的 outbox；回傳各結果筆數。force＝忽略退避時間（手動／測試）
  async function tick(opt) {
    if (running) return { busy: true };
    if (!configured()) return { configured: false };
    running = true;
    const out = { ok: 0, failed: 0, skipped: 0, empty: 0 };
    try {
      const t = now().toISOString();
      const rows = db.prepare('SELECT * FROM pnl_outbox WHERE (next_at IS NULL OR next_at <= ?) ORDER BY dirty_at, store_id, month LIMIT 50').all(opt && opt.force ? '9999' : t);
      for (const r of rows) { const k = await pushOne(r); out[k]++; }
    } catch (e) { jobLog(db, 'pnl_push', false, 'tick 例外 ' + String(e && e.message).slice(0, 200)); }
    finally { running = false; }
    return out;
  }
  function start() { if (timer) return; timer = setInterval(() => { tick(); }, cfg.PNL_TICK_MS || 60000); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // /health 用：不含任何貨單內容
  function status() {
    const pending = db.prepare('SELECT COUNT(*) c FROM pnl_outbox').get().c;
    const f = db.prepare('SELECT MIN(first_fail_at) t FROM pnl_outbox WHERE first_fail_at IS NOT NULL').get();
    const ok = db.prepare("SELECT MAX(at) t FROM jobs_log WHERE job = 'pnl_push' AND ok = 1").get();
    return { configured: configured(), pending, failing_since: (f && f.t) || null, last_ok_at: (ok && ok.t) || null };
  }
  return { tick, start, stop, status, configured, markDirty: (storeId, docDate, at) => markDirty(db, storeId, docDate, at) };
}

module.exports = { createPnlPush, markDirty, markAllForStore, markForVendorCategory, markForItem, computeMonth, unmappedReport, loadMap, backoffMs };
