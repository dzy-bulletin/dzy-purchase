'use strict';
// 設定：.env（server/.env 或專案根 .env，不進版控）＋環境變數（環境變數優先）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function readDotenv(file, into) {
  try {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line) => {
      const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && into[m[1]] === undefined) into[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch (e) { /* 沒有 .env 就用預設 */ }
}

// ACCT_LOGIN_UNTIL → 截止時刻（毫秒，台北時間隔天 00:00）；沒設＝null；格式不對印警告並當沒設
function acctUntil(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(t) ? Date.parse(t + 'T00:00:00+08:00') : NaN;
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600e3).toISOString().slice(0, 10) !== t) { console.error('ACCT_LOGIN_UNTIL 格式不對（要 YYYY-MM-DD），當作沒設：' + t.slice(0, 20)); return null; }
  return ms + 86400e3;
}

function loadConfig(envIn) {
  const env = Object.assign({}, envIn || process.env);
  if (!envIn && env.PURCHASE_NO_DOTENV !== '1') {
    readDotenv(path.join(__dirname, '.env'), env);
    readDotenv(path.join(ROOT, '.env'), env);
  }
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR.replace(/^~/, env.HOME || '')) : path.join(ROOT, 'data');
  return {
    ROOT,
    PORT: env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 8794,
    BIND: env.BIND || '127.0.0.1',
    DATA_DIR: dataDir,
    OLLAMA_URL: (env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, ''),
    MODEL: env.MODEL || 'qwen2.5vl:7b',
    OLLAMA_TIMEOUT_MS: num(env.OLLAMA_TIMEOUT_S, 300) * 1000,       // 單張單次最長等待（秒，可設小數）；P4 以 32B 實測再調
    RETRY_DELAY_MS: env.RETRY_DELAY_MS !== undefined ? Number(env.RETRY_DELAY_MS) : 5000,
    WORKER: env.WORKER !== '0',                       // 測試用：0＝不自動啟動工人
    EXTRA_ORIGINS: (env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
    LOG_DIR: env.LOG_DIR ? path.resolve(env.LOG_DIR.replace(/^~/, env.HOME || '')) : path.join(ROOT, 'logs'),
    PNL_PUSH_URL: env.PNL_PUSH_URL || '',
    PNL_PURCHASE_KEY: env.PNL_PURCHASE_KEY || '',
    PNL_TICK_MS: num(env.PNL_TICK_MS, 60000),                 // outbox 處理間隔（契約：60 秒）
    PNL_TIMEOUT_MS: num(env.PNL_TIMEOUT_MS, 60000),
    BACKUP_URL: env.BACKUP_URL || '',
    BACKUP_KEY: env.BACKUP_KEY || '',
    BACKUP_TIMEOUT_MS: num(env.BACKUP_TIMEOUT_MS, 90000),
    STORE_SVC_KEY: env.STORE_SVC_KEY || '',                   // 門市營運系統服務金鑰；空＝通道關閉
    STORE_LOGIN_OFF: env.STORE_LOGIN_OFF === '1',             // 1＝門市密碼登入關閉（改走門市營運系統）
    // 會計從鼎兆元管理系統嵌入（dzy 倉庫 docs/purchase-fin/spec.md §4）：平台 /api 網址＋服務金鑰；任一沒設＝/sso 回 FORBIDDEN
    DZY_PLATFORM_URL: (env.DZY_PLATFORM_URL || '').trim(),
    DZY_PURCHASE_SVC_KEY: (env.DZY_PURCHASE_SVC_KEY || '').trim(),
    DZY_TIMEOUT_MS: num(env.DZY_TIMEOUT_MS, 8000),
    // 會計密碼登入截止日（YYYY-MM-DD，台北時間該日結束後擋 role accountant 的密碼登入；admin 不擋）。沒設或格式不對＝不限
    ACCT_LOGIN_UNTIL: acctUntil(env.ACCT_LOGIN_UNTIL),
    MAX_PHOTO_BYTES: 8 * 1024 * 1024,
    MAX_PHOTOS: 6,
    LOCK_AFTER: 5,
    LOCK_MS: 15 * 60e3
  };
}
module.exports = { loadConfig, ROOT };
