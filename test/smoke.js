// Self-contained smoke test: no local checkouts, no native bindings.
// Verifies the published artifact loads both WASM grammars and edits correctly.
// This is what CI runs before publishing.
const assert = require('assert');
const { parseSwift, parseKotlin, useBackend } = require('../src/index.js');

const SWIFT = `import UIKit

class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return true
  }
}
`;

const KOTLIN = `package com.helloworld

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, false)
}
`;

function swiftTransform(src) {
  const file = parseSwift(src);
  assert.ok(!file.hasParseErrors, 'swift fixture should parse cleanly');
  file.addImport('Expo', { access: 'internal' });
  file.type('AppDelegate')
      .setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] })
      .func('application(_:didFinishLaunchingWithOptions:)')
      .addModifier('override')
      .replaceReturnValue('super.application(application, didFinishLaunchingWithOptions: launchOptions)');
  return file.toString();
}

function kotlinTransform(src) {
  const file = parseKotlin(src);
  assert.ok(!file.hasParseErrors, 'kotlin fixture should parse cleanly');
  const fn = file.type('MainActivity').func('createReactActivityDelegate()');
  assert.ok(fn, 'should resolve createReactActivityDelegate()');

  // `edits.replace` is the raw escape hatch and is NOT idempotent on its own,
  // unlike the named helpers. Wrapping a call is the caller's job to guard, or
  // re-running the plugin double-wraps.
  if (fn.text.includes('ReactActivityDelegateWrapper(')) return src;

  file.addImport('expo.modules.ReactActivityDelegateWrapper');
  const { walk } = require('../src/index.js');
  let call = null;
  walk(fn.body, (n) => {
    if (call) return false;
    if (n.type === 'call_expression' && n.firstChild?.text === 'DefaultReactActivityDelegate') {
      call = n; return false;
    }
  });
  assert.ok(call, 'should find the delegate construction');
  file.edits.replace(
    call.startIndex, call.endIndex,
    `ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, ${call.text})`
  );
  return file.toString();
}

(async () => {
  const backend = process.argv[2] === 'native' ? 'native' : 'wasm';
  await useBackend(backend);
  console.log(`backend: ${backend}`);

  const swift = swiftTransform(SWIFT);
  assert.match(swift, /^internal import Expo$/m);
  assert.match(swift, /class AppDelegate: ExpoAppDelegate \{/);
  assert.match(swift, /override func application\(/);
  assert.match(swift, /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/);
  assert.ok(!parseSwift(swift).hasParseErrors, 'swift output should re-parse');
  assert.strictEqual(swiftTransform(swift), swift, 'swift transform should be idempotent');
  console.log('  swift  ok (5 assertions + idempotent + re-parses)');

  const kotlin = kotlinTransform(KOTLIN);
  assert.match(kotlin, /^import expo\.modules\.ReactActivityDelegateWrapper$/m);
  assert.match(kotlin, /ReactActivityDelegateWrapper\(this, BuildConfig\.IS_NEW_ARCHITECTURE_ENABLED, DefaultReactActivityDelegate\(/);
  assert.ok(!parseKotlin(kotlin).hasParseErrors, 'kotlin output should re-parse');
  assert.strictEqual(kotlinTransform(kotlin), kotlin, 'kotlin transform should be idempotent');
  console.log('  kotlin ok (2 assertions + idempotent + re-parses)');

  // The '#' regression that the scanner-calloc patch fixes.
  const hash = parseSwift('#if DEBUG\nimport UIKit\n#endif\n');
  assert.ok(!hash.hasParseErrors, "'#if' must parse — see scanner-calloc.patch");
  console.log("  swift '#if' ok (scanner-calloc patch present)");

  console.log('smoke: all checks passed');
})();
