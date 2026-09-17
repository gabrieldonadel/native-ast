// Shared setup for the API tests. The WASM backend is the one that ships, so
// it is the default; pass NATIVE_AST_BACKEND=native to run against the native
// bindings instead.
const { useBackend } = require('../../src/index.js');

async function initBackend() {
  await useBackend(process.env.NATIVE_AST_BACKEND === 'native' ? 'native' : 'wasm');
}

/** A minimal Swift AppDelegate with three overloads of `application`. */
const SWIFT_APP_DELEGATE = `import UIKit
import React

class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler)
  }
}
`;

const KOTLIN_MAIN_ACTIVITY = `package com.helloworld

import com.facebook.react.ReactActivity
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"

  /**
   * Previously this returned DefaultReactActivityDelegate(this, name, false);
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
`;

module.exports = { initBackend, SWIFT_APP_DELEGATE, KOTLIN_MAIN_ACTIVITY };
