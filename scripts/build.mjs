import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/catalog.ts'],
  outfile: 'dist/catalog.cjs',
  bundle: true,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node20',
});
