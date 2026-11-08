import { build } from 'esbuild';

await build({
  entryPoints: ['client/main.js'],
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2020', 'safari14', 'chrome90'],
  outdir: 'public/dist',
  loader: { '.css': 'css' },
  logLevel: 'info',
});
