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
test/api/               npm test — per-function: the old regex vs the AST API
test/smoke.js           self-contained; what CI runs before publishing
test/config-plugins/    real community plugins from expo/config-plugins as a suite
test/compare*.js        head-to-head against the shipping regex transforms
test/corpus.js          native-vs-WASM equivalence and error rates over a corpus
grammars/               the two grammar forks, pinned as git submodules
build-wasm.sh           builds both .wasm from the submodules (needs emsdk)
scanner-calloc.patch    the tree-sitter-swift fix, for upstreaming (see below)
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

## Tests: the old regex API vs this one

`npm test` is a `node:test` suite with one group per function in
`@expo/config-plugins`' `codeMod.ts`. Each group calls the **real shipping
function** and pins its actual behaviour, then asserts what native-ast does
instead. If config-plugins changes one of these, the test fails and we find out.

| `codeMod.ts` | native-ast | what the regex does |
|---|---|---|
| `addSwiftImports` | `file.addImport()` | no-ops when the module name is a substring of something else, or appears in a comment |
| `findSwiftFunctionCodeBlock` | `file.func(selector)` | resolves overloads by parameter **count**, so it returns the wrong one; matches commented-out functions |
| `insertContentsInsideSwiftFunctionBlock` | `fn.prependStatement()`, `fn.insertBeforeLastReturn()` | returns the input unchanged when the selector misses |
| `insertContentsInsideSwiftClassBlock` | `type.appendMember()` | throws when a brace appears in a string literal |
| `addImports` (android) | `file.addImport()` | no-ops when the path appears in a comment; inserts ahead of existing imports |
| `findNewInstanceCodeBlock` | AST call lookup | matches a constructor call inside a doc comment |
| `appendContentsInsideDeclarationBlock` | `type.appendMember()` | throws when a brace appears in a comment |
| `findGradlePluginCodeBlock` | AST call lookup (`.gradle.kts`) | matches a mention in a comment |

30 tests, run on both backends (`npm test`, `npm run test:native`).

### A bug in shipping config-plugins

`findSwiftFunctionCodeBlock` compares argument labels in a loop whose mismatch
branch is `continue` — which advances the label loop instead of rejecting the
candidate. Labels are therefore never compared; only arity is. On the standard
Expo `AppDelegate.swift`, which has three overloads of `application`, two of
them taking three parameters:

```js
findSwiftFunctionCodeBlock(src, 'application(_:continue:restorationHandler:)')
// returns the body of application(_:open:options:)
```

So `insertContentsInsideSwiftFunctionBlock` with that selector injects code
into the wrong method, silently. Pinned in
[`test/api/swift-codemod.test.js`](./test/api/swift-codemod.test.js).

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

## Grammars

The `.wasm` files are built from forks pinned as submodules, not from npm:

| submodule | fork | pinned at |
|---|---|---|
| `grammars/tree-sitter-swift` | [gabrieldonadel/tree-sitter-swift](https://github.com/gabrieldonadel/tree-sitter-swift) `native-ast` | `0.7.1-with-generated-files` + 2 fixes |
| `grammars/tree-sitter-kotlin` | [gabrieldonadel/tree-sitter-kotlin](https://github.com/gabrieldonadel/tree-sitter-kotlin) `native-ast` | `v1.1.0` + 1 packaging fix |

Both are byte-identical to their npm releases at those tags, so the
measurements above carry over directly. The forks let us pin and patch without
waiting on upstream review; the commits are written to be cherry-pickable if
upstream wants them.

The `.wasm` files are **not in git** — they are build output. CI builds them
from the submodules on every release and publishes them in the tarball, so
installing from npm gives you a prebuilt copy. Working from a source checkout,
build them once:

```sh
git submodule update --init --recursive
source /path/to/emsdk/emsdk_env.sh        # https://emscripten.org/docs/getting_started
npm run build:wasm
npm run grammar-sync                      # asserts grammars/ matches the npm versions
```

Anything that parses will tell you to do this if the files are missing. The
published tarball contains the two `.wasm` files and no grammar sources.

`npm run grammar-sync` exists because the native backend used for diffing comes
from the npm grammar packages while the `.wasm` comes from `grammars/`. If those
drift to different versions, "WASM matches native" stops meaning anything.

### The Swift fix

`tree_sitter_swift_external_scanner_create()` calls
`calloc(0, sizeof(struct ScannerState))` — the arguments are reversed, so it
allocates **zero bytes** and all scanner state is read out of bounds. macOS
`malloc` returns zeroed memory for a 0-byte request so the native build works
by accident; emscripten's dlmalloc does not, so in WASM every `#` token fails:
`#if`, `#selector`, `#available`, macro invocations and raw strings.

Measured over 6742 files: 912 files error in WASM but not native before the
fix, 0 after, and parse time drops from 6.18x native to 1.69x.

Fixed on the fork's `native-ast` branch, along with two undefined-shift sites
in the same scanner. [`scanner-calloc.patch`](./scanner-calloc.patch) is the
standalone diff, kept for upstreaming.

## Reproduce

```sh
npm i        # see .npmrc — both grammars' `tree-sitter` peer ranges lag the runtime
npm run build:wasm   # required first in a source checkout; see Grammars below

npm test                # the API suite: old regex vs AST, per function
npm run test:native     # the same, against the native bindings
npm run plugins         # the expo/config-plugins community suite
npm run swift:native    # whole-transform head-to-head, Swift
npm run swift:wasm
npm run kotlin:native   # whole-transform head-to-head, Kotlin
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
