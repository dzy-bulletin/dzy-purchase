#!/usr/bin/env node
'use strict';
// 正式帳號建立工具（P4／T23）：在 Mac mini 的「終端機」App 由 Eason 互動執行。
//   node server/tools/create-accounts.js            建立／補齊：5 間門市、2 位會計（吳佳宜 C＋X、張淳 M）、1 位 admin
//   node server/tools/create-accounts.js --list     只列出目前狀態（不問密碼、不改任何東西）
//   node server/tools/create-accounts.js --only stores|accountants|admin   只做其中一類
// 密碼只在終端機輸入（不回顯、要輸入兩次），不寫檔、不印出、不進任何 log；Claude 不執行這支工具（密碼不經過 Claude）。
// 冪等：帳號已存在 → 預設跳過；問「要重設密碼嗎？」答 y 才會重設。門市損益代號請在管理頁「門市」設定。
const { loadConfig } = require('../config');
const { openDb, audit } = require('../db');
const { hashPassword } = require('../auth');

const BRANDS = [['X', '小辛辣'], ['M', '墨竹亭'], ['C', '央廚']];
// [代號, 品牌, 名稱]
const STORES = [
  ['CF', 'C', '中央廚房'],
  ['MDGF', 'X', '麻的小辛辣新竹光復'],
  ['MZTGF', 'M', '墨竹亭新竹光復'],
  ['MZTZS', 'M', '墨竹亭新竹金山'],
  ['MZTLZL', 'M', '墨竹亭台北六張犁']
];
// [預設帳號, 姓名, 品牌（第一個＝預設品牌）]
const ACCOUNTANTS = [
  ['acc-wu', '吳佳宜', ['C', 'X']],
  ['acc-zhang', '張淳', ['M']]
];
const ADMIN = ['admin', '管理者'];
const MIN_PW = 6;
const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;
const WHO = 'tool:create-accounts';

// 取得密碼（輸入兩次）。ask＝讀一般文字，askHidden＝讀不回顯文字（由呼叫端提供，測試時可注入）
async function askPassword(io, label) {
  for (;;) {
    const a = await io.askHidden(`  ${label} 密碼（至少 ${MIN_PW} 字元，輸入時不會顯示）：`);
    if (a.length < MIN_PW) { io.out(`  ✗ 至少 ${MIN_PW} 個字元，請重打`); continue; }
    const b = await io.askHidden('  再輸入一次確認：');
    if (a !== b) { io.out('  ✗ 兩次不一樣，請重打'); continue; }
    return a;
  }
}
const yes = async (io, q) => /^y(es)?$/i.test((await io.ask(q + ' (y/N) ')).trim());

async function run(db, io, opts) {
  opts = opts || {};
  const only = opts.only || 'all';
  const sum = { created: [], reset: [], skipped: [], brandsFixed: [] };
  if (!opts.list) db.tx(() => { for (const [id, name] of BRANDS) db.prepare('INSERT OR IGNORE INTO brands (id, name) VALUES (?,?)').run(id, name); });   // --list 完全唯讀

  if (opts.list) {
    io.out('門市：');
    for (const [code, brand, name] of STORES) { const r = db.prepare('SELECT active, pnl_unit_code FROM stores WHERE code = ?').get(code); io.out(`  ${code}\t${name}\t品牌 ${brand}\t${r ? (r.active ? '已建立' : '已停用') + (r.pnl_unit_code ? '' : '（未設損益代號）') : '尚未建立'}`); }
    io.out('帳號：');
    for (const [u, name, brands] of ACCOUNTANTS.concat([[ADMIN[0], ADMIN[1], []]])) {
      const r = db.prepare('SELECT id, role, active FROM users WHERE username = ?').get(u);
      const bs = r ? db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ? ORDER BY brand_id').all(r.id).map((x) => x.brand_id).join('＋') : '';
      io.out(`  ${u}\t${name}\t${brands.length ? '品牌 ' + brands.join('＋') : '管理者'}\t${r ? (r.active ? '已建立' : '已停用') + (bs ? `（現有品牌 ${bs}）` : '') : '尚未建立'}`);
    }
    return sum;
  }

  if (only === 'all' || only === 'stores') {
    io.out('\n== 門市');
    for (const [code, brand, name] of STORES) {
      const ex = db.prepare('SELECT id FROM stores WHERE code = ?').get(code);
      if (!ex) {
        io.out(`${code}（${name}，品牌 ${brand}）尚未建立`);
        const pw = await askPassword(io, code);
        db.tx(() => {
          db.prepare('INSERT INTO stores (brand_id, code, name, pass_hash, active) VALUES (?,?,?,?,1)').run(brand, code, name, hashPassword(pw));
          audit(db, WHO, 'admin_store_create', null, null, { code, name, brand_id: brand });
        });
        sum.created.push(code); io.out(`  ✓ 已建立 ${code}`);
      } else if (await yes(io, `${code} 已存在，要重設密碼嗎？`)) {
        const pw = await askPassword(io, code);
        db.tx(() => {
          db.prepare('UPDATE stores SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE id = ?').run(hashPassword(pw), ex.id);
          db.prepare('DELETE FROM sessions WHERE who = ?').run(`store:${ex.id}`);
          audit(db, WHO, 'admin_store_update', null, null, { code, password_changed: true });
        });
        sum.reset.push(code); io.out(`  ✓ 已重設 ${code} 的密碼`);
      } else { sum.skipped.push(code); io.out(`  － 略過 ${code}`); }
    }
  }

  const people = [];
  if (only === 'all' || only === 'accountants') ACCOUNTANTS.forEach((a) => people.push({ role: 'accountant', def: a[0], name: a[1], brands: a[2] }));
  if (only === 'all' || only === 'admin') people.push({ role: 'admin', def: ADMIN[0], name: ADMIN[1], brands: [] });
  if (people.length) io.out('\n== 會計與管理者');
  for (const p of people) {
    io.out(`${p.name}（${p.role === 'admin' ? '管理者' : '會計，品牌 ' + p.brands.join('＋')}）`);
    const typed = (await io.ask(`  帳號（英數 . _ -，3–40 字；直接 Enter＝${p.def}）：`)).trim();
    const username = typed || p.def;
    if (!USERNAME.test(username)) { io.out('  ✗ 帳號格式不對，略過這一位（請重跑工具）'); sum.skipped.push(username); continue; }
    if (db.prepare('SELECT 1 FROM stores WHERE code = ?').get(username.toUpperCase())) { io.out('  ✗ 帳號不可與門市代號相同，略過'); sum.skipped.push(username); continue; }
    const ex = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
    if (ex && ex.role !== p.role) { io.out(`  ✗ ${username} 已存在但角色不同（${ex.role}），略過；請到管理頁處理`); sum.skipped.push(username); continue; }
    let uid;
    if (!ex) {
      const pw = await askPassword(io, username);
      db.tx(() => {
        uid = Number(db.prepare('INSERT INTO users (username, role, brand_id, name, pass_hash, active) VALUES (?,?,?,?,?,1)')
          .run(username, p.role, p.brands[0] || null, p.name, hashPassword(pw)).lastInsertRowid);
        p.brands.forEach((b) => db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?,?)').run(uid, b));
        audit(db, WHO, 'admin_user_create', null, null, { username, name: p.name, role: p.role, brand_ids: p.brands });
      });
      sum.created.push(username); io.out(`  ✓ 已建立 ${username}`);
    } else {
      uid = ex.id;
      if (await yes(io, `  ${username} 已存在，要重設密碼嗎？`)) {
        const pw = await askPassword(io, username);
        db.tx(() => {
          db.prepare('UPDATE users SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE id = ?').run(hashPassword(pw), uid);
          db.prepare('DELETE FROM sessions WHERE who = ?').run(`user:${uid}`);
          audit(db, WHO, 'admin_user_update', null, null, { username, password_changed: true });
        });
        sum.reset.push(username); io.out(`  ✓ 已重設 ${username} 的密碼`);
      } else { sum.skipped.push(username); io.out(`  － 略過 ${username} 的密碼`); }
    }
    if (p.role === 'accountant') {                                    // 品牌權限補齊到契約的清單（只補不減）
      const have = db.prepare('SELECT brand_id FROM user_brands WHERE user_id = ?').all(uid).map((x) => x.brand_id);
      const miss = p.brands.filter((b) => !have.includes(b));
      if (miss.length) {
        db.tx(() => { miss.forEach((b) => db.prepare('INSERT INTO user_brands (user_id, brand_id) VALUES (?,?)').run(uid, b)); audit(db, WHO, 'admin_user_update', null, null, { username, brand_ids_added: miss }); });
        sum.brandsFixed.push(`${username}+${miss.join('')}`); io.out(`  ✓ 已補上品牌權限 ${miss.join('、')}`);
      }
    }
  }
  io.out(`\n完成：新建 ${sum.created.length}、重設密碼 ${sum.reset.length}、略過 ${sum.skipped.length}${sum.brandsFixed.length ? '、補品牌 ' + sum.brandsFixed.length : ''}。密碼沒有存到任何地方。`);
  return sum;
}

// ---- 終端機輸入（readline 讀一般文字；密碼用 raw mode 逐字讀、不回顯） ----
function makeTtyIo() {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const askHidden = (q) => new Promise((resolve) => {
    process.stdout.write(q);
    rl.pause();
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.removeListener('data', onData); process.stdout.write('\n'); rl.resume(); return resolve(buf); }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n已中止\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
  return { ask, askHidden, out: (s) => console.log(s), close: () => rl.close() };
}

if (require.main === module) {
  const major = parseInt(process.versions.node, 10);
  if (major < 24) { console.error(`需要 Node 24 以上，目前是 v${process.versions.node}`); process.exit(1); }
  const args = process.argv.slice(2);
  const list = args.includes('--list');
  const oi = args.indexOf('--only'); const only = oi >= 0 ? args[oi + 1] : 'all';
  if (!['all', 'stores', 'accountants', 'admin'].includes(only)) { console.error('--only 只能是 stores／accountants／admin'); process.exit(2); }
  if (!list && !(process.stdin.isTTY && process.stdout.isTTY)) { console.error('請在「終端機」App 直接執行（需要互動輸入密碼）；不要用管線或在 Claude 的工具裡跑。'); process.exit(2); }
  const cfg = loadConfig();
  console.log(`資料夾：${cfg.DATA_DIR}`);
  const db = openDb(cfg.DATA_DIR);
  const io = list ? { ask: async () => '', askHidden: async () => '', out: (s) => console.log(s) } : makeTtyIo();
  run(db, io, { only, list }).then(() => { if (io.close) io.close(); db.close(); process.exit(0); })
    .catch((e) => { console.error('失敗：' + (e && e.message)); process.exit(1); });
}
module.exports = { run, STORES, ACCOUNTANTS };
