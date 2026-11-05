const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = crypto.createHash('sha256');
function walk(folder) {
  for (const entry of fs
    .readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      hash.update(file.replaceAll('\\', '/'));
      hash.update(fs.readFileSync(file));
    }
  }
}
for (const folder of ['src', 'web']) walk(folder);
hash.update(fs.readFileSync('assets/tools.json'));
hash.update(fs.readFileSync('package.json'));
fs.writeFileSync('assets/build-id.json', JSON.stringify({ id: hash.digest('hex') }) + '\n');
