// The .wasm artifacts are built from grammars/ (our forks, pinned as
// submodules). The native backend used for diffing comes from the npm grammar
// packages. If those drift apart, "WASM matches native" stops meaning anything.
// This asserts they are the same grammar version.
//
// Skips when the submodules are not checked out, since a plain `npm i` clone
// does not need them — the .wasm files are committed.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PAIRS = [
  { lang: 'swift', sub: 'grammars/tree-sitter-swift', npm: 'tree-sitter-swift' },
  { lang: 'kotlin', sub: 'grammars/tree-sitter-kotlin', npm: '@tree-sitter-grammars/tree-sitter-kotlin' },
];

let checked = 0;
for (const { lang, sub, npm } of PAIRS) {
  const subPkg = path.join(__dirname, '..', sub, 'package.json');
  if (!fs.existsSync(subPkg)) {
    console.log(`${lang.padEnd(7)} submodule not checked out — skipping`);
    continue;
  }
  const subVersion = JSON.parse(fs.readFileSync(subPkg, 'utf8')).version;
  let npmVersion;
  try { npmVersion = require(`${npm}/package.json`).version; }
  catch { console.log(`${lang.padEnd(7)} npm grammar not installed — skipping`); continue; }

  assert.strictEqual(
    subVersion, npmVersion,
    `${lang}: submodule ${sub} is ${subVersion} but npm ${npm} is ${npmVersion}. ` +
    `The native backend and the .wasm would be different grammars, so the ` +
    `equivalence tests would compare nothing. Align them.`
  );
  console.log(`${lang.padEnd(7)} submodule ${subVersion} == npm ${npmVersion}`);
  checked++;
}

// The Swift fork carries the scanner fix; assert it is actually there.
const swiftScanner = path.join(__dirname, '..', 'grammars/tree-sitter-swift/src/scanner.c');
if (fs.existsSync(swiftScanner)) {
  const src = fs.readFileSync(swiftScanner, 'utf8');
  assert.ok(
    src.includes('calloc(1, sizeof(struct ScannerState))'),
    'grammars/tree-sitter-swift is missing the scanner calloc fix — is the submodule on the fork\'s native-ast branch?'
  );
  console.log('swift   fork carries the scanner calloc fix');
}

console.log(`grammar-sync: ${checked} pair(s) verified`);
