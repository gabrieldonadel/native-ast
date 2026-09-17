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
src/core.js        parse, traverse, splice-based edits, idempotency, error reporting
src/languages.js   per-language adapters (Swift and Kotlin node names and shapes)
test/              head-to-head against the shipping regex transforms, corpus tools
build-wasm.sh      rebuild both .wasm grammars (needs emsdk)
scanner-calloc.patch   upstream fix for tree-sitter-swift (see below)
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
node-gyp and no platform prebuild matrix. Cold start is *faster* than native
(19.8 ms vs 28.1 ms) because there is no addon to dlopen.

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

## Status

Prototype. Not published to npm, not used by anything. Nothing here has been
compiled by Xcode or Gradle — transformed files re-parse cleanly and trees
match the native parser, but that is not the same as building.

## License

MIT
