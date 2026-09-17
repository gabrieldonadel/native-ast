# Vendored fixtures

Copied verbatim from [expo/expo](https://github.com/expo/expo) at `e5365dcaf1`:

| file | source |
|---|---|
| `AppDelegate-rn083.swift` | `packages/install-expo-modules/src/plugins/ios/__tests__/fixtures/` |
| `MainActivity-rn073.kt` | `packages/install-expo-modules/src/plugins/android/__tests__/fixtures/` |
| `../config-plugins/AppDelegate-shared.swift` | [expo/config-plugins](https://github.com/expo/config-plugins) `fixtures/AppDelegate.swift` |

Vendored rather than read from a local checkout so `npm test` runs anywhere,
including CI. To refresh, re-copy and update the commit above.
