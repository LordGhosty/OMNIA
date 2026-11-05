const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const files = require('./source-files.json');
const root = path.resolve(__dirname, '..');
const listed = new Set(files);
function check(file) {
  if (!listed.has(file)) throw Error('Unexpected publication file: ' + file);
  const target = path.join(root, file);
  if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target)
    throw Error('Expected a regular source file: ' + file);
}
for (const file of files) check(file);
if (fs.existsSync(path.join(root, '.git'))) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  for (const file of tracked.split('\0').filter(Boolean)) check(file);
}
function inspect(folder) {
  for (const item of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const file = folder + '/' + item.name;
    if (item.isDirectory()) inspect(file);
    else check(file);
  }
}
for (const folder of ['assets', 'web', 'src', 'scripts', 'tests', '.github']) inspect(folder);
console.log('Publication file check passed (' + files.length + ' files).');
