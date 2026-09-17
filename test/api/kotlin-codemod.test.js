// Kotlin: what a config plugin used to do with @expo/config-plugins'
// android/codeMod.ts, and what it does with native-ast instead.
//
// The `regex:` tests call the real shipping functions and pin their actual
// behaviour, wrong or not.
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const codeMod = require('@expo/config-plugins/build/android/codeMod');
const { parseKotlin, walk } = require('../../src/index.js');
const { initBackend, KOTLIN_MAIN_ACTIVITY: SRC } = require('./helpers.js');

before(initBackend);

/** Find a call by callee name inside `node`. What the AST replaces a regex with. */
function findCall(node, callee) {
  let found = null;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === 'call_expression' && n.firstChild?.text === callee) {
      found = n;
      return false;
    }
  });
  return found;
}

describe('addImports  ->  file.addImport', () => {
  it('regex: silently skips the import when the path is only named in a comment', () => {
    const src = `package com.app

import com.facebook.react.ReactActivity

// see expo.modules.ReactActivityDelegateWrapper for details
class MainActivity : ReactActivity()
`;
    const out = codeMod.addImports(src, ['expo.modules.ReactActivityDelegateWrapper'], false);
    assert.strictEqual(out, src, 'expected the shipping helper to no-op');
  });

  it('regex: inserts directly after `package`, ahead of the existing imports', () => {
    const src = 'package com.app\n\nimport com.facebook.react.ReactActivity\n';
    const out = codeMod.addImports(src, ['expo.modules.Foo'], false);
    assert.match(out, /^package com\.app\nimport expo\.modules\.Foo\n/);
  });

  it('ast: adds the import, and groups it with the existing ones', () => {
    const src = `package com.app

import com.facebook.react.ReactActivity

// see expo.modules.ReactActivityDelegateWrapper for details
class MainActivity : ReactActivity()
`;
    const file = parseKotlin(src);
    file.addImport('expo.modules.ReactActivityDelegateWrapper');
    const out = file.toString();
    assert.match(out, /^import expo\.modules\.ReactActivityDelegateWrapper$/m);
    assert.match(
      out,
      /import com\.facebook\.react\.ReactActivity\nimport expo\.modules\.ReactActivityDelegateWrapper/
    );
  });

  it('ast: is a no-op when the import really is present', () => {
    const file = parseKotlin(SRC);
    file.addImport('com.facebook.react.ReactActivity');
    assert.strictEqual(file.toString(), SRC);
  });
});

describe('findNewInstanceCodeBlock  ->  AST call lookup', () => {
  it('regex: matches the constructor call inside a doc comment', () => {
    // The search is ` (object\s*:\s*)?DefaultReactActivityDelegate\(` over the
    // whole file, and the doc comment in this fixture spells it with parens.
    const block = codeMod.findNewInstanceCodeBlock(SRC, 'DefaultReactActivityDelegate', 'kt');
    assert.ok(block);
    assert.strictEqual(block.code, 'DefaultReactActivityDelegate(this, name, false)');
    assert.ok(
      SRC.slice(0, block.start).lastIndexOf('/**') > SRC.slice(0, block.start).lastIndexOf('*/'),
      'the match sits inside the comment'
    );
  });

  it('regex: wrapping it therefore edits the comment and leaves the real call alone', () => {
    const block = codeMod.findNewInstanceCodeBlock(SRC, 'DefaultReactActivityDelegate', 'kt');
    const out =
      SRC.slice(0, block.start) +
      `ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, ${block.code})` +
      SRC.slice(block.end + 1);

    const commentLine = out.split('\n').find((l) => l.trim().startsWith('* Previously'));
    assert.match(commentLine, /ReactActivityDelegateWrapper/, 'the comment got rewritten');
    assert.match(
      out,
      /createReactActivityDelegate\(\): ReactActivityDelegate =\n\s+DefaultReactActivityDelegate\(this, mainComponentName, fabricEnabled\)/,
      'and the real call is still unwrapped'
    );
  });

  it('ast: finds the call in the function body, not the comment', () => {
    const file = parseKotlin(SRC);
    const fn = file.type('MainActivity').func('createReactActivityDelegate()');
    const call = findCall(fn.body, 'DefaultReactActivityDelegate');
    assert.ok(call);
    assert.strictEqual(call.text, 'DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)');

    file.addImport('expo.modules.ReactActivityDelegateWrapper');
    file.edits.replace(
      call.startIndex,
      call.endIndex,
      `ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, ${call.text})`
    );
    const out = file.toString();

    assert.match(
      out,
      /ReactActivityDelegateWrapper\(this, BuildConfig\.IS_NEW_ARCHITECTURE_ENABLED, DefaultReactActivityDelegate\(this, mainComponentName, fabricEnabled\)\)/
    );
    const commentLine = out.split('\n').find((l) => l.trim().startsWith('* Previously'));
    assert.doesNotMatch(commentLine, /ReactActivityDelegateWrapper/, 'the comment is untouched');
    assert.ok(!parseKotlin(out).hasParseErrors);
  });
});

describe('appendContentsInsideDeclarationBlock  ->  type.appendMember', () => {
  it('regex: throws when a brace appears inside a comment', () => {
    const src = 'class MainActivity : ReactActivity() {\n  // the { character\n  fun a() {}\n}\n';
    assert.throws(
      () => codeMod.appendContentsInsideDeclarationBlock(src, 'class MainActivity', '  // X\n'),
      /Invalid parameters/
    );
  });

  it('ast: appends the member, because braces in comments are not structure', () => {
    const src = 'class MainActivity : ReactActivity() {\n  // the { character\n  fun a() {}\n}\n';
    const file = parseKotlin(src);
    file.type('MainActivity').appendMember('  fun inserted() {}\n');
    const out = file.toString();
    assert.match(out, /fun inserted\(\) \{\}/);
    assert.match(out, /\/\/ the \{ character/, 'the comment is untouched');
    assert.ok(!parseKotlin(out).hasParseErrors);
  });
});

describe('findGradlePluginCodeBlock  ->  AST call lookup (.gradle.kts only)', () => {
  const KTS = `pluginManagement {
  repositories { gradlePluginPortal() }
}

plugins {
  id("com.android.application")
}
`;

  it('regex: matches the `plugins` block, and also a mention in a comment', () => {
    const block = codeMod.findGradlePluginCodeBlock(KTS, 'plugins');
    assert.ok(block);
    assert.match(block.code, /com\.android\.application/);

    // A comment mentioning `plugins {` shifts the match to the comment.
    const withComment = `// plugins {\n${KTS}`;
    const shifted = codeMod.findGradlePluginCodeBlock(withComment, 'plugins');
    assert.ok(shifted.start < withComment.indexOf('pluginManagement'), 'matched the comment first');
  });

  it('ast: resolves the real `plugins` block in Kotlin DSL', () => {
    const file = parseKotlin(`// plugins {\n${KTS}`);
    assert.ok(!file.hasParseErrors, '.gradle.kts parses with the Kotlin grammar');
    const plugins = findCall(file.tree.rootNode, 'plugins');
    assert.ok(plugins);
    assert.match(plugins.text, /com\.android\.application/);
  });

  it('Groovy .gradle is out of scope, and the parser says so rather than guessing', () => {
    // Groovy build.gradle is not Kotlin. The boundary is explicit: a plugin
    // can detect it instead of silently producing a wrong edit. Groovy stays
    // textual — tree-sitter-groovy errors on 31% of real build files.
    const groovy = `apply plugin: "com.android.application"

dependencies {
    implementation "com.facebook.react:react-android"
}

def enableProguard = false
`;
    const file = parseKotlin(groovy);
    assert.ok(file.hasParseErrors, 'Groovy must not parse clean as Kotlin');
    assert.strictEqual(file.errorRegions()[0].line, 1);
  });
});

describe('idempotency, which plugins need because prebuild re-runs', () => {
  it('ast: applying the same edits twice changes nothing', () => {
    const transform = (src) => {
      const file = parseKotlin(src);
      file.addImport('expo.modules.ReactActivityDelegateWrapper');
      return file.toString();
    };
    const once = transform(SRC);
    assert.strictEqual(transform(once), once);
    assert.notStrictEqual(once, SRC);
  });
});
