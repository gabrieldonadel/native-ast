const { parseKotlin, useBackend } = require('../src/index.js');
const { vanilla, customized, withCompanion } = require('./fixtures-kotlin.js');

/* ---- 1. the shipping regex implementation ----------------------------------
 * findNewInstanceCodeBlock and addImports are the real ones from
 * @expo/config-plugins. The transform around them is transcribed from
 * install-expo-modules' setModulesMainActivity, because that package publishes
 * only .d.ts files — its build output is not importable. See test/api/ for
 * per-function tests against the real helpers.
 */
const {
  findNewInstanceCodeBlock,
  addImports,
} = require('@expo/config-plugins/build/android/codeMod');

function regexTransform(contents) {
  if (contents.match(/\s+ReactActivityDelegateWrapper\(/m) != null) return contents;
  if (contents.match(/\s+createReactActivityDelegate\(\)/m) == null) {
    throw new Error('no createReactActivityDelegate override (not this code path)');
  }
  if (!contents.match(/\bDefaultReactActivityDelegate\b/g)) return contents;
  contents = addImports(contents, ['expo.modules.ReactActivityDelegateWrapper'], false);
  const block = findNewInstanceCodeBlock(contents, 'DefaultReactActivityDelegate', 'kt');
  if (block == null) throw new Error('Unable to find DefaultReactActivityDelegate new instance code block.');
  const replacement = `ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, ${block.code})`;
  return contents.slice(0, block.start) + replacement + contents.slice(block.end + 1);
}

/* ---- 2. the same transform written against the AST ------------------------ */
function astTransform(contents) {
  const file = parseKotlin(contents);

  // Refuse to touch a file whose relevant region did not parse.
  if (file.hasParseErrors) {
    const regions = file.errorRegions();
    throw new Error(`unparsed region at line ${regions[0].line}; refusing to edit`);
  }

  const activity = file.type('MainActivity');
  if (!activity) throw new Error('no MainActivity class found');

  const fn = activity.func('createReactActivityDelegate()');
  if (!fn) throw new Error('no createReactActivityDelegate() found');

  // Already wrapped?
  const WRAPPER = 'ReactActivityDelegateWrapper';
  if (fn.text.includes(`${WRAPPER}(`)) return contents;           // idempotent

  // Find the delegate construction inside this function only, skipping
  // comments and strings because we are walking the AST, not the text.
  const { walk } = require('../src/index.js');
  let call = null;
  walk(fn.body, (n) => {
    if (call) return false;
    if (n.type === 'call_expression' && n.firstChild?.text === 'DefaultReactActivityDelegate') {
      call = n; return false;
    }
  });
  if (!call) throw new Error('no DefaultReactActivityDelegate(...) construction found');

  file.addImport('expo.modules.ReactActivityDelegateWrapper');
  file.edits.replace(
    call.startIndex,
    call.endIndex,
    `${WRAPPER}(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, ${call.text})`
  );
  return file.toString();
}

/* ---- 3. run both --------------------------------------------------------- */
const checks = {
  'wrapper applied': (s) => /ReactActivityDelegateWrapper\(this, BuildConfig\.IS_NEW_ARCHITECTURE_ENABLED, DefaultReactActivityDelegate\(/.test(s),
  'wrapper import added': (s) => /^import expo\.modules\.ReactActivityDelegateWrapper$/m.test(s),
  'no wrapper inside a comment': (s) => !s.split('\n').some((l) => /^\s*\*/.test(l) && l.includes('ReactActivityDelegateWrapper(this,')),
  'still parses': (s) => !parseKotlin(s).hasParseErrors,
};

(async () => {
  const backend = process.argv[2] === 'wasm' ? 'wasm' : 'native';
  await useBackend(backend, ['kotlin']);
  console.log(`backend: ${backend}\n`);
  for (const [name, src] of Object.entries({ vanilla, customized, withCompanion })) {
    console.log(`=== fixture: ${name} ===`);
    for (const [label, fn] of [['regex', regexTransform], ['ast  ', astTransform]]) {
      let out, error = null;
      try { out = fn(src); } catch (e) { error = e.message; }
      if (error) { console.log(`${label}  THREW: ${error}`); continue; }
      const failed = Object.entries(checks).filter(([, t]) => !t(out)).map(([c]) => `FAIL ${c}`);
      console.log(`${label}  ${failed.length === 0 ? `all ${Object.keys(checks).length} checks pass` : failed.join(' | ')}`);
      const twice = fn(out);
      console.log(`${label}  idempotent: ${twice === out ? 'yes' : 'NO'}`);
    }
    console.log('');
  }
})();
