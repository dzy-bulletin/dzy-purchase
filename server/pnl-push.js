'use strict';
// T17：損益推送（Mac mini 端）。plan.md「P3 共用契約」：
//  - 觸發（入帳、取消入帳、對照表變更、門市損益代號變更）→ 寫 pnl_outbox（同店同月合併一筆）
//  - 每 60 秒處理 outbox：組「該店該月完整最新合計」送 purchasePush；成功刪 outbox 並記 jobs_log；失敗保留、指數退避（上限 30 分鐘）
//  - entries 必須是該店該月「所有曾推過的科目」的完整合計：某科目變 0 也要送 0（pnl_pushed 記著曾推過哪些）
//  - 金額一律以「分」累加、輸出元；稅額分攤規則照 P2（calc.slipCosts）
//  - 終態（Eason 定案 #3）：損益端回 LOCKED（該月已定稿）→ outbox.state＝'locked'；回 BAD_INPUT → 'rejected'；兩者都不再自動重試，
//    /health 黃燈帶 reason；新的入帳／取消入帳（markDirty）或手動「重推」（retryNow）會清掉終態重新排入。AUTH／網路／逾時／忙碌照舊指數退避。
//  - 停用科目（Eason 定案 #2）：損益端回 inactive:[acc_id] → 記進 pnl_inactive，這些金額歸入「待補對照」（原因「科目已停用」）
//  - 損益端未預期例外回 INTERNAL（#12）→ 一般失敗、指數退避（不是終態）；每天 04:10（台北）對每個有損益代號的門市最近 3 個月排入一次（#13，冪等）
//  - PNL_PUSH_URL／PNL_PURCHASE_KEY 沒設 → 不推（outbox 保留），/health 顯示「損益推送未設定」（黃）
const calc = require('./calc');
const { jobLog } = require('./db');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (d) => String(d || '').slice(0, 7);
const REASON_UNMAPPED = '未對照';
const REASON_INACTIVE = '科目已停用';
const TERMINAL_CODES = { LOCKED: 'locked', BAD_INPUT: 'rejected' };    // 這兩種回應重試也不會變好 → 終態，不再自動重試
const DAILY_AT = '04:10';                                                  // 台北時間，每日補排時刻（#13）
const BACKOFF_CAP_MS = 30 * 60e3;
const backoffMs = (attempts) => Math.min(BACKOFF_CAP_MS, 60e3 * Math.pow(2, Math.max(0, attempts - 1)));   // 1、2、4、8、16 分，之後 30 分

// ---------- outbox 寫入（可在呼叫端的交易內執行）----------
function markDirty(db, storeId, docDate, at) {
  const month = MONTH_RE.test(String(docDate)) ? String(docDate) : monthOf(docDate);
  if (!storeId || !MONTH_RE.test(month)) return false;
  // 一般列（state 空）維持原樣——不清退避時間（#7）；終態列（locked／rejected）＝重新排入：清終態與失敗痕跡
  db.prepare(`INSERT INTO pnl_outbox (store_id, month, dirty_at, ver) VALUES (?,?,?,1)
    ON CONFLICT(store_id, month) DO UPDATE SET ver = ver + 1, dirty_at = excluded.dirty_at,
      attempts = CASE WHEN state IS NULL THEN attempts ELSE 0 END,
      next_at = CASE WHEN state IS NULL THEN next_at ELSE NULL END,
      first_fail_at = CASE WHEN state IS NULL THEN first_fail_at ELSE NULL END,
      last_error = CASE WHEN state IS NULL THEN last_error ELSE NULL END,
      state = NULL, reason = NULL`).run(storeId, month, at || new Date().toISOString());
  return true;
}
// 手動「重推此店此月」：排入（沒有列就建）＋清終態、退避、失敗痕跡，下一輪（60 秒內）立刻送；該店該月的待撤回工作也一併解除終態
function retryNow(db, storeId, month, at) {
  if (!markDirty(db, storeId, month, at)) return false;
  db.prepare('UPDATE pnl_outbox SET state = NULL, reason = NULL, attempts = 0, next_at = NULL, first_fail_at = NULL, last_error = NULL WHERE store_id = ? AND month = ?').run(storeId, month);
  db.prepare('UPDATE pnl_retire SET state = NULL, reason = NULL, attempts = 0, next_at = NULL, first_fail_at = NULL, last_error = NULL WHERE store_id = ? AND month = ?').run(storeId, month);
  return true;
}
// 門市換／清空損益代號（P3 審查 #2）：把本地記著「曾推過」的（月、科目）轉成「對舊代號推 0」的待撤回工作（pnl_retire），
// 並清掉該店的 pnl_pushed（新代號重新來過）。待撤回工作成功送出才會刪；推不成功就一直排隊、/health 會看得到。
function retireOldCode(db, storeId, oldCode, at) {
  const rows = db.prepare('SELECT month, acc_id FROM pnl_pushed WHERE store_id = ? ORDER BY month, acc_id').all(storeId);
  if (oldCode) {
    const byMonth = new Map();
    for (const r of rows) { if (!byMonth.has(r.month)) byMonth.set(r.month, []); byMonth.get(r.month).push(r.acc_id); }
    for (const [month, accs] of byMonth) {
      const cur = db.prepare('SELECT accs FROM pnl_retire WHERE store_id = ? AND month = ? AND unit_code = ?').get(storeId, month, oldCode);
      const merged = [...new Set((cur ? JSON.parse(cur.accs) : []).concat(accs))].sort();
      db.prepare(`INSERT INTO pnl_retire (store_id, month, unit_code, accs, created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(store_id, month, unit_code) DO UPDATE SET accs = excluded.accs, attempts = 0, next_at = NULL, state = NULL, reason = NULL, first_fail_at = NULL`).run(storeId, month, oldCode, JSON.stringify(merged), at || new Date().toISOString());
    }
  }
  db.prepare('DELETE FROM pnl_pushed WHERE store_id = ?').run(storeId);
  db.prepare('DELETE FROM pnl_inactive WHERE store_id = ?').run(storeId);       // 新代號重新來過：舊代號的「科目已停用」標記作廢
  return rows.length;
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
  // 損益端回報「科目已停用」的 店×月×科目（定案 #2）：對照有填、但推不進去 → 一樣算待補對照，原因標「科目已停用」
  const inactive = new Set(db.prepare('SELECT store_id, month, acc_id FROM pnl_inactive').all().map((r) => `${r.store_id}|${r.month}|${r.acc_id}`));
  const acc = new Map(); let total = 0, inactiveTotal = 0;
  for (const s of calc.slipCosts(db, { brandId: opts.brandId || undefined })) {
    const st = stores.get(s.store_id); if (!st) continue;
    for (const c of calc.COST_CATS) {
      const v = s.cats[c]; if (!v) continue;
      const a = accOf(map, s.vendor_id, c);
      const dead = !!(a && inactive.has(`${s.store_id}|${monthOf(s.doc_date)}|${a}`));
      if (a && !dead) continue;
      const vendor = (s.vendor_id && vendors.get(s.vendor_id)) || s.vendor_name_raw || '（未指定廠商）';
      const key = [s.store_id, monthOf(s.doc_date), s.vendor_id || '', vendor, c, dead ? REASON_INACTIVE : REASON_UNMAPPED].join('\t');
      acc.set(key, (acc.get(key) || 0) + v); total += v; if (dead) inactiveTotal += v;
    }
  }
  const rows = [...acc.entries()].map(([k, v]) => {
    const [sid, month, vid, vendor, category, reason] = k.split('\t'); const st = stores.get(Number(sid));
    return { store_id: Number(sid), store_code: st.code, store_name: st.name, month, vendor_id: vid ? Number(vid) : null, vendor, category, reason, amount: calc.fromCents(v) };
  }).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.store_code < b.store_code ? -1 : a.store_code > b.store_code ? 1 : a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : a.category < b.category ? -1 : 1));
  return { rows, total: calc.fromCents(total), inactive_total: calc.fromCents(inactiveTotal) };
}

// 遠端錯誤訊息清洗：去控制字元、網址、疑似金鑰（長英數串、設定的金鑰本身），截 200 字
function cleanMessage(m, cfg) {
  if (m == null || typeof m === 'object') return '';
  let t = String(m).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  const k = cfg && cfg.PNL_PURCHASE_KEY; if (k) t = t.split(k).join('[key]');
  t = t.replace(/https?:\/\/\S+/gi, '[url]').replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
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
    if (!j || j.ok !== true) {
      const c = String((j && (j.code || j.error)) || 'REJECTED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'REJECTED';
      const err = new Error(c); err.code = c; err.msg = cleanMessage(j && j.message, cfg); throw err;
    }
    return j.data || {};
  }

  // 失敗：記錯誤碼＋清洗過的遠端訊息（≤200 字）到 last_error 與 jobs_log；table＝pnl_outbox 或 pnl_retire
  function fail(row, e, table) {
    table = table || 'pnl_outbox';
    const code = (e && e.code) || 'ERROR';
    const detail = code + (e && e.msg ? ': ' + e.msg : '');
    const at = now(); const attempts = row.attempts + 1;
    const where = table === 'pnl_retire' ? 'store_id = ? AND month = ? AND unit_code = ?' : 'store_id = ? AND month = ?';
    db.prepare(`UPDATE ${table} SET attempts = ?, next_at = ?, first_fail_at = COALESCE(first_fail_at, ?), last_error = ? WHERE ${where}`)
      .run(attempts, new Date(at.getTime() + backoffMs(attempts)).toISOString(), at.toISOString(), detail, row.store_id, row.month, ...(table === 'pnl_retire' ? [row.unit_code] : []));
    jobLog(db, table === 'pnl_retire' ? 'pnl_retire' : 'pnl_push', false, `store=${row.store_id} month=${row.month} code=${code} attempts=${attempts}${e && e.msg ? ' msg=' + e.msg : ''}`);
    log(`${table === 'pnl_retire' ? 'pnl_retire' : 'pnl_push'} 失敗 ${row.store_id} ${row.month} ${code}（第 ${attempts} 次）`);
  }
  const drop = (row) => db.prepare('DELETE FROM pnl_outbox WHERE store_id = ? AND month = ? AND ver = ?').run(row.store_id, row.month, row.ver);
  const yuan = (cents) => String(Number((cents / 100).toFixed(2)));
  const storeName = (id) => { const s = db.prepare('SELECT name FROM stores WHERE id = ?').get(id); return s ? s.name : ''; };

  // 終態（定案 #3）：不再重試；ver 沒變才標（送出期間又被改 → 有新資料，留給下一輪重送，不標終態）。reason 是給 /health 的契約字樣。
  function terminal(row, e, calcd) {
    const code = (e && e.code) || 'ERROR';
    const state = TERMINAL_CODES[code];
    let reason;
    if (state === 'locked') {
      const pushed = db.prepare('SELECT COALESCE(SUM(cents),0) c FROM pnl_pushed WHERE store_id = ? AND month = ?').get(row.store_id, row.month).c;
      const cur = Object.values(calcd.entries).reduce((a, b) => a + b, 0);
      // N＝目前應推總額 − 最後一次成功推送總額（與「上次送出值」的差，含停用／被人工跳過科目的送出值）；字樣帶方向，會計才知道該加還是該減
      const d = cur - pushed;
      reason = `${row.month} 已定稿（${storeName(row.store_id)}），進貨金額變動 ${d < 0 ? '−' : '+'}${yuan(Math.abs(d))} 元未反映到損益，請解除定稿或手動調整`;
    } else {
      reason = `${row.month} 損益端拒收（${code}${e && e.msg ? ': ' + e.msg : ''}），進貨金額未入損益，請檢查科目對照或損益端門市設定`;
    }
    const detail = code + (e && e.msg ? ': ' + e.msg : '');
    const r = db.prepare('UPDATE pnl_outbox SET state = ?, reason = ?, last_error = ?, attempts = attempts + 1, next_at = NULL, first_fail_at = NULL WHERE store_id = ? AND month = ? AND ver = ?')
      .run(state, reason, detail, row.store_id, row.month, row.ver);
    jobLog(db, 'pnl_push', false, `store=${row.store_id} month=${row.month} code=${code} 終態(${state}) 不再重試${e && e.msg ? ' msg=' + e.msg : ''}`);
    log(`pnl_push 終態 ${row.store_id} ${row.month} ${code}${r.changes ? '' : '（送出期間又被改，留待下一輪）'}`);
  }

  // 這次要送的 entries（元）與 pnl_pushed 記著的上次成功送出值逐科目完全相同？（兩邊都空不算「相同」：沒推過就是新資料）
  function lockedNoChange(row, entries) {
    const pushed = db.prepare('SELECT acc_id, cents FROM pnl_pushed WHERE store_id = ? AND month = ?').all(row.store_id, row.month);
    if (!pushed.length) return false;
    const m = new Map(pushed.map((r) => [r.acc_id, r.cents]));
    const keys = Object.keys(entries);
    return keys.length === m.size && keys.every((a) => m.get(a) === Math.round(entries[a] * 100));
  }

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
    } catch (e) {
      if (e && e.code === 'LOCKED' && lockedNoChange(row, entries)) {      // 已定稿月、但這次內容與上次成功推送完全相同（例如每日重送）→ 沒有新進貨，不是問題
        drop(row); jobLog(db, 'pnl_skip', true, `store=${row.store_id} month=${row.month} 該月已定稿且金額無變動，略過`); return 'skipped';
      }
      if (e && TERMINAL_CODES[e.code]) { terminal(row, e, calcd); return 'terminal'; }
      fail(row, e); return 'failed';
    }
    // 損益端回報停用的科目：沒寫進去 → 不記「曾推過」、金額歸待補對照（科目已停用）；之後科目重新啟用，下一次成功推送就會從清單移除
    const inactive = (Array.isArray(data.inactive) ? data.inactive : []).map((x) => String(x).slice(0, 30)).filter((a) => a in entries);
    db.tx(() => {
      db.prepare('DELETE FROM pnl_inactive WHERE store_id = ? AND month = ?').run(row.store_id, row.month);
      const insI = db.prepare('INSERT OR IGNORE INTO pnl_inactive (store_id, month, acc_id) VALUES (?,?,?)');
      inactive.forEach((a) => insI.run(row.store_id, row.month, a));
      const ins = db.prepare('INSERT INTO pnl_pushed (store_id, month, acc_id, cents) VALUES (?,?,?,?) ON CONFLICT(store_id, month, acc_id) DO UPDATE SET cents = excluded.cents');
      Object.keys(entries).filter((a) => !inactive.includes(a)).forEach((a) => ins.run(row.store_id, row.month, a, Math.round(entries[a] * 100)));
      // 成功 → 重設退避狀態（ver 變了列還在時，不能把舊的失敗紀錄帶到下一輪）；沒被改過才刪
      db.prepare('UPDATE pnl_outbox SET attempts = 0, first_fail_at = NULL, last_error = NULL, next_at = NULL WHERE store_id = ? AND month = ?').run(row.store_id, row.month);
      drop(row);                                                       // ver 變了（送出期間又被改）→ 不刪，下一輪再推
    });
    const sk = Array.isArray(data.skipped_manual) ? data.skipped_manual.map((x) => String(x).slice(0, 30)).join(',') : '';
    jobLog(db, 'pnl_push', true, `store=${row.store_id} month=${row.month} accounts=${Object.keys(entries).length} skipped_manual=[${sk}] inactive=[${inactive.join(',')}] voided=${Number(data.voided) || 0}`);
    return 'ok';
  }

  // 待撤回工作：對舊代號推 0（entries 全 0），成功才刪。若門市後來又改回這個代號 → 不用撤，交給一般推送
  async function retireOne(row) {
    const store = db.prepare('SELECT pnl_unit_code FROM stores WHERE id = ?').get(row.store_id);
    const del = () => db.prepare('DELETE FROM pnl_retire WHERE store_id = ? AND month = ? AND unit_code = ?').run(row.store_id, row.month, row.unit_code);
    if (store && store.pnl_unit_code === row.unit_code) { del(); jobLog(db, 'pnl_retire', true, `store=${row.store_id} month=${row.month} 門市改回原代號，免撤回`); return 'retired'; }
    const entries = {}; for (const a of JSON.parse(row.accs)) entries[a] = 0;
    try { await post({ action: 'purchasePush', key: cfg.PNL_PURCHASE_KEY, store_id: row.unit_code, month: row.month, entries, pending_unmapped: 0 }); }
    catch (e) {
      if (e && TERMINAL_CODES[e.code]) {
        const state = TERMINAL_CODES[e.code];
        const reason = state === 'locked' ? `${row.month} 已定稿，舊代號的進貨系統金額無法撤回，請解除定稿或手動作廢` : `${row.month} 損益端拒收舊代號的撤回（${e.code}），請手動處理`;
        db.prepare('UPDATE pnl_retire SET state = ?, reason = ?, last_error = ?, next_at = NULL, first_fail_at = NULL WHERE store_id = ? AND month = ? AND unit_code = ?')
          .run(state, reason, e.code + (e.msg ? ': ' + e.msg : ''), row.store_id, row.month, row.unit_code);
        jobLog(db, 'pnl_retire', false, `store=${row.store_id} month=${row.month} code=${e.code} 終態(${state}) 不再重試`);
        return 'terminal';
      }
      fail(row, e, 'pnl_retire'); return 'failed';
    }
    del();
    jobLog(db, 'pnl_retire', true, `store=${row.store_id} month=${row.month} accounts=${Object.keys(entries).length} 舊代號已推 0`);
    return 'retired';
  }

  // #13：每天台北 04:10 起，對每個有設損益代號的門市最近 3 個月（本月＋前 2 個月）各排入一次。
  // 補上「本系統收不到事件」的情況（損益端人工列被作廢、機器值沒回來等）。冪等：已在 outbox 的不動；終態列（已定稿／被拒收）也不動
  // （只有新入帳／取消入帳／手動重推才會解除終態）；損益端同金額再推不新增。每個台北日期只做一次（記在 jobs_log，重開機不重做）。
  function dailyRefresh() {
    const t = now(); const tp = new Date(t.getTime() + 8 * 3600e3);
    const today = tp.toISOString().slice(0, 10);
    if (tp.toISOString().slice(11, 16) < DAILY_AT) return 0;
    const done = db.prepare("SELECT 1 FROM jobs_log WHERE job = 'pnl_daily' AND ok = 1 AND detail LIKE ? LIMIT 1").get(`date=${today}%`);
    if (done) return 0;
    const y = tp.getUTCFullYear(), mo = tp.getUTCMonth();
    const months = [0, 1, 2].map((i) => { const d = new Date(Date.UTC(y, mo - i, 1)); return d.toISOString().slice(0, 7); });
    let n = 0;
    db.tx(() => {
      const ins = db.prepare('INSERT OR IGNORE INTO pnl_outbox (store_id, month, dirty_at, ver) VALUES (?,?,?,1)');
      for (const s of db.prepare("SELECT id FROM stores WHERE pnl_unit_code IS NOT NULL AND pnl_unit_code <> ''").all()) for (const m of months) n += ins.run(s.id, m, t.toISOString()).changes;
      jobLog(db, 'pnl_daily', true, `date=${today} 排入 ${n} 筆（最近 3 個月：${months.join('、')}）`);
    });
    return n;
  }

  // 處理到期的 outbox；回傳各結果筆數。force＝忽略退避時間（手動／測試）
  async function tick(opt) {
    if (running) return { busy: true };
    if (!configured()) return { configured: false };
    running = true;
    const out = { ok: 0, failed: 0, skipped: 0, empty: 0, retired: 0, terminal: 0 };
    try {
      const t = now().toISOString();
      const due = opt && opt.force ? '9999' : t;
      for (const r of db.prepare('SELECT * FROM pnl_retire WHERE state IS NULL AND (next_at IS NULL OR next_at <= ?) ORDER BY created_at, store_id, month LIMIT 50').all(due)) { const k = await retireOne(r); out[k]++; }   // 先撤舊代號，再推新代號
      const rows = db.prepare('SELECT * FROM pnl_outbox WHERE state IS NULL AND (next_at IS NULL OR next_at <= ?) ORDER BY dirty_at, store_id, month LIMIT 50').all(opt && opt.force ? '9999' : t);
      for (const r of rows) { const k = await pushOne(r); out[k]++; }
    } catch (e) { jobLog(db, 'pnl_push', false, 'tick 例外 ' + String(e && e.message).slice(0, 200)); }
    finally { running = false; }
    return out;
  }
  function start() { if (timer) return; timer = setInterval(() => { try { dailyRefresh(); } catch (e) { jobLog(db, 'pnl_daily', false, String(e && e.message).slice(0, 200)); } tick(); }, cfg.PNL_TICK_MS || 60000); if (timer.unref) timer.unref(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  // /health 用：不含任何貨單內容
  function status() {
    const pending = db.prepare('SELECT COUNT(*) c FROM pnl_outbox WHERE state IS NULL').get().c + db.prepare('SELECT COUNT(*) c FROM pnl_retire WHERE state IS NULL').get().c;
    const f = db.prepare('SELECT MIN(t) t FROM (SELECT MIN(first_fail_at) t FROM pnl_outbox WHERE state IS NULL AND first_fail_at IS NOT NULL UNION ALL SELECT MIN(first_fail_at) FROM pnl_retire WHERE state IS NULL AND first_fail_at IS NOT NULL)').get();
    const ok = db.prepare("SELECT MAX(at) t FROM jobs_log WHERE job = 'pnl_push' AND ok = 1").get();
    return { configured: configured(), pending, failing_since: (f && f.t) || null, last_ok_at: (ok && ok.t) || null, terminal: terminalList() };
  }
  // 終態列（locked／rejected）：黃燈用；reason 已含月份與金額，另附門市名稱供多店分辨
  function terminalList(brandId) {
    const q = `SELECT 'push' kind, o.store_id, o.month, o.state, o.reason, s.name store_name, s.brand_id FROM pnl_outbox o JOIN stores s ON s.id = o.store_id WHERE o.state IS NOT NULL
      UNION ALL SELECT 'retire', r.store_id, r.month, r.state, r.reason, s.name, s.brand_id FROM pnl_retire r JOIN stores s ON s.id = r.store_id WHERE r.state IS NOT NULL`;
    return db.prepare(`SELECT * FROM (${q}) ${brandId ? 'WHERE brand_id = ?' : ''} ORDER BY month, store_id`).all(...(brandId ? [brandId] : []))
      .map((r) => ({ kind: r.kind, store_id: r.store_id, store_name: r.store_name, month: r.month, state: r.state, reason: r.reason }));
  }
  return { tick, dailyRefresh, start, stop, status, terminalList, configured, retryNow: (storeId, month, at) => retryNow(db, storeId, month, at), markDirty: (storeId, docDate, at) => markDirty(db, storeId, docDate, at) };
}

module.exports = { createPnlPush, cleanMessage, retireOldCode, retryNow, markDirty, markAllForStore, markForVendorCategory, markForItem, computeMonth, unmappedReport, loadMap, backoffMs };
