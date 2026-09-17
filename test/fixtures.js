const fs = require('fs');
const path = require('path');

// The real fixture from install-expo-modules (React Native 0.83 template),
// vendored so this runs without a local expo checkout. See fixtures/PROVENANCE.md.
const FIXTURE = path.join(__dirname, 'fixtures', 'AppDelegate-rn083.swift');
const vanilla = fs.readFileSync(FIXTURE, 'utf8');

// Three customizations real apps make, isolated so it is clear which one
// breaks which regex. The shipping transform handles the added conformance —
// its superclass regex captures the trailing `, ` — but not the other two.
const extraConformance = vanilla.replace(
  'UIResponder, UIApplicationDelegate {',
  'UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {'
);
const renamedParam = vanilla.replace(/launchOptions/g, 'options');
const computedReturn = vanilla.replace('    return true', '    return self.finishLaunch()');

// All three at once.
const customized = computedReturn
  .replace(/launchOptions/g, 'options')
  .replace(
    'UIResponder, UIApplicationDelegate {',
    'UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {'
  );

// An unrelated declaration wrapped in `#if DEBUG` — a tree-sitter-swift ERROR region.
const withConditionalDecl = vanilla.replace(
  /\n\}\n\nclass ReactNativeDelegate/,
  `
#if DEBUG
  private func debugOnlyHelper() {
    print("debug")
  }
#endif
}

class ReactNativeDelegate`
);

module.exports = {
  vanilla,
  extraConformance,
  renamedParam,
  computedReturn,
  customized,
  withConditionalDecl,
};
