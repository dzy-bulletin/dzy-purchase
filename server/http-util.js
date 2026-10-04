'use strict';
// HTTP 小工具：錯誤、JSON 回應、請求體讀取、multipart 解析（只用 Node 內建）
const STATUS = { AUTH: 401, LOCKED: 403, FORBIDDEN: 403, PASSWORD_CHANGE_REQUIRED: 403, NOT_FOUND: 404, BAD_INPUT: 400, CONFLICT: 409, RED_FLAGS: 409, INTERNAL: 500 };

class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = STATUS[code] || 500; }
}

function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

// 讀請求體；超過上限回 null（並把剩餘資料丟掉）
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    const chunks = []; let size = 0; let over = Number.isFinite(len) && len > limit;
    req.on('data', (c) => { if (over) return; size += c.length; if (size > limit) { over = true; chunks.length = 0; } else chunks.push(c); });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('aborted')));
  });
}

// multipart/form-data → { fields:{}, files:[{name, filename, type, data}] }
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!m) throw new ApiError('BAD_INPUT', '不是 multipart 請求');
  const delim = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}; const files = [];
  let pos = buf.indexOf(delim);
  if (pos < 0) throw new ApiError('BAD_INPUT', 'multipart 格式錯誤');
  let parts = 0;
  for (;;) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;          // 結尾 --
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) throw new ApiError('BAD_INPUT', 'multipart 格式錯誤');
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), headEnd + 4);
    if (next < 0) throw new ApiError('BAD_INPUT', 'multipart 格式錯誤');
    const data = buf.slice(headEnd + 4, next);
    if (++parts > 30) throw new ApiError('BAD_INPUT', '欄位太多');
    const cd = /content-disposition:[^\r\n]*/i.exec(head);
    const name = cd && /\bname="([^"]*)"/i.exec(cd[0]);
    const fn = cd && /\bfilename="([^"]*)"/i.exec(cd[0]);
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head);
    if (name) {
      if (fn) files.push({ name: name[1], filename: fn[1], type: ct ? ct[1].trim() : '', data });
      else fields[name[1]] = data.toString('utf8');
    }
    pos = next + 2;
  }
  return { fields, files };
}

module.exports = { ApiError, sendJson, readBody, parseMultipart, STATUS };
