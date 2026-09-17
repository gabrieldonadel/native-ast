# native-ast

Swift and Kotlin AST traversal from TypeScript, for Expo config plugins.

A prototype and a written investigation. Today `@expo/config-plugins` edits
`AppDelegate.swift` and `MainActivity.kt` with regular expressions and bracket
counting, and the dominant failure mode is a **silent no-op**: when a regex
does not match, `String.replace` returns the input unchanged and the plugin
reports success. This explores replacing that with real parsing.

**Read [FINDINGS.md](./FINDINGS.md) for the full investigation, measurements
and plan.**

## What's here

```
src/core.js             parse, traverse, splice-based edits, idempotency, error reporting
src/languages.js        per-language adapters (Swift and Kotlin node names and shapes)
test/smoke.js           self-contained; what CI runs before publishing
test/config-plugins/    real community plugins from expo/config-plugins as a suite
test/compare*.js        head-to-head against the shipping regex transforms
test/corpus.js          native-vs-WASM equivalence and error rates over a corpus
tree-sitter-*.wasm      the two grammars, committed so CI needs no emscripten
build-wasm.sh           rebuild both .wasm grammars (needs emsdk)
scanner-calloc.patch    upstream fix for tree-sitter-swift (see below)
RELEASING.md            how to cut a release
```

## API

Edits are queued as text splices and applied right-to-left, so formatting
outside an edited span is preserved byte-for-byte. Every mutation is
idempotent, because config plugins re-run on every `prebuild`.

```js
const { parseSwift, parseKotlin } = require('native-ast');

// Swift — selectors carry argument labels
const swift = parseSwift(contents);
swift.addImport('Expo', { access: 'internal' });
swift.type('AppDelegate')
     .setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] })
     .func('application(_:didFinishLaunchingWithOptions:)')
     .addModifier('override')
     .replaceReturnValue('super.application(application, didFinishLaunchingWithOptions: launchOptions)');
return swift.toString();

// Kotlin — selectors carry parameter types, same API otherwise
const kotlin = parseKotlin(contents);
kotlin.addImport('expo.modules.ReactActivityDelegateWrapper');
kotlin.type('MainActivity').func('createReactActivityDelegate()');
```

`hasParseErrors`, `errorRegions()` and `isWellFormed` let a plugin fail loudly
when the region it wants to edit did not parse, instead of silently doing
nothing.

The named helpers — `addImport`, `addModifier`, `setSupertype`, `addSupertype`,
`removeSupertype`, `replaceReturnValue`, `appendMember`, `prependStatement`,
`insertBeforeLastReturn`, `removeStatements` — check current state first and queue nothing if the
change is already applied. `file.edits.replace(start, end, text)` is the raw
escape hatch for anything they do not cover, and it is **not** idempotent:
guard it yourself, or re-running the plugin will apply the edit twice.
`test/smoke.js` has a worked example.

## Results

Both grammars run on WASM (`web-tree-sitter`) and are tree-identical to the
native bindings across 11109 real source files.

| | Swift | Kotlin |
|---|---|---|
| grammar | `tree-sitter-swift@0.7.1` | `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` |
| corpus | 6742 files, 31.9 MB | 4367 files, 18.7 MB |
| parse errors | 6.35% | **0.78%** |
| WASM vs native | 0 (0.00%) — **after a patch** | 0 (0.00%) — no patch |
| WASM speed | 1.69x native | 1.69x native |

Head-to-head against the shipping regex transforms:

| fixture | regex | AST |
|---|---|---|
| Swift, stock RN 0.83 template | 5/5 | 5/5 |
| Swift, customized AppDelegate | **2/5** | 5/5 |
| Kotlin, stock RN 0.73 template | 4/4 | 4/4 |
| Kotlin, customized MainActivity | **corrupts the file** | 4/4 |

Installed size is 8.9 MB for WASM against 97 MB for the native addon, with no
node-gyp and no platform prebuild matrix.

Startup depends on whether the file cache is warm. On a cold cache native is
slower, because it pages in a 3.4 MB addon: 33 ms against WASM's 20 ms. Once
warm, native wins: ~6 ms against ~15 ms. Both are small enough not to matter
for a prebuild that parses one file.

## Tested against real config plugins

`npm run plugins` uses the community plugins in
[expo/config-plugins](https://github.com/expo/config-plugins) as a suite. It
runs each plugin's shipping transform — the real one, with `mergeContents` from
`@expo/config-plugins`, not a copy — and a native-ast equivalent over the
plugin's own fixture plus variants a real app would have.

Of the 15 packages there, 2 edit Swift or Kotlin source; the rest work through
plists, Android manifests and the Xcode project.

`expo-uiscene-lifecycle`, `updateAppDelegate(contents, enabled: true)`:

| fixture | shipping | native-ast |
|---|---|---|
| stock SDK 57 template | ok | ok — **byte-identical output** |
| extra protocol conformance | throws | ok |
| `withModuleName` not `"main"` | throws | ok |
| startup call reformatted to one line | throws | ok |
| `launchOptions` parameter renamed | throws | ok |

The plugin matches an exact 6-line block including indentation, so any of those
four changes makes it refuse. It fails loudly rather than corrupting anything,
which is the right call — but it also means the plugin does not work on a
customized AppDelegate.

`react-native-siri-shortcut` behaves the same on both: it needs
`application(_:continue:restorationHandler:)`, which the shared fixture has and
the current SDK 57 bare template does not. Both refuse; native-ast's error names
the missing method instead of printing a regex.

Parse conformance: 4/4 Swift samples in that repo parse cleanly — the `.swift`
fixtures plus AppDelegate sources embedded in `.ts` fixtures and jest
snapshots. Parsing the snapshots checks the plugins emit valid Swift.

### A bug the suite found

`expo-uiscene-lifecycle`'s `disable()` path re-inserts the startup block from a
hardcoded string:

```swift
factory.startReactNative(
  withModuleName: "main",        // always "main"
  in: window,
  launchOptions: launchOptions)  // always "launchOptions"
```

An app that registers a different root component gets `"main"` written in, and
an app that renamed the parameter gets code referencing a name that no longer
exists. Latent rather than live today, because `enable()` refuses any
non-standard AppDelegate, so you cannot reach that state through the plugin —
but a scene-based template or a hand-written delegate gets there.

## An upstream bug in tree-sitter-swift

`tree_sitter_swift_external_scanner_create()` calls
`calloc(0, sizeof(struct ScannerState))` — the arguments are reversed, so it
allocates **zero bytes** and all scanner state is read out of bounds. macOS
`malloc` returns zeroed memory for a 0-byte request so the native build works
by accident; emscripten's dlmalloc does not, so in WASM every `#` token fails:
`#if`, `#selector`, `#available`, macro invocations and raw strings.

Measured over 6742 files: 912 files error in WASM but not native before the
fix, 0 after, and parse time drops from 6.18x native to 1.69x.

See [`scanner-calloc.patch`](./scanner-calloc.patch). Not yet submitted
upstream.

## Reproduce

```sh
npm i        # see .npmrc — both grammars' `tree-sitter` peer ranges lag the runtime

npm run swift:native    # regex vs AST, Swift
npm run swift:wasm
npm run kotlin:native   # regex vs AST, Kotlin
npm run kotlin:wasm
npm run bench           # cold start + parse cost
npm run probe           # the Swift '#' minimal cases
```

The corpus tools take paths, and the head-to-head fixtures read from a local
`expo/expo` checkout at `~/Developer/expo`:

```sh
node test/corpus.js swift  '*.swift'      ~/path/to/some-ios-app
node test/corpus.js kotlin '*.kt'         ~/path/to/expo
node test/corpus.js kotlin '*.gradle.kts' ~/path/to/expo
```

## Note on installing

`.npmrc` sets `legacy-peer-deps=true`. Both grammar packages pin stale
`tree-sitter` peer ranges (`^0.22.1` for Swift, `^0.22.4` for Kotlin) against
the 0.25.1 runtime, so a plain `npm i` fails with `ERESOLVE`. This only
affects development here: the native binding is a devDependency used to diff
WASM against native, and the one runtime dependency — `web-tree-sitter` — has
no such conflict.

## Releasing

See [RELEASING.md](./RELEASING.md). Push a `vX.Y.Z` tag; CI verifies the
tarball and publishes to npm via trusted publishing.

## Status

Prototype. Not used by anything yet. Nothing here has been compiled by Xcode or
Gradle — transformed files re-parse cleanly and trees match the native parser,
but that is not the same as building.

## License

MIT
