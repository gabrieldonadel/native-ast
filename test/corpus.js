// Native vs WASM equivalence + error rate, for either language.
//   node test/corpus.js kotlin '*.kt' ~/Developer/expo ...
const { LANGUAGES, nativeParser, wasmParser } = require('../src/index.js');
const fs = require('fs'), cp = require('child_process');

const lang = process.argv[2];
const pattern = process.argv[3];
const roots = process.argv.slice(4);

function decls(root, L) {
  const out = [];
  (function w(n) {
    if (L.importNodes.includes(n.type)) out.push(`import|${n.text.trim()}`);
    if (L.typeNodes.includes(n.type)) out.push(`type|${L.typeName(n)}|${n.startIndex}-${n.endIndex}`);
    if (L.functionNodes.includes(n.type)) out.push(`func|${L.selector(n)}|${n.startIndex}-${n.endIndex}`);
    for (const c of n.namedChildren) w(c);
  })(root);
  return out.join('\n');
}

(async () => {
  const L = LANGUAGES[lang];
  const np = nativeParser(lang);
  const wp = await wasmParser(lang);

  let files = [];
  for (const r of roots) {
    try {
      files.push(...cp.execSync(
        `find ${r} -name '${pattern}' -not -path '*/build/*' -not -path '*/node_modules/*' -not -path '*/Pods/*' -not -path '*/.git/*'`,
        { maxBuffer: 1 << 28 }).toString().split('\n').filter(Boolean));
    } catch {}
  }

  let total = 0, nErr = 0, treeDiff = 0, declDiff = 0, nMs = 0, wMs = 0, bytes = 0;
  for (const f of files) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (src.length > 500000) continue;
    total++; bytes += src.length;
    const t0 = process.hrtime.bigint(); const a = np.parse(src);
    const t1 = process.hrtime.bigint(); const b = wp.parse(src);
    const t2 = process.hrtime.bigint();
    nMs += Number(t1 - t0) / 1e6; wMs += Number(t2 - t1) / 1e6;
    if (a.rootNode.hasError) nErr++;
    if (a.rootNode.toString() !== b.rootNode.toString()) treeDiff++;
    if (decls(a.rootNode, L) !== decls(b.rootNode, L)) declDiff++;
  }
  console.log(`${lang}  ${pattern}  files=${total}  MB=${(bytes/1e6).toFixed(1)}`);
  console.log(`  native parse errors:     ${nErr} (${(100*nErr/total).toFixed(2)}%)`);
  console.log(`  wasm != native (tree):   ${treeDiff} (${(100*treeDiff/total).toFixed(2)}%)`);
  console.log(`  wasm != native (decls):  ${declDiff} (${(100*declDiff/total).toFixed(2)}%)`);
  console.log(`  native ${nMs.toFixed(0)}ms | wasm ${wMs.toFixed(0)}ms | wasm ${(wMs/nMs).toFixed(2)}x`);
})();
