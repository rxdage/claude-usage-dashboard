// Guard against the v1.10.0 incident: a local module required by the main
// process but missing from electron-builder's `build.files` whitelist packs
// fine, runs fine in dev, and then crashes the INSTALLED app at startup with
// "Cannot find module". Statically verify every local require is packaged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = pkg.build.files;

function packaged(rel) {
  // covered if listed exactly, or under a listed `dir/**` glob
  if (files.includes(rel)) return true;
  return files.some((f) => f.endsWith('/**') && rel.startsWith(f.slice(0, -2)));
}

function localRequires(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const out = [];
  for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
    let rel = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), m[1]),
    );
    if (!/\.(js|json|node)$/.test(rel)) rel += '.js';
    out.push(rel);
  }
  return out;
}

test('every local module reachable from the entry points is in build.files', () => {
  const seen = new Set();
  const queue = ['main.js', 'preload.js', 'calibrate.js'];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    assert.ok(packaged(f), `${f} is required at runtime but missing from build.files`);
    for (const dep of localRequires(f)) queue.push(dep);
  }
  // sanity: the walk actually traversed the app, not just the entry list
  assert.ok(seen.has('providers.js'));
  assert.ok(seen.has('dock.js'));
});
