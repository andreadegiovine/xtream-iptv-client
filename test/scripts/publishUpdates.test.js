const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { filesManifest } = require('../../scripts/publish-updates.js');

test('files.json lists the scripts and stylesheets, and every file with its SHA-256 (fonts too)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xi-publish-'));
  ['js', 'css', 'fonts'].forEach((sub) => fs.mkdirSync(path.join(dir, sub)));
  fs.writeFileSync(path.join(dir, 'js', 'main.js'), 'main');
  fs.writeFileSync(path.join(dir, 'css', 'main.css'), 'css');
  fs.writeFileSync(path.join(dir, 'fonts', 'inter.woff2'), 'font');
  const manifest = filesManifest(dir, ['js/main.js', 'css/main.css']);
  expect(manifest.files).toEqual(['css/main.css', 'js/main.js']);
  expect(manifest.all).toEqual([
    { path: 'css/main.css', sha256: crypto.createHash('sha256').update('css').digest('hex') },
    { path: 'fonts/inter.woff2', sha256: crypto.createHash('sha256').update('font').digest('hex') },
    { path: 'js/main.js', sha256: crypto.createHash('sha256').update('main').digest('hex') },
  ]);
});
