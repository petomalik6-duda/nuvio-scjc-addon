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

if (require.main === module) {
  const child = spawn(process.execPath, [materialize()], { stdio: 'inherit', env: process.env });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  module.exports = require(materialize());
}
