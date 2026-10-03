#!/usr/bin/env node
'use strict';
// 辨識速度量測（P4 部署用）：拿一個資料夾裡的 JPEG（用 server/dev/demo-seed.js 產的虛構照片），
// 照正式辨識的做法（縮圖＋提示詞＋MODEL）逐張送 Ollama，印每張秒數與判定。不寫資料庫、不寫檔。
//   OLLAMA_TIMEOUT_S=900 node server/tools/ollama-bench.js <照片資料夾> [張數=3]
// 判定：任一張超過 300 秒（正式辨識的單張上限）→ 印「超過 300 秒」並結束碼 3，手冊要求改用 7b 並回報。
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config');
const { ollamaRecognize, parseAi, PROMPT } = require('../worker');

function findJpgs(dir, n) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= n) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (/\.jpe?g$/i.test(e.name)) out.push(f);
    }
  })(dir);
  return out;
}

async function main() {
  const dir = process.argv[2], n = Number(process.argv[3] || 3);
  if (!dir || !fs.existsSync(dir)) { console.error('用法：node server/tools/ollama-bench.js <照片資料夾> [張數]'); process.exit(2); }
  const cfg = loadConfig();
  const files = findJpgs(dir, n);
  if (!files.length) { console.error('資料夾裡找不到 JPEG'); process.exit(2); }
  console.log(`模型 ${cfg.MODEL}，單張上限 ${cfg.OLLAMA_TIMEOUT_MS / 1000} 秒，共 ${files.length} 張（第一張含模型載入時間）`);
  const secs = []; let failed = 0;
  for (const f of files) {
    const t0 = Date.now();
    let note = '';
    try { const ai = parseAi(await ollamaRecognize(cfg, [f], PROMPT)); note = `讀到 ${ai.lines.length} 列品項`; }
    catch (e) { failed++; note = '失敗：' + e.message; }
    const s = (Date.now() - t0) / 1000; secs.push(s);
    console.log(`  ${path.basename(f)}\t${s.toFixed(1)} 秒\t${note}`);
  }
  const max = Math.max(...secs), avg = secs.reduce((a, b) => a + b, 0) / secs.length;
  console.log(`平均 ${avg.toFixed(1)} 秒、最慢 ${max.toFixed(1)} 秒、失敗 ${failed} 張`);
  if (max > 300) { console.log('判定：超過 300 秒 → 請改用 qwen2.5vl:7b 並回報 Eason'); process.exit(3); }
  console.log('判定：未超過 300 秒，可用此模型'); process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('失敗：' + e.message); process.exit(1); });
