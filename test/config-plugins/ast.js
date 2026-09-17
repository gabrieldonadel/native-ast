// The same two plugin transforms, written against native-ast.
const { parseSwift } = require('../../src/index.js');

function refuseIfUnparsed(file, what) {
  if (!file.hasParseErrors) return;
  const r = file.errorRegions()[0];
  throw new Error(`${what}: could not parse line ${r.line}; refusing to edit`);
}

/* ---- expo-uiscene-lifecycle --------------------------------------------- */
const SCENE_PROTOCOL = 'ExpoReactNativeFactoryProvider';

function uisceneEnable(contents) {
  const file = parseSwift(contents);
  refuseIfUnparsed(file, 'expo-uiscene-lifecycle');

  const appDelegate = file.type('AppDelegate');
  if (!appDelegate) throw new Error('expo-uiscene-lifecycle: no AppDelegate class');
  if (appDelegate.supertypes.includes(SCENE_PROTOCOL)) return contents;   // idempotent

  const fn = appDelegate
    .functions()
    .find((f) => f.selector?.startsWith('application(_:didFinishLaunchingWithOptions:'));
  if (!fn) throw new Error('expo-uiscene-lifecycle: no didFinishLaunchingWithOptions');

  appDelegate.addSupertype(SCENE_PROTOCOL);

  // Under the scene life cycle the window is created by the SceneDelegate, so
  // drop the two statements that do it here. Matched structurally: an
  // assignment whose target is `window`, and a call to `startReactNative`.
  fn.removeStatements((s) => {
    if (s.type === 'assignment') {
      return s.namedChildren[0]?.text === 'window' && s.text.includes('UIWindow(');
    }
    if (s.type === 'call_expression') {
      return /(^|\.)startReactNative$/.test(s.firstChild?.text ?? '');
    }
    return false;
  });

  return file.toString();
}

/* ---- react-native-siri-shortcut ----------------------------------------- */
const SIRI_CALL =
  'RNSSSiriShortcuts.application(application, continue: userActivity, restorationHandler: restorationHandler)';

function siriAddInit(contents) {
  const file = parseSwift(contents);
  refuseIfUnparsed(file, 'react-native-siri-shortcut');

  const appDelegate = file.type('AppDelegate');
  if (!appDelegate) throw new Error('react-native-siri-shortcut: no AppDelegate class');

  // Resolve the overload by selector. `application` is overloaded three times
  // in this file; only one takes a userActivity.
  const fn = appDelegate.func('application(_:continue:restorationHandler:)');
  if (!fn) {
    throw new Error(
      'react-native-siri-shortcut: AppDelegate has no ' +
        'application(_:continue:restorationHandler:) — add the universal links method first'
    );
  }
  if (fn.text.includes('RNSSSiriShortcuts.application(')) return contents;  // idempotent

  fn.insertBeforeLastReturn(SIRI_CALL);
  return file.toString();
}

module.exports = { uisceneEnable, siriAddInit };
