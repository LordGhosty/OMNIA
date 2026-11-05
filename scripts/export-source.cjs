const fs = require('node:fs');
const path = require('node:path');
const files = require('./source-files.json');

function exportSource(directory) {
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(directory);
  fs.mkdirSync(output, { recursive: false });
  for (const name of files) {
    const source = path.join(root, name);
    if (!fs.lstatSync(source).isFile() || fs.realpathSync(source) !== source)
      throw Error('Expected a regular source file: ' + name);
    const copy = path.join(output, name);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    if (name === '.gitignore')
      fs.writeFileSync(copy, '/node_modules/\n/vendor/\n/release/\n/.qa/\n*.log\n', { flag: 'wx' });
    else fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
  }
  console.log('Exported ' + files.length + ' source files to ' + output);
}
if (require.main === module) {
  if (process.argv.length !== 3) throw Error('Supply a new, empty destination path.');
  exportSource(process.argv[2]);
}
module.exports = { exportSource };
