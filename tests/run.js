// Test runner: `node tests/run.js` runs the offline unit tests. Uses only Node's built-in node:test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, 'unit');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(path.join(dir, f)).href);
}
