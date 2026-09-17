const { parseSwift, useBackend } = require('../src/index.js');
const { vanilla, customized, withConditionalDecl } = require('./fixtures.js');

/* ---------- 1. the shipping regex implementation (copied from expo/main) ---------- */
function addSwiftImports(source, imports) {
  const lines = source.split('\n');
  const i = lines.findIndex((l) => l.match(/^import .*$/));
  for (const imp of imports) if (!source.includes(imp)) lines.splice(i + 1, 0, `import ${imp}`);
  return lines.join('\n');
}
function regexTransform(contents) {
  if (!contents.match(/^(internal\s+)?import\s+Expo\s*$/m)) {
    contents = addSwiftImports(contents, ['Expo']);
    contents = contents.replace(/^import Expo$/m, 'internal import Expo');
  }
  contents = contents.replace(
    /^(class\s+AppDelegate\s*:\s*)UIResponder,\s*UIApplicationDelegate(\W+)/m,
    '$1ExpoAppDelegate$2'
  );
  contents = contents.replace(
    /\b(func application\([\s\S]+?didFinishLaunchingWithOptions launchOptions[\s\S]+?\{[\s\S]+?)(return true)([\s\S]+?\})/m,
    'override $1return super.application(application, didFinishLaunchingWithOptions: launchOptions)$3'
  );
  contents = contents.replace(/\b(RCTReactNativeFactory)(\()/, 'ExpoReactNativeFactory$2');
  contents = contents.replace(/\bRCTDefaultReactNativeFactoryDelegate\b/, 'ExpoReactNativeFactoryDelegate');
  contents = contents.replace(
    /(\boverride.*\ssourceURL\(.*\{[\s\S]+?)(\s+self\.bundleURL\(\))/m,
    `$1
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()`
  );
  return contents;
}

/* ---------- 2. the same transform written against the AST ---------- */
function astTransform(contents) {
  const file = parseSwift(contents);

  file.addImport('Expo', { access: 'internal' });

  const appDelegate = file.type('AppDelegate');
  if (!appDelegate) throw new Error('no AppDelegate class found');
  appDelegate.setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] });

  const didFinishLaunching = appDelegate
    .functions()
    .find((f) => f.selector?.startsWith('application(_:didFinishLaunchingWithOptions:'));
  if (!didFinishLaunching) throw new Error('no application(_:didFinishLaunchingWithOptions:) found');

  // The real parameter name, whatever the developer called it.
  const launchOptionsParam = didFinishLaunching.node.namedChildren
    .filter((c) => c.type === 'parameter')
    .find((c) => c.childForFieldName('external_name')?.text === 'didFinishLaunchingWithOptions');
  const optionsName = launchOptionsParam?.childForFieldName('name')?.text ?? 'launchOptions';

  didFinishLaunching.addModifier('override');
  didFinishLaunching.replaceReturnValue(
    `super.application(application, didFinishLaunchingWithOptions: ${optionsName})`
  );

  const delegate = file.type('ReactNativeDelegate');
  if (delegate) {
    delegate.setSupertype('ExpoReactNativeFactoryDelegate');
    const sourceURL = delegate.func('sourceURL(for:)');
    if (sourceURL) sourceURL.replaceReturnValue('bridge.bundleURL ?? bundleURL()');
  }
  return file.toString();
}

/* ---------- 3. run both on each fixture ---------- */
const checks = {
  'superclass is ExpoAppDelegate': (s) => /class AppDelegate: ExpoAppDelegate/.test(s),
  'didFinishLaunching is override': (s) => /override func application\(/.test(s) || /override\s+func application/.test(s),
  'calls super.application(...)': (s) => /return super\.application\(application, didFinishLaunchingWithOptions:/.test(s),
  'imports Expo': (s) => /^internal import Expo$/m.test(s),
  'delegate superclass swapped': (s) => /class ReactNativeDelegate: ExpoReactNativeFactoryDelegate/.test(s),
};

(async () => {
const backend = process.argv[2] === 'wasm' ? 'wasm' : 'native';
await useBackend(backend, ['swift']);
console.log(`backend: ${backend}`);
for (const [name, src] of Object.entries({ vanilla, customized, withConditionalDecl })) {
  console.log(`\n=== fixture: ${name} ===`);
  for (const [label, fn] of [['regex', regexTransform], ['ast  ', astTransform]]) {
    let out, error = null;
    try { out = fn(src); } catch (e) { error = e.message; }
    if (error) { console.log(`${label}  THREW: ${error}`); continue; }
    const results = Object.entries(checks).map(([c, t]) => `${t(out) ? 'PASS' : 'FAIL'} ${c}`);
    const failed = results.filter((r) => r.startsWith('FAIL'));
    console.log(`${label}  ${failed.length === 0 ? 'all 5 checks pass' : failed.join(' | ')}`);
    // idempotency: running the transform twice must be a no-op
    const twice = fn(out);
    console.log(`${label}  idempotent: ${twice === out ? 'yes' : 'NO'}`);
  }
}
})();
