// Swift: what a config plugin used to do with @expo/config-plugins'
// ios/codeMod.ts, and what it does with native-ast instead.
//
// The `regex:` tests call the real shipping functions and pin their actual
// behaviour — including where that behaviour is wrong. If config-plugins ever
// fixes one of these, the test fails and we find out.
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const codeMod = require('@expo/config-plugins/build/ios/codeMod');
const { parseSwift, walk } = require('../../src/index.js');
const { initBackend, SWIFT_APP_DELEGATE: SRC } = require('./helpers.js');

before(initBackend);

describe('addSwiftImports  ->  file.addImport', () => {
  it('regex: silently skips the import when the module name is a substring of something else', () => {
    // The guard is `source.includes('Expo')`, and `ExpoAppDelegate` contains it.
    const out = codeMod.addSwiftImports('import UIKit\nclass A: ExpoAppDelegate {}\n', ['Expo']);
    assert.ok(!/^import Expo$/m.test(out), 'expected the shipping helper to no-op');
    assert.strictEqual(out, 'import UIKit\nclass A: ExpoAppDelegate {}\n');
  });

  it('regex: silently skips the import when the module is only named in a comment', () => {
    const src = 'import UIKit\n// TODO: migrate to ExpoModulesCore\n';
    assert.strictEqual(codeMod.addSwiftImports(src, ['ExpoModulesCore']), src);
  });

  it('ast: adds the import, because it compares against parsed import declarations', () => {
    const file = parseSwift('import UIKit\nclass A: ExpoAppDelegate {}\n');
    file.addImport('Expo');
    assert.match(file.toString(), /^import Expo$/m);
  });

  it('ast: is a no-op when the import really is present', () => {
    const src = 'import UIKit\nimport Expo\nclass A {}\n';
    const file = parseSwift(src);
    file.addImport('Expo');
    assert.strictEqual(file.toString(), src);
  });

  it('ast: supports Swift 6 access modifiers on imports', () => {
    const file = parseSwift('import UIKit\n');
    file.addImport('Expo', { access: 'internal' });
    assert.match(file.toString(), /^internal import Expo$/m);
  });
});

describe('findSwiftFunctionCodeBlock  ->  file.func(selector)', () => {
  it('regex: resolves overloads by parameter count only, so it returns the wrong one', () => {
    // codeMod.ts compares argument labels in a loop whose mismatch branch is
    // `continue`, which advances the label loop instead of rejecting the
    // candidate. Only arity is effectively checked, and both of these take 3.
    const open = codeMod.findSwiftFunctionCodeBlock(SRC, 'application(_:open:options:)');
    const cont = codeMod.findSwiftFunctionCodeBlock(SRC, 'application(_:continue:restorationHandler:)');
    assert.ok(open && cont);
    assert.strictEqual(cont.code, open.code, 'expected both selectors to return the same body');
    assert.match(cont.code, /open: url/, 'and that body is the open:options: one');
    assert.doesNotMatch(cont.code, /continue: userActivity/);
  });

  it('regex: matches a function that is commented out', () => {
    const src = 'class A {\n  // func target() { old implementation }\n  func other() { real() }\n}\n';
    const block = codeMod.findSwiftFunctionCodeBlock(src, 'target()');
    assert.ok(block, 'expected a match');
    assert.strictEqual(block.code, '{ old implementation }');
  });

  it('ast: resolves each overload by its real argument labels', () => {
    const file = parseSwift(SRC);
    const selectors = file.type('AppDelegate').functions().map((f) => f.selector);
    assert.deepStrictEqual(selectors, [
      'application(_:didFinishLaunchingWithOptions:)',
      'application(_:open:options:)',
      'application(_:continue:restorationHandler:)',
    ]);

    const cont = file.type('AppDelegate').func('application(_:continue:restorationHandler:)');
    assert.match(cont.body.text, /continue: userActivity/);
    assert.doesNotMatch(cont.body.text, /open: url/);
  });

  it('ast: does not see commented-out code, because comments are not declarations', () => {
    const file = parseSwift('class A {\n  // func target() { old implementation }\n  func other() { real() }\n}\n');
    assert.strictEqual(file.func('target()'), null);
    assert.ok(file.func('other()'));
  });
});

describe('insertContentsInsideSwiftFunctionBlock  ->  fn.prependStatement / insertBeforeLastReturn', () => {
  it('regex: returns the source unchanged when the selector does not match', () => {
    const src = 'class A {\n  func setUp() {}\n}\n';
    const out = codeMod.insertContentsInsideSwiftFunctionBlock(src, 'doesNotExist()', 'MARK()', {
      position: 'head',
    });
    assert.strictEqual(out, src, 'a silent no-op: the caller cannot tell it failed');
  });

  it('regex: inserting into an overload hits whichever one came first', () => {
    const out = codeMod.insertContentsInsideSwiftFunctionBlock(
      SRC,
      'application(_:continue:restorationHandler:)',
      'SiriShortcuts.handle(userActivity)',
      { position: 'head', indent: 4 }
    );
    const openBody = out.slice(out.indexOf('open url'), out.indexOf('// Universal Links'));
    assert.match(openBody, /SiriShortcuts\.handle/, 'landed in application(_:open:options:)');
  });

  it('ast: throws instead of no-opping when the function is absent', () => {
    const file = parseSwift('class A {\n  func setUp() {}\n}\n');
    assert.strictEqual(file.func('doesNotExist()'), null);
    assert.throws(() => file.func('doesNotExist()').prependStatement('MARK()'), TypeError);
  });

  it('ast: inserts into the overload that was actually asked for', () => {
    const file = parseSwift(SRC);
    file
      .type('AppDelegate')
      .func('application(_:continue:restorationHandler:)')
      .prependStatement('SiriShortcuts.handle(userActivity)');
    const out = file.toString();

    const contStart = out.indexOf('// Universal Links');
    assert.ok(out.slice(contStart).includes('SiriShortcuts.handle'), 'in the continue: overload');
    assert.ok(!out.slice(0, contStart).includes('SiriShortcuts.handle'), 'and nowhere else');
    assert.ok(!parseSwift(out).hasParseErrors);
  });

  it('ast: insertBeforeLastReturn only considers returns of that function', () => {
    const src = `class A {
  func f() -> Bool {
    run { return false }
    return true
  }
}
`;
    const file = parseSwift(src);
    const fn = file.func('f()');
    assert.strictEqual(fn.returnStatements().length, 1, 'the closure return is not counted');
    fn.insertBeforeLastReturn('MARK()');
    assert.match(file.toString(), /MARK\(\)\n\s+return true/);
  });
});

describe('insertContentsInsideSwiftClassBlock  ->  type.appendMember', () => {
  it('regex: throws when a brace appears inside a string literal', () => {
    const src = 'class AppDelegate: NSObject {\n  let tag = "{"\n  func a() {}\n}\n';
    assert.throws(
      () => codeMod.insertContentsInsideSwiftClassBlock(src, 'class AppDelegate', '  // X', { position: 'tail' }),
      /Invalid parameters/
    );
  });

  it('ast: appends the member, because braces in literals are not structure', () => {
    const src = 'class AppDelegate: NSObject {\n  let tag = "{"\n  func a() {}\n}\n';
    const file = parseSwift(src);
    file.type('AppDelegate').appendMember('  func inserted() {}\n');
    const out = file.toString();
    assert.match(out, /func inserted\(\) \{\}/);
    assert.match(out, /let tag = "\{"/, 'the literal is untouched');
    assert.ok(!parseSwift(out).hasParseErrors);
  });
});

describe('the whole transform, per customization', () => {
  // The README table. Each variant isolates one thing a real app changes, so
  // it is clear which regex it defeats.
  const fixtures = require('../fixtures.js');

  const applyRegex = (contents) => {
    if (!contents.match(/^(internal\s+)?import\s+Expo\s*$/m)) {
      contents = codeMod.addSwiftImports(contents, ['Expo']);
      contents = contents.replace(/^import Expo$/m, 'internal import Expo');
    }
    contents = contents.replace(
      /^(class\s+AppDelegate\s*:\s*)UIResponder,\s*UIApplicationDelegate(\W+)/m,
      '$1ExpoAppDelegate$2'
    );
    return contents.replace(
      /\b(func application\([\s\S]+?didFinishLaunchingWithOptions launchOptions[\s\S]+?\{[\s\S]+?)(return true)([\s\S]+?\})/m,
      'override $1return super.application(application, didFinishLaunchingWithOptions: launchOptions)$3'
    );
  };

  const applyAst = (contents) => {
    const file = parseSwift(contents);
    const appDelegate = file.type('AppDelegate');
    const fn = appDelegate
      .functions()
      .find((f) => f.selector?.startsWith('application(_:didFinishLaunchingWithOptions:'));
    const param = fn.node.namedChildren
      .filter((c) => c.type === 'parameter')
      .find((c) => c.childForFieldName('external_name')?.text === 'didFinishLaunchingWithOptions');
    const opts = param?.childForFieldName('name')?.text ?? 'launchOptions';

    file.addImport('Expo', { access: 'internal' });
    appDelegate.setSupertype('ExpoAppDelegate', {
      replacing: ['UIResponder', 'UIApplicationDelegate'],
    });
    fn.addModifier('override');
    fn.replaceReturnValue(`super.application(application, didFinishLaunchingWithOptions: ${opts})`);
    return file.toString();
  };

  const applied = (out) => ({
    import: /^internal import Expo$/m.test(out),
    superclass: /class AppDelegate: ExpoAppDelegate/.test(out),
    override: /override func application\(/.test(out),
    superCall: /return super\.application\(application, didFinishLaunchingWithOptions:/.test(out),
  });

  it('regex: handles the stock template', () => {
    assert.deepStrictEqual(applied(applyRegex(fixtures.vanilla)), {
      import: true, superclass: true, override: true, superCall: true,
    });
  });

  it('regex: handles an added protocol conformance, because \\W+ captures the comma', () => {
    const out = applyRegex(fixtures.extraConformance);
    assert.deepStrictEqual(applied(out), {
      import: true, superclass: true, override: true, superCall: true,
    });
    assert.match(out, /UNUserNotificationCenterDelegate/, 'and keeps it');
  });

  it('regex: silently skips `override` and the super call when the parameter is renamed', () => {
    assert.deepStrictEqual(applied(applyRegex(fixtures.renamedParam)), {
      import: true, superclass: true, override: false, superCall: false,
    });
  });

  it('regex: silently skips them when the body does not end in `return true`', () => {
    assert.deepStrictEqual(applied(applyRegex(fixtures.computedReturn)), {
      import: true, superclass: true, override: false, superCall: false,
    });
  });

  for (const name of ['vanilla', 'extraConformance', 'renamedParam', 'computedReturn', 'customized']) {
    it(`ast: applies every edit on the ${name} fixture`, () => {
      const out = applyAst(fixtures[name]);
      assert.deepStrictEqual(applied(out), {
        import: true, superclass: true, override: true, superCall: true,
      });
      assert.ok(!parseSwift(out).hasParseErrors);
      assert.strictEqual(applyAst(out), out, 'and is idempotent');
    });
  }

  it('ast: keeps an unrelated conformance while swapping the superclass', () => {
    const out = applyAst(fixtures.extraConformance);
    assert.match(out, /class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate \{/);
  });

  it('ast: uses the real parameter name, whatever it was renamed to', () => {
    const out = applyAst(fixtures.renamedParam);
    assert.match(out, /didFinishLaunchingWithOptions: options\)/);
  });
});

describe('idempotency, which plugins need because prebuild re-runs', () => {
  it('ast: applying the same edits twice changes nothing', () => {
    const transform = (src) => {
      const file = parseSwift(src);
      file.addImport('Expo', { access: 'internal' });
      file.type('AppDelegate').addSupertype('ExpoReactNativeFactoryProvider');
      return file.toString();
    };
    const once = transform(SRC);
    assert.strictEqual(transform(once), once);
    assert.notStrictEqual(once, SRC);
  });
});
