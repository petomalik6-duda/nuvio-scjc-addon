'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

function materialize() {
  const parts = fs.readdirSync(__dirname)
    .filter((name) => /^scjc\.part\.\d+$/.test(name))
    .sort();
  if (!parts.length) throw new Error('SCJC runtime payload is missing');
  const b64 = parts.map((name) => fs.readFileSync(path.join(__dirname, name), 'utf8').trim()).join('');
  const code = zlib.gunzipSync(Buffer.from(b64, 'base64'));
  const target = path.join(__dirname, '.scjc-runtime.js');
  fs.writeFileSync(target, code);
  return target;
}

function makePreload() {
  const preload = path.join(__dirname, '.scjc-diagnostics.js');
  const src = String.raw`
'use strict';
const realFetch = global.fetch;
function safeUrl(input) {
  try {
    const raw = typeof input === 'string' ? input : input?.url || String(input);
    const u = new URL(raw);
    for (const k of ['password','pass','token','krt','session_id','sessionId','uid','uuid']) {
      if (u.searchParams.has(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.toString();
  } catch { return '[unparseable-url]'; }
}
function summarize(v, depth=0) {
  if (depth > 2 || v == null) return null;
  if (Array.isArray(v)) return { type:'array', count:v.length };
  if (typeof v !== 'object') return { type:typeof v };
  const out = { type:'object', keys:Object.keys(v).slice(0,20) };
  for (const [k,val] of Object.entries(v)) {
    if (Array.isArray(val)) out[k] = { count:val.length };
    else if (val && typeof val === 'object' && depth < 2) out[k] = summarize(val, depth+1);
  }
  return out;
}
if (realFetch) {
  global.fetch = async function(input, init) {
    const url = safeUrl(input);
    const method = (init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const t0 = Date.now();
    try {
      const res = await realFetch(input, init);
      let shape = null;
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) shape = summarize(await res.clone().json());
      } catch {}
      console.log('[UPSTREAM]', JSON.stringify({method,url,status:res.status,ms:Date.now()-t0,shape}));
      return res;
    } catch (e) {
      console.error('[UPSTREAM_ERROR]', JSON.stringify({method,url,ms:Date.now()-t0,error:String(e?.message||e)}));
      throw e;
    }
  };
}
try {
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  http.createServer = function(...args) {
    const server = originalCreateServer.apply(this, args);
    server.prependListener('request', (req) => {
      const u = String(req.url || '').replace(/\/(?:eyJ|[A-Za-z0-9_-]{80,})[^/]*(?=\/|$)/g, '/[config]');
      console.log('[REQUEST]', JSON.stringify({method:req.method,url:u}));
    });
    return server;
  };
} catch {}
`;
  fs.writeFileSync(preload, src);
  return preload;
}

if (require.main === module) {
  const runtime = materialize();
  const preload = makePreload();
  const child = spawn(process.execPath, ['-r', preload, runtime], { stdio: 'inherit', env: process.env });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  module.exports = require(materialize());
}
