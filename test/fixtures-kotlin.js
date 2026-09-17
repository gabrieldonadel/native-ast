const fs = require('fs');
const path = require('path');

// Real fixture from install-expo-modules (React Native 0.73 template),
// vendored so this runs without a local expo checkout. See fixtures/PROVENANCE.md.
const vanilla = fs.readFileSync(path.join(__dirname, 'fixtures', 'MainActivity-rn073.kt'), 'utf8');

// Customized the way real apps customize it:
//  - a doc comment that spells the delegate with a constructor call
//  - an extra interface on the class
const customized = vanilla
  .replace(
    '   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]',
    '   * Previously this returned DefaultReactActivityDelegate(this, name, false);\n   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]'
  )
  .replace('class MainActivity : ReactActivity() {', 'class MainActivity : ReactActivity(), MyAppHooks {');

// A companion object declared before the delegate override.
const withCompanion = vanilla.replace(
  'class MainActivity : ReactActivity() {\n',
  `class MainActivity : ReactActivity() {

  companion object {
    const val TAG = "MainActivity"
  }
`
);

module.exports = { vanilla, customized, withCompanion };
