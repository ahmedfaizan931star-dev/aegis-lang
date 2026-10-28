// Runs every built test file (dist/test*.mjs). Written as a script so it behaves the same on Node 20 and 22, on any OS.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('dist')
  .filter((f) => /^test.*\.mjs$/.test(f))
  .sort()
  .map((f) => `dist/${f}`);
if (!files.length) {
  console.error('No built tests found in dist/. Run: npm run build');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
