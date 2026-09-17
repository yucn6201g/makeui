// Walks stored outputs again in a local browser, with the walk the pipeline runs today. No model calls.
//
//   node scripts/replay-walk.mjs [--out <dir>] [--serve <port>] <doc>...
//
//   <doc>  a local project document (.html, fenced transport)
//          s3://<bucket>/<key>
//          job:<jobId>        the stored result of a job (jobs/<id>/pages/result.html)
//          label:<prefix>     every job-<prefix>-*.json that compare-generate.mjs wrote
//
// Writes, per document, the runnable page the preview builds and the walk
// expression for its declared screens, then replay.html: a page that loads each
// one in a 1440x900 iframe, runs the walk inside it, and prints what the
// pipeline would have recorded — fill and what hid a screen, unstyled navs,
// oversized icons, the shell layout, controls that threw, and whether the walk
// ran out of time. The results are also left on `window.__replay`.
//
// Why this exists: fixing a runtime finding without first re-walking stored
// outputs has repeatedly meant fixing the walk's own false positives
// (action-dead-runtime was ~80% the walk's error). On 2026-09-14 this replay was
// assembled by hand more than ten times — to check screen-hidden, nav-unstyled,
// the shell layout and two false composition findings against real pages.
//
// Needs a browser to open the page: `--serve 8780` starts a static server and
// prints the URL. Open it in any browser (or the Claude browser pane) and wait
// for "done".
import { outputsBucket } from './lib/aws-env.mjs';
import { execFileSync, execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); if (i === -1) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const outDir = path.resolve(opt('out') ?? path.join(os.tmpdir(), 'makeui-replay'));
const port = opt('serve');
if (args.length === 0) {
  console.error('usage: node scripts/replay-walk.mjs [--out <dir>] [--serve <port>] <doc|s3://…|job:<id>|label:<prefix>>...');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// The pipeline's own code, bundled once.
const entry = path.join(root, 'dist/replay-walk-entry.ts');
const bundle = path.join(root, 'dist/replay-walk.probe.mjs');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(entry, [
  "export { toRunnableDocument } from '../src/tools/react-bundle.js'",
  "export { walkExpression } from '../src/tools/browser-verify.js'",
  "export { declaredScreenIds } from '../src/orchestration/interaction-audit.js'",
  "export { readProjectFiles } from '../src/tools/project-transport.js'",
  "export { detectKind } from '../src/tools/framework-compile.js'",
].join('\n'));
execSync(`npx esbuild "${entry}" --bundle --platform=node --format=esm --outfile="${bundle}" --external:@aws-sdk/* --external:@smithy/* --external:@strands-agents/* --loader:.txt=text --log-level=error`, { cwd: root, stdio: 'inherit' });
const m = await import(pathToFileURL(bundle).href);

/** Every input, as [name, local path]. */
function resolveInputs() {
  const out = [];
  const s3 = (key, name) => {
    const local = path.join(outDir, `${name}.src.html`);
    execFileSync('aws', ['s3', 'cp', `s3://${outputsBucket()}/${key}`, local, '--region', REGION, '--only-show-errors'], { stdio: 'inherit' });
    out.push([name, local]);
  };
  for (const a of args) {
    if (a.startsWith('s3://')) {
      const [, bucket, ...rest] = a.slice(5).split('/');
      // Only the account's own outputs bucket is read, so the key is everything after the bucket name.
      s3(rest.join('/'), path.basename(a, '.html'));
    } else if (a.startsWith('job:')) {
      const id = a.slice(4);
      s3(`jobs/${id}/pages/result.html`, id);
    } else if (a.startsWith('label:')) {
      const prefix = a.slice(6);
      const dir = path.join(os.tmpdir(), 'makeui-compare');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (f.startsWith(`job-${prefix}-`) && f.endsWith('.json')) {
          const id = f.slice(4, -5);
          s3(`jobs/${id}/pages/result.html`, id);
        }
      }
    } else {
      out.push([path.basename(a, '.html'), path.resolve(a)]);
    }
  }
  return out;
}

const pages = [];
for (const [name, file] of resolveInputs()) {
  const html = fs.readFileSync(file, 'utf8');
  const kind = m.detectKind(m.readProjectFiles(html).keys());
  if (!kind) { console.log(`${name}: not a project document, skipped`); continue; }
  const run = m.toRunnableDocument(html, kind);
  if (run.error) { console.log(`${name}: does not compile — ${String(run.error).slice(0, 160)}`); continue; }
  const slug = `${String(pages.length + 1).padStart(2, '0')}-${name.replace(/[^\w.-]+/g, '_').slice(0, 60)}`;
  fs.writeFileSync(path.join(outDir, `${slug}.html`), run.html);
  fs.writeFileSync(path.join(outDir, `${slug}.walk.txt`), m.walkExpression(m.declaredScreenIds(html)));
  pages.push({ slug, name, kind });
  console.log(`${slug}: ${kind}`);
}
fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(pages, null, 1));

fs.writeFileSync(path.join(outDir, 'replay.html'), `<!DOCTYPE html><meta charset="utf-8"><title>replay-walk</title>
<style>body{font:13px/1.5 system-ui,sans-serif;margin:16px}pre{white-space:pre-wrap}iframe{position:absolute;left:-9999px}</style>
<p id="status">running…</p><pre id="out"></pre>
<script>
(async () => {
  const pages = await (await fetch('index.json')).json();
  const results = [];
  const out = document.getElementById('out');
  for (const p of pages) {
    const f = document.createElement('iframe');
    f.style.width = '1440px'; f.style.height = '900px';
    document.body.appendChild(f);
    const row = { page: p.slug };
    try {
      await new Promise((res) => { f.onload = res; f.src = p.slug + '.html'; setTimeout(res, 8000); });
      await new Promise((r) => setTimeout(r, 1200));
      const src = await (await fetch(p.slug + '.walk.txt')).text();
      let r = await Promise.race([f.contentWindow.eval(src), new Promise((res) => setTimeout(() => res(null), 40000))]);
      if (typeof r === 'string') r = JSON.parse(r);
      if (!r) row.error = 'walk did not return';
      else {
        const layouts = r.screens.map((s) => s.layout).filter(Boolean);
        Object.assign(row, {
          truncated: r.truncated,
          screens: r.screens.map((s) => s.id + ':' + s.fill.toFixed(2) + (s.hiddenBy ? ' [' + s.hiddenBy + ']' : '')),
          unstyledNav: [...new Set(r.screens.flatMap((s) => s.unstyledNav || []))],
          oversizedIcons: [...new Set(r.screens.flatMap((s) => s.oversizedIcons || []))],
          layout: layouts.length ? {
            header: (layouts.find((l) => l.header) || {}).header || null,
            sideNavWidth: Math.max(...layouts.map((l) => l.sideNavWidth || 0)),
            bottomNav: layouts.some((l) => l.bottomNav), topNav: layouts.some((l) => l.topNav),
            fab: layouts.some((l) => l.fab), breadcrumb: layouts.some((l) => l.breadcrumb),
            navItems: Math.max(...layouts.map((l) => l.navItems || 0)),
          } : null,
          threw: r.nav.filter((n) => n.threw && n.threw.length).map((n) => n.label + ': ' + n.threw[0]).slice(0, 3),
        });
      }
    } catch (e) { row.error = String(e); }
    f.remove();
    results.push(row);
    out.textContent = results.map((x) => JSON.stringify(x)).join('\\n');
  }
  window.__replay = results;
  document.getElementById('status').textContent = 'done — ' + results.length + ' page(s)';
})();
</script>`);

console.log(`\n${pages.length} page(s) in ${outDir}`);
if (!port) {
  console.log('Serve the folder and open replay.html, or rerun with --serve <port>.');
} else {
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
  http.createServer((req, res) => {
    const file = path.join(outDir, decodeURIComponent((req.url || '/').split('?')[0].replace(/^\/+/, '') || 'replay.html'));
    if (!file.startsWith(outDir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(Number(port), '127.0.0.1', () => console.log(`open http://127.0.0.1:${port}/replay.html`));
}
