#!/usr/bin/env node
'use strict';
// 貨單資料庫「從備份還原」之後要跑一次：重產入帳事件的世代編號（feed_epoch）。
// 門市營運系統看到編號變了，會停掉該店的貨單價格同步、在健康檢查亮黃燈，等管理者按「重建」從頭重拿，避免還原後漏掉新入帳的單。
// 在 Mac mini 終端機執行（不用停服務）：
//   node server/tools/reset-feed-epoch.js            只顯示目前的編號
//   node server/tools/reset-feed-epoch.js --apply    換一組新編號
const { loadConfig } = require('../config');
const { openDb } = require('../db');
const feed = require('../price-feed');

const cfg = loadConfig();
const db = openDb(cfg.DATA_DIR);
const before = feed.epochOf(db);
if (!process.argv.includes('--apply')) { console.log(`目前編號：${before}（加 --apply 才會換）`); process.exit(0); }
const after = feed.resetEpoch(db);
console.log(`已換：${before} → ${after}`);
