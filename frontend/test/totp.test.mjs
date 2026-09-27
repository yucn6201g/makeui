// The authenticator code the L3 smoke test computes (e2e/smoke/totp.ts), against
// the test vectors of RFC 6238 (SHA-1; the six low digits of the eight given there).
//
//   node test/totp.test.mjs      (from frontend/)
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-test/totp.test.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });
await esbuild.build({ entryPoints: [path.join(root, 'e2e/smoke/totp.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out });
const { totp } = await import(pathToFileURL(out).href);

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// The RFC's key is the ASCII "12345678901234567890", which is this in base32.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
for (const [seconds, eight] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
  check(`T=${seconds}`, totp(SECRET, seconds * 1000), eight.slice(2));
}
check('spaces and lower case in the secret are forgiven', totp(SECRET.toLowerCase().replace(/(.{4})/g, '$1 '), 59_000), '287082');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
