import { build } from 'esbuild';

// Express and its dependency tree are CommonJS and use dynamic require() of
// node builtins. esbuild's ESM output stubs those out unless a real `require`
// exists in scope, so provide one via createRequire.
const banner = [
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);'
].join('\n');

await build({
  entryPoints: ['src/index.ts', 'src/http.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'bundle',
  outdir: 'dist',
  banner: { js: banner },
  logLevel: 'info'
});
