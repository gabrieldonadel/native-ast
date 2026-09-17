// The transforms as they ship, lifted verbatim from expo/config-plugins.
// `mergeContents` is the real one from @expo/config-plugins@57.x, not a copy.
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

/* ---- expo-uiscene-lifecycle -------------------------------------------- */
// packages/expo-uiscene-lifecycle/src/index.ts
const PLUGIN_NAME = 'expo-uiscene-lifecycle';
const ORIGINAL_APP_DELEGATE = 'class AppDelegate: ExpoAppDelegate {';
const SCENE_APP_DELEGATE = 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {';
const FACTORY_ASSIGNMENT = '    reactNativeFactory = factory';
const LEGACY_STARTUP = `    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
`;

function uisceneUpdateAppDelegate(contents, enabled) {
  const isEnabled = contents.includes(SCENE_APP_DELEGATE);
  if (enabled && isEnabled) return contents;
  if (!enabled && !isEnabled) return contents;

  if (enabled) {
    const startup = `\n${LEGACY_STARTUP}`;
    if (!contents.includes(ORIGINAL_APP_DELEGATE) || !contents.includes(startup)) {
      throw new Error(`${PLUGIN_NAME} requires the standard Expo SDK 57 Swift AppDelegate.`);
    }
    return contents.replace(ORIGINAL_APP_DELEGATE, SCENE_APP_DELEGATE).replace(startup, '');
  }

  return contents
    .replace(SCENE_APP_DELEGATE, ORIGINAL_APP_DELEGATE)
    .replace(`${FACTORY_ASSIGNMENT}\n\n`, `${FACTORY_ASSIGNMENT}\n\n${LEGACY_STARTUP}\n`);
}

/* ---- react-native-siri-shortcut ---------------------------------------- */
// packages/react-native-siri-shortcut/src/withReactNativeSiriShortcut.ts
function siriAddAppDelegateInit(src) {
  return mergeContents({
    tag: 'react-native-siri-shortcut-delegate',
    src,
    newSrc:
      '  RNSSSiriShortcuts.application(application, continue: userActivity, restorationHandler: restorationHandler)',
    anchor:
      /return super.application\(application,(\s+)?continue:(\s+)?userActivity,(\s+)?restorationHandler:(\s+)?restorationHandler\)/,
    offset: -1,
    comment: '//',
  });
}

module.exports = {
  uisceneUpdateAppDelegate,
  siriAddAppDelegateInit,
  ORIGINAL_APP_DELEGATE,
  SCENE_APP_DELEGATE,
};
