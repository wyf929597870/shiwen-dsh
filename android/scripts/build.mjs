import {build} from 'esbuild';
import {mkdir, copyFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'dist'), {recursive: true});
await build({entryPoints: [resolve(root, 'web/main.jsx')], bundle: true, format: 'esm', nodePaths: [resolve(root, 'node_modules')],
  outfile: resolve(root, 'dist/app.js'), target: 'chrome100', minify: true, jsx: 'automatic'});
await copyFile(resolve(root, '../assets/shiwen-mark.png'), resolve(root, 'dist/shiwen-mark.png'));
await writeFile(resolve(root, 'dist/index.html'), `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="theme-color" content="#1d2127"><title>拾文 · Android 验证</title><link rel="stylesheet" href="./app.css">
</head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`);
console.log('Built bundled Android probe UI (no server.url, no remote page).');
