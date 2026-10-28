// Builds the VS Code extension into dist/aegis-vscode-<version>.vsix. GitHub Actions runs this (npm run build:vsix).
// It bundles the extension together with the real Aegis checker, so the .vsix has no dependencies.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const VSCE = '@vscode/vsce@3.9.2'; // pinned; fetched on demand, so it is not a dependency of the repo
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('vscode/package.json', 'utf8'));
manifest.version = pkg.version; // one version number for everything
if (pkg.repository) manifest.repository = pkg.repository;

const stage = 'dist/vsix-stage';
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

await build({
  bundle: true,
  logLevel: 'warning',
  legalComments: 'none',
  entryPoints: ['vscode/src/extension.ts'],
  platform: 'node',
  format: 'cjs',
  target: 'node18', // VS Code 1.85 runs extensions on Node 18
  outfile: `${stage}/extension.js`,
  external: ['vscode'],
  define: { __AEGIS_VERSION__: JSON.stringify(pkg.version) },
});

writeFileSync(`${stage}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
cpSync('vscode/syntaxes', `${stage}/syntaxes`, { recursive: true });
for (const f of ['language-configuration.json', 'README.md', '.vscodeignore']) copyFileSync(`vscode/${f}`, `${stage}/${f}`);
copyFileSync('LICENSE', `${stage}/LICENSE`);

const out = `aegis-vscode-${pkg.version}.vsix`;
const args = ['--yes', VSCE, 'package', '--no-dependencies', '--allow-missing-repository', '--out', `../${out}`];
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { cwd: stage, stdio: 'inherit' });
if (r.status !== 0) {
  console.error('vsce failed to package the extension.');
  process.exit(r.status ?? 1);
}
console.log(`built dist/${out}`);
