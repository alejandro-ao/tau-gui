import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const release = new URL('../release/', import.meta.url);
const roots = await readdir(release, { withFileTypes: true });
const platform = roots.find((entry) => entry.isDirectory());
if (!platform) throw new Error('No packaged platform directory found');
const root = join(release.pathname, platform.name);

const candidates =
  process.platform === 'darwin'
    ? [
        join(root, 'Tau GUI.app', 'Contents', 'MacOS', 'Tau GUI'),
        join(root, 'Tau GUI.app', 'Contents', 'Resources', 'app.asar'),
      ]
    : process.platform === 'win32'
      ? [join(root, 'Tau GUI.exe'), join(root, 'resources', 'app.asar')]
      : [join(root, 'tau-gui'), join(root, 'resources', 'app.asar')];

for (const path of candidates) {
  await access(path, constants.R_OK);
  const info = await stat(path);
  if (!info.isFile() || info.size < 1_024)
    throw new Error(`Packaged artifact is missing or empty: ${path}`);
}
if (process.platform !== 'win32') await access(candidates[0], constants.X_OK);
console.log(`Packaging smoke passed: ${platform.name}`);
