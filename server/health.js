'use strict';
// T20：/health。紅黃燈規則（plan.md「P3 共用契約」，判定是純函式 judge()，守門與測試共用同一份）：
//  紅：Ollama 無回應；佇列中最舊一張等待 > 30 分鐘；備份上次成功 > 26 小時；損益推送失敗持續 > 1 小時。
//  黃：損益推送未設定；有「待補對照」金額；有辨識失敗待處理。
// 回應不含任何貨單內容（只有數字、時間、固定短句）。
const fs = require('fs');
const path = require('path');
const P = require('./pnl-push');

const RULES = { queueRedMin: 30, backupRedH: 26, pnlFailRedH: 1 };
const H = 3600e3;

// in: { ollama:boolean, queue:{waiting, oldest_min}, backup:{last_ok_at, needed}, pnl:{configured, failing_since, ...}, unmapped_amount, failed_count } → { status, reasons }
function judge(h, nowMs) {
  const now = nowMs || Date.now(), red = [], yellow = [];
  if (!h.ollama) red.push('Ollama 沒有回應');
  if (h.queue && h.queue.waiting > 0 && h.queue.oldest_min > RULES.queueRedMin) red.push('辨識佇列卡超過 30 分鐘');
  const b = h.backup || {};
  const bt = Date.parse(b.last_ok_at || '');
  if (isNaN(bt)) { if (b.needed) red.push('備份從來沒有成功過'); }       // 還沒有任何已入帳資料就沒東西可備份，不算紅
  else if (now - bt > RULES.backupRedH * H) red.push('備份超過 26 小時沒成功');
  const p = h.pnl || {};
  if (p.configured && p.failing_since) { const t = Date.parse(p.failing_since); if (!isNaN(t) && now - t > RULES.pnlFailRedH * H) red.push('損益推送失敗超過 1 小時'); }
  if (!p.configured) yellow.push('損益推送未設定');
  if (h.unmapped_amount > 0) yellow.push('有待補對照的金額');
  if (h.failed_count > 0) yellow.push('有辨識失敗待處理');
  return { status: red.length ? 'red' : yellow.length ? 'yellow' : 'green', reasons: red.concat(yellow) };
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
    const v = P.unmappedReport(db).total; unmappedC = { at: t, v }; return v;
  }
  route('GET', /^\/health$/, null, async ({ req, res }) => {
    const ollama = await checkOllama();
    const t = now();
    const q = db.prepare("SELECT COUNT(*) c, MIN(uploaded_at) o FROM slips WHERE status IN ('uploaded','queued','recognizing')").get();
    const oldest_min = q.o ? Math.max(0, Math.floor((t.getTime() - Date.parse(q.o)) / 60e3)) : 0;
    const failed_count = db.prepare("SELECT COUNT(*) c FROM slips WHERE status = 'failed'").get().c;
    const needed = db.prepare("SELECT 1 FROM slips WHERE status = 'confirmed' LIMIT 1").get() ? true : false;
    const ps = pnlPush.status();
    const unmapped_amount = unmappedTotal();
    const body = {
      server: true, time: t.toISOString(), model: cfg.MODEL, ollama,
      queue: { waiting: q.c, oldest_min },
      backup: { last_ok_at: readBackupLast(cfg) },
      pnl: { configured: ps.configured, last_ok_at: ps.last_ok_at, pending: ps.pending },
      unmapped_amount, failed: failed_count
    };
    const j = judge({ ollama, queue: body.queue, backup: { last_ok_at: body.backup.last_ok_at, needed }, pnl: { configured: ps.configured, failing_since: ps.failing_since }, unmapped_amount, failed_count }, t.getTime());
    // ok＝伺服器有回應（燈號看 status）；頂層回傳，守門直接讀 status
    sendJson(res, 200, Object.assign({ ok: true, status: j.status, reasons: j.reasons }, body), corsHeaders(req));
    return RAW;
  });
};
module.exports.judge = judge;
module.exports.RULES = RULES;
