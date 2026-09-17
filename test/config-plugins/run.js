// Uses the community plugins in expo/config-plugins as a test suite.
//
// For each plugin: run the shipping transform and the native-ast equivalent
// over the plugin's own fixture plus variants a real app would have, and
// report where they disagree.
//
//   node test/config-plugins/run.js [native|wasm]
const fs = require('fs');
const path = require('path');
const { parseSwift, useBackend } = require('../../src/index.js');
const ship = require('./shipping.js');
const ast = require('./ast.js');
const fixtures = require('./fixtures.js');

const SHARED = fs.readFileSync(path.join(__dirname, 'AppDelegate-shared.swift'), 'utf8');

function attempt(fn, input) {
  try { return { ok: true, out: fn(input) }; }
  catch (e) { return { ok: false, err: e.message.split('\n')[0] }; }
}

function label(r, checks, src) {
  if (!r.ok) return `THREW  ${r.err.slice(0, 58)}`;
  const failed = Object.entries(checks).filter(([, t]) => !t(r.out, src)).map(([c]) => c);
  return failed.length ? `WRONG  ${failed.join(', ')}` : 'ok';
}

/** Supertypes the input declared, so we can assert none were dropped. */
function supertypesOf(src) {
  const t = parseSwift(src).type('AppDelegate');
  return t ? t.supertypes : [];
}

(async () => {
  await useBackend(process.argv[2] === 'native' ? 'native' : 'wasm', ['swift']);
  console.log(`backend: ${process.argv[2] === 'native' ? 'native' : 'wasm'}\n`);

  /* ---------------- expo-uiscene-lifecycle, enable() ---------------- */
  console.log('expo-uiscene-lifecycle  updateAppDelegate(contents, enabled: true)');
  const uisceneChecks = {
    'adds protocol': (s) => /class AppDelegate: ExpoAppDelegate,.*ExpoReactNativeFactoryProvider/.test(s),
    'removes window setup': (s) => !/window = UIWindow\(frame:/.test(s),
    'removes startReactNative': (s) => !/factory\.startReactNative\(/.test(s),
    // Whatever the input already conformed to must survive.
    'keeps existing protocols': (s, src) =>
      supertypesOf(src).every((p) => supertypesOf(s).includes(p)),
    're-parses': (s) => !parseSwift(s).hasParseErrors,
  };
  let identical = 0, shipFail = 0, astFail = 0;
  for (const [name, src] of Object.entries(fixtures)) {
    const s = attempt((c) => ship.uisceneUpdateAppDelegate(c, true), src);
    const a = attempt(ast.uisceneEnable, src);
    const same = s.ok && a.ok && s.out === a.out;
    if (same) identical++;
    if (!s.ok || Object.values(uisceneChecks).some((t) => !t(s.out, src))) shipFail++;
    if (!a.ok || Object.values(uisceneChecks).some((t) => !t(a.out, src))) astFail++;
    console.log(`  ${name.padEnd(14)} shipping: ${label(s, uisceneChecks, src).padEnd(40)} ast: ${label(a, uisceneChecks, src)}${same ? '   [byte-identical]' : ''}`);
    if (a.ok) {
      const twice = attempt(ast.uisceneEnable, a.out);
      if (!twice.ok || twice.out !== a.out) console.log(`  ${''.padEnd(14)} ast NOT idempotent`);
    }
  }
  console.log(`  -> shipping fails ${shipFail}/${Object.keys(fixtures).length}, ast fails ${astFail}/${Object.keys(fixtures).length}, ${identical} byte-identical\n`);

  /* ---------------- react-native-siri-shortcut ---------------- */
  console.log('react-native-siri-shortcut  addSiriShortcutAppDelegateInit(src, "swift")');
  const siriChecks = {
    'inserts the call': (s) => /RNSSSiriShortcuts\.application\(application, continue: userActivity/.test(s),
    'call precedes the return': (s) => s.indexOf('RNSSSiriShortcuts.application') < s.lastIndexOf('return super.application(application, continue:'),
    're-parses': (s) => !parseSwift(s).hasParseErrors,
  };
  const siriCases = {
    'shared fixture': SHARED,                       // has the universal-links method
    'sdk57 template': fixtures.stock,               // does not
  };
  for (const [name, src] of Object.entries(siriCases)) {
    const s = attempt((c) => ship.siriAddAppDelegateInit(c).contents, src);
    const a = attempt(ast.siriAddInit, src);
    console.log(`  ${name.padEnd(14)} shipping: ${label(s, siriChecks, src).padEnd(40)} ast: ${label(a, siriChecks, src)}`);
    if (a.ok) {
      const twice = attempt(ast.siriAddInit, a.out);
      console.log(`  ${''.padEnd(14)} ast idempotent: ${twice.ok && twice.out === a.out ? 'yes' : 'NO'}`);
    }
  }
  console.log();

  /* ---------------- latent bug: disable() hardcodes the module name ------- */
  console.log('expo-uiscene-lifecycle  updateAppDelegate(contents, enabled: false)');
  // An app already on the scene life cycle whose JS entry point is not "main".
  const sceneWithRenamedModule = ast.uisceneEnable(fixtures.renamedModule);
  const disabled = attempt((c) => ship.uisceneUpdateAppDelegate(c, false), sceneWithRenamedModule);
  if (disabled.ok) {
    const m = disabled.out.match(/withModuleName: "([^"]+)"/);
    console.log(`  restored module name: ${m ? m[1] : '(none restored)'}  — the app registers "HelloWorld"`);
    console.log(`  ${m && m[1] !== 'HelloWorld' ? 'BUG: disable() writes a module name the app does not register' : 'ok'}`);
  } else {
    console.log(`  shipping THREW: ${disabled.err.slice(0, 70)}`);
  }
  console.log();

  /* ---------------- parse conformance over the repo ---------------------- */
  // Two sources of real Swift in expo/config-plugins: .swift fixtures, and
  // Swift embedded in .ts fixtures and jest snapshots. The snapshots are
  // plugin *output*, so parsing those checks the plugins produce valid Swift.
  const root = path.join(process.env.HOME, 'Developer/config-plugins');
  if (!fs.existsSync(root)) {
    console.log('parse conformance: skipped (no ~/Developer/config-plugins checkout)');
    return;
  }
  const { execSync } = require('child_process');
  const find = (pat) => execSync(`find ${root} -name '${pat}' -not -path '*/node_modules/*'`, { encoding: 'utf8' })
    .split('\n').filter(Boolean);

  const samples = [];
  for (const f of find('*.swift')) {
    samples.push({ name: path.relative(root, f), src: fs.readFileSync(f, 'utf8') });
  }
  // Template literals containing a Swift AppDelegate, from .ts and .snap files.
  for (const f of [...find('*.ts'), ...find('*.snap')]) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/`([^`]*class AppDelegate[^`]*)`/g)) {
      let src = m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$');
      // jest snapshots wrap the value in double quotes inside the backticks.
      src = src.replace(/^\s*"/, '').replace(/"\s*$/, '');
      samples.push({ name: `${path.relative(root, f)} (embedded)`, src });
    }
  }

  let bad = 0;
  for (const { name, src } of samples) {
    const parsed = parseSwift(src);
    if (parsed.hasParseErrors) {
      bad++;
      const r = parsed.errorRegions()[0];
      console.log(`  PARSE ERROR  ${name}  line ${r.line} (${r.kind})`);
    }
  }
  console.log(`parse conformance: ${samples.length - bad}/${samples.length} Swift samples in expo/config-plugins parse cleanly`);
  console.log('  (.swift fixtures plus AppDelegate sources embedded in .ts fixtures and jest snapshots)');
})();
