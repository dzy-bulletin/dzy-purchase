'use strict';
// P4：create-accounts.js 互動核心（注入假輸入；全部虛構密碼）
const test = require('node:test');
const assert = require('node:assert');
const { openDb } = require('../server/db');
const { verifyPassword } = require('../server/auth');
const { run } = require('../server/tools/create-accounts');

const mkIo = (answers, hidden) => { const out = []; return { out: (s) => out.push(s), ask: async () => (answers.length ? answers.shift() : ''), askHidden: async () => hidden.shift(), lines: out }; };

test('P4 create-accounts：建立 5 門市＋2 會計＋admin；會計品牌 C＋X／M；密碼不出現在輸出；重跑冪等', async () => {
  const db = openDb(':memory:');
  const pws = []; for (let i = 0; i < 8; i++) pws.push('pw-test-' + i, 'pw-test-' + i);   // 每個帳號輸入兩次
  const io = mkIo(['acc-a', '測試會計甲', 'acc-b', '測試會計乙', 'adm1', '測試管理者'], pws);
  const r = await run(db, io, {});
  assert.deepStrictEqual(r.created, ['CF', 'MDGF', 'MZTGF', 'MZTZS', 'MZTLZL', 'acc-a', 'acc-b', 'adm1']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM stores').get().c, 5);
  assert.strictEqual(db.prepare("SELECT brand_id FROM stores WHERE code='MDGF'").get().brand_id, 'X');
  assert.strictEqual(db.prepare("SELECT brand_id FROM stores WHERE code='CF'").get().brand_id, 'C');
  const wu = db.prepare("SELECT * FROM users WHERE username='acc-a'").get();
  assert.deepStrictEqual(db.prepare('SELECT brand_id FROM user_brands WHERE user_id=? ORDER BY brand_id').all(wu.id).map((x) => x.brand_id), ['C', 'X']);
  assert.strictEqual(wu.brand_id, 'C'); assert.strictEqual(wu.name, '測試會計甲');
  const zh = db.prepare("SELECT * FROM users WHERE username='acc-b'").get();
  assert.deepStrictEqual(db.prepare('SELECT brand_id FROM user_brands WHERE user_id=?').all(zh.id).map((x) => x.brand_id), ['M']);
  assert.strictEqual(db.prepare("SELECT role, brand_id FROM users WHERE username='adm1'").get().role, 'admin');
  assert.ok(verifyPassword('pw-test-0', db.prepare("SELECT pass_hash FROM stores WHERE code='CF'").get().pass_hash));
  assert.ok(!io.lines.join('\n').includes('pw-test-'), '輸出不得含密碼');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('pw-test-'), 'audit 不得含密碼');
  // 重跑：全部「已存在」，預設跳過（不問密碼）
  const io2 = mkIo(['', '', '', '', '', 'acc-a', 'n', 'acc-b', 'n', 'adm1', 'n'], []);
  const r2 = await run(db, io2, {});
  assert.deepStrictEqual(r2.created, []); assert.strictEqual(r2.skipped.length, 8);
  // 重設其中一個（CF 答 y，其餘 N）
  const io3 = mkIo(['y'], ['new-pass-1', 'new-pass-1']);
  const r3 = await run(db, io3, { only: 'stores' });
  assert.deepStrictEqual(r3.reset, ['CF']);
  assert.ok(verifyPassword('new-pass-1', db.prepare("SELECT pass_hash FROM stores WHERE code='CF'").get().pass_hash));
  db.close();
});

test('P4 create-accounts：密碼太短或兩次不一致會重問；--list 不問密碼；缺品牌權限會補', async () => {
  const db = openDb(':memory:');
  const io = mkIo(['n'], ['123', 'good-pass-1', 'oops-pass-1', 'good-pass-1', 'good-pass-1']);   // CF：太短→重問；兩次不一致→重問；最後一致
  await run(db, io, { only: 'stores' }).catch(() => {});
  assert.ok(io.lines.some((l) => l.includes('至少')) && io.lines.some((l) => l.includes('兩次不一樣')));
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM stores WHERE code='CF'").get().c, 1);
  const lst = mkIo([], []); await run(db, lst, { list: true });
  assert.ok(lst.lines.some((l) => l.startsWith('  CF') && l.includes('已建立')) && lst.lines.some((l) => l.includes('MDGF') && l.includes('尚未建立')));
  // 既有單品牌 acc-a → 補上 X
  db.prepare("INSERT INTO users (username, role, brand_id, name, pass_hash) VALUES ('acc-a','accountant','C','測試會計甲','x')").run();
  const uid = db.prepare("SELECT id FROM users WHERE username='acc-a'").get().id;
  db.prepare("INSERT INTO user_brands (user_id, brand_id) VALUES (?, 'C')").run(uid);
  const io2 = mkIo(['acc-a', 'n', '', 'acc-b2', '乙'], ['pw-b-1', 'pw-b-1']);
  const r = await run(db, io2, { only: 'accountants' });
  assert.deepStrictEqual(r.brandsFixed, ['acc-a+X']);
  db.close();
});

test('P4 create-accounts：建門市時代號與既有帳號名稱相同 → 略過', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO brands (id,name) VALUES ('C','央廚') ON CONFLICT DO NOTHING").run();
  db.prepare("INSERT INTO users (username, role, name, pass_hash) VALUES ('cf','admin','x','x')").run();
  const hid = []; for (let i = 0; i < 4; i++) hid.push('pw-other-1', 'pw-other-1');
  const io = mkIo([], hid);
  const r = await run(db, io, { only: 'stores' });
  assert.ok(r.skipped.includes('CF') && !r.created.includes('CF'));
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM stores WHERE code='CF'").get().c, 0);
  db.close();
});

// 真 pty：用 expect 啟動真正的工具，輸入密碼，斷言畫面輸出不含密碼（沒有 expect 或非 macOS/Linux 就 skip）
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const hasExpect = spawnSync('which', ['expect']).status === 0;
test('P4 create-accounts：真 pty 下密碼不回顯（expect）', { skip: !hasExpect && '沒有 expect' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-pty-'));
  const script = path.join(dir, 't.exp'); const log = path.join(dir, 'out.txt');
  const pw = 'PTY-secret-Zq7';
  fs.writeFileSync(script, `
set timeout 20
log_file -noappend ${log}
spawn ${process.execPath} ${path.resolve(__dirname, '../server/tools/create-accounts.js')} --only admin
expect "帳號"
send "pty-admin\\r"
expect "姓名"
send "測試管理者\\r"
expect "密碼"
send "${pw}\\r"
expect "再輸入一次"
send "${pw}\\r"
expect "完成"
expect eof
`);
  const r = spawnSync('expect', [script], { env: { ...process.env, DATA_DIR: dir, PURCHASE_NO_DOTENV: '1' }, encoding: 'utf8', timeout: 40000 });
  const out = fs.readFileSync(log, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, 'expect 結束碼：' + r.stderr);
  assert.ok(out.includes('已建立 pty-admin'), '工具要真的跑完：' + out.slice(-300));
  assert.ok(!out.includes(pw), '畫面輸出不得含密碼');
  assert.ok(!out.includes('PTY-'), '畫面輸出不得含密碼片段');
});

// raw mode 輸入細節：\r\n 算一次 Enter、方向鍵 ESC 序列忽略、Ctrl-D 空輸入取消
function runPty(steps, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-pty-'));
  const script = path.join(dir, 't.exp'); const log = path.join(dir, 'out.txt');
  fs.writeFileSync(script, `
set timeout 20
log_file -noappend ${log}
spawn ${process.execPath} ${path.resolve(__dirname, '../server/tools/create-accounts.js')} --only admin
${steps}
expect eof
catch wait result
exit [lindex $result 3]
`);
  const r = spawnSync('expect', [script], { env: { ...process.env, DATA_DIR: dir, PURCHASE_NO_DOTENV: '1' }, encoding: 'utf8', timeout: 40000 });
  const out = fs.readFileSync(log, 'utf8'); fs.rmSync(dir, { recursive: true, force: true });
  return { r, out };
}
test('P4 create-accounts：\\r\\n 一次 Enter、方向鍵忽略（expect）', { skip: !hasExpect && '沒有 expect' }, () => {
  const { r, out } = runPty(`
expect "帳號"
send "pty-a\\033\\[Dmin\\r\\n"
expect "姓名"
send "N\\033\\[A\\033OAame\\r\\n"
expect "密碼"
send "Abc123x\\r\\n"
expect "再輸入一次"
send "Abc123x\\r\\n"
expect "完成"`);
  assert.strictEqual(r.status, 0, out.slice(-300));
  assert.ok(out.includes('已建立 pty-amin'), '方向鍵序列要被忽略、CRLF 不多吃一次 Enter：' + out.slice(-400));
});
test('P4 create-accounts：Ctrl-D 空輸入取消（結束碼 130）（expect）', { skip: !hasExpect && '沒有 expect' }, () => {
  const { r, out } = runPty(`
expect "帳號"
send "\\004"`);
  assert.strictEqual(r.status, 130, out.slice(-300));
  assert.ok(out.includes('已中止'));
});
