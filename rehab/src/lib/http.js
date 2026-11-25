'use strict';

/** 统一的 JSON 响应；Cache-Control: no-store 避免浏览器缓存接口数据 */
function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

/** 读取并解析 JSON 请求体，超过上限直接拒绝 */
function readJson(req, maxBody) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBody) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(h) {
  const out = {};
  (h || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/** 业务异常：handler 里 throw，由统一出口转成 400 */
class BizError extends Error {
  constructor(message, code = 400) {
    super(message);
    this.code = code;
    this.isBiz = true;
  }
}

function fail(res, err) {
  const code = (err && err.code) || 500;
  return json(res, code, { ok: false, err: (err && err.message) || '服务器错误' });
}

module.exports = { json, readJson, parseCookies, BizError, fail };
