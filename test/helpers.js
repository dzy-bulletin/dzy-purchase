'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../server/config');
const { makeApp } = require('../server/index');
const { seed } = require('../server/seed-dev');

const PASS = { SEED_PASS_C01: 'pw-c01', SEED_PASS_M01: 'pw-m01', SEED_PASS_ACC_C: 'pw-accc', SEED_PASS_ACC_M: 'pw-accm', SEED_PASS_ADMIN: 'pw-admin' };
const FAKE_JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')]);
let n = 0;
const uuid = () => { const h = (k) => Array.from({ length: k }, () => Math.floor(Math.random() * 16).toString(16)).join(''); return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`; };

async function startApp(opts) {
  opts = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purchase-test-'));
  const cfg = Object.assign(loadConfig({ DATA_DIR: dir, WORKER: '0', RETRY_DELAY_MS: '1', PORT: '0' }), opts.cfg || {});
  const app = makeApp(cfg, { recognize: opts.recognize, now: opts.now });
  seed(app.db, PASS);
  const addr = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${addr.port}/purchase/api`;
  const call = async (method, p, { token, body, raw, headers } = {}) => {
    const h = Object.assign({}, headers || {});
    if (token) h.Authorization = 'Bearer ' + token;
    let b = raw;
    if (body !== undefined && method !== 'GET') { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const r = await fetch(base + p, { method, headers: h, body: b });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) { const j = await r.json(); return Object.assign({ status: r.status }, j); }
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), type: ct };
  };
  const login = async (account, pw) => { const r = await call('POST', '/login', { body: { account, password: pw } }); return r.ok ? r.data.token : null; };
  const upload = async (token, { clientId, vendor_id, vendor_name, photos = 1 } = {}) => {
    const bd = '----t' + Math.random().toString(16).slice(2);
    const parts = [];
    const field = (k, v) => parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    field('client_id', clientId || uuid());
    if (vendor_id !== undefined) field('vendor_id', vendor_id);
    if (vendor_name !== undefined) field('vendor_name', vendor_name);
    for (let i = 0; i < photos; i++) {
      parts.push(Buffer.from(`--${bd}\r\nContent-Disposition: form-data; name="photos[]"; filename="p${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.concat([FAKE_JPG, Buffer.from(String(++n))]), Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${bd}--\r\n`));
    return call('POST', '/slips', { token, raw: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${bd}` } });
  };
  return { app, dir, cfg, base, call, login, upload, close: () => app.close().then(() => fs.rmSync(dir, { recursive: true, force: true })) };
}
module.exports = { startApp, PASS, uuid, FAKE_JPG };
