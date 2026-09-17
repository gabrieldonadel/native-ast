const fs = require('fs');
const path = require('path');

// The real fixture shipped in expo/packages/install-expo-modules (React Native 0.83 template).
const FIXTURE = path.join(
  process.env.HOME,
  'Developer/expo/packages/install-expo-modules/src/plugins/ios/__tests__/fixtures/AppDelegate-rn083.swift'
);
const vanilla = fs.readFileSync(FIXTURE, 'utf8');

// Same app, customized the way real apps customize it.
const customized = vanilla
  .replace(/launchOptions/g, 'options')                       // renamed parameter
  .replace('    return true', '    return self.finishLaunch()') // computed return value
  .replace('UIResponder, UIApplicationDelegate {', 'UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {');

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

module.exports = { vanilla, customized, withConditionalDecl };
