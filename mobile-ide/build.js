import { build } from 'esbuild';

// 1) Browser client -> public/dist
await build({
  entryPoints: ['client/main.js'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020', 'safari14', 'chrome90'],
  outdir: 'public/dist',
  loader: { '.css': 'css' },
  logLevel: 'info',
});

// 2) Server -> dist/server.mjs: one file with express + ws inside, so phones can
//    run the IDE without `npm install` (which is unreliable under proot).
await build({
  entryPoints: ['server.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/server.mjs',
  // Optional native add-ons: loaded if present, skipped otherwise.
  external: ['node-pty', 'bufferutil', 'utf-8-validate'],
  // Let bundled CommonJS packages call require() for Node built-ins.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
