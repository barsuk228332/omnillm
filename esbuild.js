const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

(async () => {
  if (watch) {
    const [extCtx, webCtx] = await Promise.all([
      esbuild.context(extension),
      esbuild.context(webview),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[esbuild] watching...');
    return;
  }
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  console.log('[esbuild] build complete');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
