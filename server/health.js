'use strict';
// T20：/health。紅黃燈規則（plan.md「P3 共用契約」，判定是純函式 judge()，守門與測試共用同一份）：
//  紅：Ollama 無回應；佇列中最舊一張等待 > 30 分鐘；備份上次成功 > 26 小時；損益推送失敗持續 > 1 小時。
//  黃：損益推送未設定；有「待補對照」金額（含科目已停用）；損益推送終態（月份已定稿／被拒收，不再重試）；有辨識失敗待處理。
// 公開 /health 不含任何貨單內容、門市名、科目代號、金額（只有燈號、通用原因代碼、計數、時間）；詳細原因走登入後的 GET /health/detail。
const fs = require('fs');
const path = require('path');
const P = require('./pnl-push');
const { ApiError } = require('./http-util');

const RULES = { queueRedMin: 30, backupRedH: 26, pnlFailRedH: 1 };
const H = 3600e3;

// 通用原因代碼（公開 /health 只給這些；詳細文字只在登入後的 /health/detail）
const CODES = {
  OLLAMA: 'OLLAMA_DOWN', QUEUE: 'QUEUE_STALE', BACKUP_NEVER: 'BACKUP_NEVER', BACKUP_STALE: 'BACKUP_STALE', PNL_FAIL: 'PNL_PUSH_FAILING',
  PNL_UNCONFIGURED: 'PNL_NOT_CONFIGURED', UNMAPPED: 'UNMAPPED_AMOUNT', INACTIVE: 'PNL_ACCOUNT_INACTIVE', TERMINAL: 'PNL_PUSH_STUCK', FAILED: 'RECOGNITION_FAILED'
};
// in: { ollama:boolean, queue:{waiting, oldest_min}, backup:{last_ok_at, needed}, pnl:{configured, failing_since, ...}, unmapped_amount, failed_count } → { status, reasons（詳細文字）, codes（通用代碼，順序與 reasons 一一對應） }
function judge(h, nowMs) {
  const now = nowMs || Date.now(), red = [], yellow = [];
  const add = (list, code, text) => list.push({ code, text });
  if (!h.ollama) add(red, CODES.OLLAMA, 'Ollama 沒有回應');
  if (h.queue && h.queue.waiting > 0 && h.queue.oldest_min > RULES.queueRedMin) add(red, CODES.QUEUE, '辨識佇列卡超過 30 分鐘');
  const b = h.backup || {};
  const bt = Date.parse(b.last_ok_at || '');
  if (isNaN(bt)) { if (b.needed) add(red, CODES.BACKUP_NEVER, '備份從來沒有成功過'); }       // 還沒有任何已入帳資料就沒東西可備份，不算紅
  else if (now - bt > RULES.backupRedH * H) add(red, CODES.BACKUP_STALE, '備份超過 26 小時沒成功');
  const p = h.pnl || {};
  if (p.configured && p.failing_since) { const t = Date.parse(p.failing_since); if (!isNaN(t) && now - t > RULES.pnlFailRedH * H) add(red, CODES.PNL_FAIL, '損益推送失敗超過 1 小時'); }
  if (!p.configured) add(yellow, CODES.PNL_UNCONFIGURED, '損益推送未設定');
  if (h.unmapped_amount > 0) add(yellow, CODES.UNMAPPED, '有待補對照的金額');
  if (h.inactive_amount > 0) add(yellow, CODES.INACTIVE, '有進貨金額歸在已停用的損益科目（待補對照：科目已停用）');
  for (const r of (p.terminal_reasons || [])) add(yellow, CODES.TERMINAL, r);                 // 終態（已定稿／被拒收）：不再重試，帶原因文字等人處理
  if (h.failed_count > 0) add(yellow, CODES.FAILED, '有辨識失敗待處理');
  const all = red.concat(yellow);
  return { status: red.length ? 'red' : yellow.length ? 'yellow' : 'green', reasons: all.map((x) => x.text), codes: all.map((x) => x.code) };
}

function readBackupLast(cfg) {
  try { const j = JSON.parse(fs.readFileSync(path.join(cfg.LOG_DIR, 'backup-last.json'), 'utf8')); return j && j.ok !== false && typeof j.at === 'string' ? j.at : null; }
  catch (e) { return null; }
}

module.exports = function register(ctx) {
  const { route, db, cfg, now, pnlPush, sendJson, corsHeaders, RAW } = ctx;
  // P3 審查 #8：/health 是公開端點，Ollama 探測與「待補對照」（掃全部已入帳明細）都快取，避免被連打時每次都重算
  const CACHE_MS = cfg.HEALTH_CACHE_MS === undefined ? 30000 : cfg.HEALTH_CACHE_MS;
  let ollamaC = null, unmappedC = null;
  async function checkOllama() {
    const t = Date.now();
    if (ollamaC && t - ollamaC.at < CACHE_MS) return ollamaC.v;
    let v = false;
    try { const r = await fetch(cfg.OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(1500) }); v = r.ok; } catch (e) { /* 沒開 */ }
    ollamaC = { at: t, v }; return v;
  }
  function unmappedTotal() {
    const t = Date.now();
    if (unmappedC && t - unmappedC.at < CACHE_MS) return unmappedC.v;
    const r = P.unmappedReport(db); const v = { total: r.total, inactive: r.inactive_total }; unmappedC = { at: t, v }; return v;
  }
  // scope＝null：全部（公開端點用）；scope＝brand_id：只看該品牌的門市（待補對照、終態）。系統層（Ollama、佇列、備份）不分品牌
  async function collect(scope, cached) {
    const ollama = await checkOllama();
    const t = now();
    const q = db.prepare("SELECT COUNT(*) c, MIN(uploaded_at) o FROM slips WHERE status IN ('uploaded','queued','recognizing')").get();
    const oldest_min = q.o ? Math.max(0, Math.floor((t.getTime() - Date.parse(q.o)) / 60e3)) : 0;
    const failed_count = db.prepare("SELECT COUNT(*) c FROM slips WHERE status = 'failed'").get().c;
    const needed = db.prepare("SELECT 1 FROM slips WHERE status = 'confirmed' LIMIT 1").get() ? true : false;
    const ps = pnlPush.status();
    const terminal = scope ? pnlPush.terminalList(scope) : ps.terminal;
    let unmapped_amount, inactive_amount;
    if (scope) { const r = P.unmappedReport(db, { brandId: scope }); unmapped_amount = r.total; inactive_amount = r.inactive_total; }
    else { const um = unmappedTotal(); unmapped_amount = um.total; inactive_amount = um.inactive; }
    const body = {
      server: true, time: t.toISOString(), model: cfg.MODEL,   // 設定值（.env 的 MODEL），不代表 Ollama 已載入；以 ollama list 為準
      ollama,
      queue: { waiting: q.c, oldest_min },
      backup: { last_ok_at: readBackupLast(cfg) },
      pnl: { configured: ps.configured, last_ok_at: ps.last_ok_at, pending: ps.pending, terminal: terminal.length },
      failed: failed_count
    };
    const j = judge({ ollama, queue: body.queue, backup: { last_ok_at: body.backup.last_ok_at, needed }, pnl: { configured: ps.configured, failing_since: ps.failing_since, terminal_reasons: terminal.map((x) => x.reason) }, unmapped_amount, inactive_amount, failed_count }, t.getTime());
    return { body, j, unmapped_amount };
  }
  // 公開（無登入）：只有燈號與通用原因代碼＋計數；不含門市名、科目代號、金額、貨單內容。守門直接讀 status
  route('GET', /^\/health$/, null, async ({ req, res }) => {
    const { body, j } = await collect(null);
    sendJson(res, 200, Object.assign({ ok: true, status: j.status, reasons: j.codes }, body), corsHeaders(req));
    return RAW;
  });
  // 登入後詳細原因（admin 看全部；會計只看本品牌門市的待補對照與終態）。reasons＝詳細文字、codes＝通用代碼、含待補對照金額
  route('GET', /^\/health\/detail$/, ['admin', 'accountant'], async ({ p }) => {
    const scope = p.role === 'accountant' ? p.brand_id : null;
    if (p.role === 'accountant' && !scope) throw new ApiError('FORBIDDEN', '這個會計帳號沒有設定品牌');
    const { body, j, unmapped_amount } = await collect(scope);
    return Object.assign({ status: j.status, reasons: j.reasons, codes: j.codes, unmapped_amount, scope_brand_id: scope }, body);
  });
};
module.exports.judge = judge;
module.exports.RULES = RULES;
module.exports.CODES = CODES;
