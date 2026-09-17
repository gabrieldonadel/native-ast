// The real AppDelegate.swift fixture from
// expo/config-plugins/packages/expo-uiscene-lifecycle/src/__tests__/fixtures/
// sdk57ProjectWithoutUISceneLifecycle.ts, plus variants a real app would have.
const stock = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

// Another config plugin already added a protocol conformance.
const extraProtocol = stock.replace(
  'class AppDelegate: ExpoAppDelegate {',
  'class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {'
);

// The app is not registered as "main".
const renamedModule = stock.replace('withModuleName: "main"', 'withModuleName: "HelloWorld"');

// swift-format collapsed the call onto one line.
const reformatted = stock.replace(
  `    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)`,
  `    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)`
);

// The developer renamed the launch options parameter.
const renamedParam = stock.replace(/launchOptions/g, 'opts');

module.exports = { stock, extraProtocol, renamedModule, reformatted, renamedParam };
