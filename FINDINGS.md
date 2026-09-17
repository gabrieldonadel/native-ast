# Swift and Kotlin AST traversal from TypeScript, for Expo config plugins

Investigation + working prototype. Code in `src/`, tests in `test/`. Sections 1–5 cover Swift; §6 the WASM backend; §7 Kotlin; §8 the combined plan.

## 1. What config plugins do with Swift today

All Swift editing in `@expo/config-plugins` lives in one file:
`packages/@expo/config-plugins/src/ios/codeMod.ts` (315 lines). It is entirely
regex and bracket counting:

| Function | Method |
|---|---|
| `addSwiftImports` | find first `^import ` line, splice after it |
| `findSwiftFunctionCodeBlock` | regex `\sfunc\s+name\(`, then `findMatchingBracketPosition` |
| `insertContentsInsideSwiftClassBlock` | regex on the declaration, then bracket match |
| `insertContentsInsideSwiftFunctionBlock` | same, plus a `lastIndexOf(' return ')` scan |

`install-expo-modules` is the only in-repo consumer. Its SDK 53+ transform is
six chained `String.replace` calls, for example:

```js
contents = contents.replace(
  /\b(func application\([\s\S]+?didFinishLaunchingWithOptions launchOptions[\s\S]+?\{[\s\S]+?)(return true)([\s\S]+?\})/m,
  'override $1return super.application(application, didFinishLaunchingWithOptions: launchOptions)$3'
);
```

That regex requires the parameter to be named `launchOptions` and the body to
end in the literal `return true`. If either differs, `replace` matches nothing
and returns the input unchanged. The plugin reports success.

**Silent no-op on mismatch is the core failure mode.** Every community plugin
that edits `AppDelegate.swift` (Firebase, Sentry, OneSignal, branch, ...)
reimplements the same pattern with the same failure mode.

## 2. Is there a Swift parser usable from Node?

Surveyed npm: **`tree-sitter-swift` is the only option.** There is no
`swift-syntax`, `swift-ast`, or SwiftSyntax-to-WASM package published.

`tree-sitter-swift@0.7.1` (alex-pinkus), peer dep `tree-sitter@^0.22.1`:

- N-API prebuilds for darwin/linux/win32 × arm64/x64 — no compiler needed at
  install, and stable across Node majors.
- WASM build is documented in its README (`web-tree-sitter` + `tree-sitter build`).
  Not verified here — this machine has no emscripten or docker.

Note it peer-depends on `tree-sitter@^0.22.1` while the runtime is at 0.25.1;
installing current `tree-sitter` fails `ERESOLVE`. The grammar lags the runtime.

## 3. Does it parse real Swift?

Corpus: 6742 `.swift` files (31.9 MB) from five large open-source iOS apps.

| Repo | Files | Files with any error node |
|---|---|---|
| ios-oss | 2054 | 7.84% |
| protonvpn-ios | 2021 | 8.76% |
| protoncalendar-ios | 1916 | 3.71% |
| owncloud-ios | 426 | 3.76% |
| talk-ios | 325 | 0.92% |
| **total** | **6742** | **6.35%** |

Mean parse time 0.33 ms/file.

The 6.35% overstates the practical problem. Two things matter more:

**Errors are local, and recovery is good.** In
`ios-oss/.../SettingsViewModel.swift` the 8 "errors" are zero-width MISSING `!`
nodes caused by `MutableProperty(())` — an empty tuple argument. Everything
around them parses correctly.

**The declaration-level `#if` is the real gap.** In Wire's 556-line
`AppDelegate.swift`, the only two ERROR nodes wrap a `#if DEBUG` block
containing a whole `func` inside a class body. Even there, all 3 classes and
all 14 functions were still found with correct names and line numbers.
Statement-level `#if DEBUG` *inside* a function body — which the Expo template
itself uses in `bundleURL()` — parses cleanly.

On the files config plugins actually touch (`AppDelegate.swift`,
`SceneDelegate.swift`, `ExpoModulesProvider.swift` across ~/Developer):
**53 of 59 parse with zero errors.** The 6 failures are large macOS apps
(DuckDuckGo, Bitwarden, Wire, ProtonVPN), all from declaration-level `#if`.

## 4. Prototype

`src/index.js` — ~230 lines. Design:

- **Edits are splices, applied right-to-left.** The tree is read-only; every
  mutation queues a `{start, end, text}` and `toString()` applies them in
  reverse offset order. Original formatting, comments and indentation outside
  the edited span are preserved byte-for-byte. Overlapping edits throw.
- **Selectors are computed from the AST**, not matched textually:
  `selectorOf()` reads each `parameter` node's `external_name` field to build
  `application(_:didFinishLaunchingWithOptions:)`.
- **Every mutation is idempotent** by construction — it checks current state
  first and queues nothing if already applied. Config plugins re-run on every
  `prebuild`.
- **`isWellFormed` / `errorRegions()`** let a plugin detect that the region it
  is about to edit did not parse, and fail loudly instead of silently.

```js
const file = parseSwift(contents);
file.addImport('Expo', { access: 'internal' });
file.type('AppDelegate')
    .setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] })
    .func('application(_:didFinishLaunchingWithOptions:)')
    .addModifier('override')
    .replaceReturnValue('super.application(application, didFinishLaunchingWithOptions: launchOptions)');
return file.toString();
```

## 5. Head-to-head

`test/compare.js` runs the shipping regex transform and the AST transform over
the same fixtures. `vanilla` is the real `AppDelegate-rn083.swift` fixture from
`install-expo-modules`. Checks: superclass swapped, `override` added, `super`
call present, `Expo` imported, delegate superclass swapped.

| Fixture | regex | AST |
|---|---|---|
| vanilla (stock RN 0.83 template) | 5/5, idempotent | 5/5, idempotent |
| customized | **2/5** | 5/5, idempotent |
| declaration-level `#if DEBUG` present | 5/5 | 5/5, idempotent |

`customized` applies three changes real apps make: rename `launchOptions` to
`options`, return `self.finishLaunch()` instead of `true`, add a
`UNUserNotificationCenterDelegate` conformance. The regex silently skips both
the `override` keyword and the `super.application(...)` call — the app then
builds and crashes at launch, with no plugin error.

The AST diff on that fixture is 5 lines and nothing else moves:

```
- class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
+ class AppDelegate: ExpoAppDelegate, UNUserNotificationCenterDelegate {
-   func application(
+   override func application(
-     return self.finishLaunch()
+     return super.application(application, didFinishLaunchingWithOptions: options)
- class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
+ class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
+ internal import Expo
```

It kept the extra conformance, used the renamed parameter, and replaced a
non-literal return value. Output re-parses with zero errors.

**Honest note:** on the stock template the regex is fine. It was written
against that exact file. The gap opens on customized and brownfield apps.

## 6. The WASM path

Built and verified. `./build-wasm.sh` reproduces both artifacts.

### Swift does not work out of the box

`tree-sitter build --wasm` succeeds and the parser loads, but the result is
**not** equivalent to the native build:

| | stock WASM |
|---|---|
| trees differing from native | 1085 (16.09%) |
| files erroring in WASM only | 912 |
| files erroring in native only | 0 |
| parse time vs native | 6.18x |

Every divergence is a `#` token — `#if`, `#selector`, `#available`, macro
invocations, raw strings. `#if` in `AppDelegate.swift` is exactly what config
plugins must survive, so this is disqualifying.

Ruled out by experiment: **CLI version** (0.23.2 and 0.25.10 both broken in
different places), **emscripten version** (6.0.9 and 3.1.74 byte-identical),
and the **shift-count UB** at `scanner.c:131` (`1UL << FAKE_TRY_BANG` where
`FAKE_TRY_BANG` is 32 — real UB on wasm32, but patching it changes nothing).

### Root cause: a zero-byte allocation

```c
void *tree_sitter_swift_external_scanner_create() {
    return calloc(0, sizeof(struct ScannerState));   // allocates ZERO bytes
}
```

Arguments reversed. Every read and write of
`state->ongoing_raw_str_hash_count` is out of bounds. macOS `malloc` returns
zeroed memory for a 0-byte request so the native build works by accident;
emscripten's dlmalloc does not. In WASM the counter starts as garbage, so the
`hash_count == 0` branch in `eat_raw_str_part` — the only code that emits `#` —
is never reached.

That explains the whole failure profile. The scanner still runs (block
comments, implicit semis and custom operators are fine — none of them read
`state`), but `_hash_symbol_custom`, the four `_directive_*` tokens and
`raw_str_part` are never produced, and per `grammar.json` those are exactly
what `selector_expression`, `availability_condition`, `macro_invocation`,
`directive` and `raw_string_literal` require.

`calloc(0, …)` → `calloc(1, …)`. See `scanner-calloc.patch`.

### After the fix

| | stock WASM | fixed WASM |
|---|---|---|
| trees differing from native | 1085 (16.09%) | **0 (0.00%)** |
| declaration-level agreement | — | **6742/6742 (100%)** |
| files erroring in WASM only | 912 | **0** |
| parse time vs native | 6.18x | **1.69x** |

The garbage counter had also been driving pathological rescanning, which is
where most of the 6.18x went.

One correction to an earlier run of mine: I first measured 1.39% residual
divergence. That was an artifact of comparing native `tree-sitter@0.22.4`
against WASM `web-tree-sitter@0.25.10`. With runtimes matched it is zero.

### A separate finding: runtime 0.25 recovers worse than 0.22

On a declaration-level `#if` fixture, `tree-sitter@0.22.4` recovers the
enclosing `AppDelegate` class; `0.25.1` does not. This affects **both**
backends equally, so it is a runtime-version regression, not a WASM issue. It
does mean the runtime version is behaviour and must be pinned.

## 7. Kotlin

Same method, and a much healthier result. Kotlin needed **no patch at all**.

### Two grammars; only one is usable

| | `tree-sitter-kotlin` (fwcd) | `@tree-sitter-grammars/tree-sitter-kotlin` |
|---|---|---|
| version | 0.3.8 | 1.1.0 |
| prebuilds | **none** — node-gyp at install | all 6 platforms |
| scanner state | `ts_calloc(1, sizeof(Stack))` | **stateless** (`create` returns `NULL`) |
| error rate, 4367 `.kt` files | 4.31% | **0.78%** |

The grammars-org fork wins on every axis. Its scanner holds no state at all,
so the `calloc` bug class that broke Swift **cannot occur**.

Note it lists `npm-check-updates` in `dependencies` — a dev tool shipped as a
runtime dep, the same category of mistake as `tree-sitter-cli` in the Swift
grammar. Worth an upstream PR.

### WASM: clean on the first try

Native `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` vs the WASM build of
the same grammar, no patches:

| corpus | files | native errors | tree diff | decl diff | wasm vs native |
|---|---|---|---|---|---|
| `*.kt` (expo, brownfield-examples, Etar) | 4367 | 0.78% | **0 (0.00%)** | **0 (0.00%)** | 1.69x |
| `*.gradle.kts` | 75 | **0.00%** | **0 (0.00%)** | **0 (0.00%)** | 2.10x |

**Gradle Kotlin DSL comes free.** `.gradle.kts` parses with zero errors on the
same grammar, which also covers
`appendContentsInsideGradlePluginBlock` — one of the Android codemods.

### What the 0.78% actually is

All 34 erroring files, classified:

| cause | files | real gap? |
|---|---|---|
| template files with placeholders (`${{packageId}}`, `<%- project.package %>`) | 5 | no — not Kotlin |
| **invalid Kotlin in Expo's own test fixtures** | 8 | no — see below |
| real grammar gaps | ~21 | yes |

Real gaps are `@Composable get()` on a property, `@OptimizedRecord`/
`@ConsistentCopyVisibility` on data classes, backtick-quoted function names
(`` fun `should convert to float`() ``), and `dynamic` used as an identifier.
That is **0.48%** of the corpus — an order of magnitude better than Swift's
6.35%.

### Found along the way: 8 invalid Kotlin fixtures in expo

`packages/install-expo-modules/src/plugins/android/__tests__/fixtures/`
contains 8 `MainActivity-*.kt` files (`rn064`, `rn068`, `no-delegate`,
`anonymous-delegate`, and their `-updated` pairs) with:

```kotlin
override fun mainComponentName: String {
  return "HelloWorld"
}
```

A `fun` declaration with no parameter list is not valid Kotlin. Confirmed by
construction — only this form errors, all three legal spellings parse:

```
ERROR  fun, no params        override fun mainComponentName: String { … }
ok     fun with params       override fun getMainComponentName(): String { … }
ok     val with getter       override val mainComponentName: String get() = "X"
ok     expression body       override fun getMainComponentName(): String = "X"
```

The real template uses `override fun getMainComponentName(): String = "main"`.
The regex codemods process these fixtures happily and the snapshot tests pass,
so nothing has ever flagged them. (Not compile-verified — no `kotlinc` on this
machine — but the grammar evidence is unambiguous.)

### Head-to-head: Kotlin is where regex fails worst

`test/compare-kotlin.js` runs the shipping `setModulesMainActivity` regex
transform and an AST transform over the same fixtures. `vanilla` is the real
`MainActivity-rn073.kt`.

| fixture | regex | AST |
|---|---|---|
| vanilla (stock RN 0.73) | 4/4, idempotent | 4/4, idempotent |
| customized | **corrupts the file** | 4/4, idempotent |
| companion object present | 4/4, idempotent | 4/4, idempotent |

`customized` adds one realistic thing: a doc comment that mentions the delegate
with a constructor call. `findNewInstanceCodeBlock` does
`contents.search(/ (object\s*:\s*)?DefaultReactActivityDelegate\(/)` — the
first textual match anywhere in the file, comments included. Result:

```kotlin
  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * Previously this returned ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, DefaultReactActivityDelegate(this, name, false));
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
```

It rewrote the **comment**, left the real delegate unwrapped, and added an
unused import. The file still compiles, so nothing fails — Expo modules simply
are not wired up. That is worse than Swift's silent no-op: a silent no-op
*plus* file corruption.

The AST transform walks `createReactActivityDelegate`'s body for a
`call_expression` whose callee is `DefaultReactActivityDelegate`. Comments are
not in the AST, so the whole failure mode is unreachable. Its diff is 2 lines:

```
+ import expo.modules.ReactActivityDelegateWrapper
-       DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
+       ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED, DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled))
```

### Android surface coverage

The Android codemods in `@expo/config-plugins/src/android/codeMod.ts` are
shared across Java and Kotlin (`isJava` flags throughout) and also handle
Gradle. Measured what a tree-sitter approach can actually cover:

| target | grammar | prebuilds | error rate | verdict |
|---|---|---|---|---|
| `.kt` | `@tree-sitter-grammars/tree-sitter-kotlin` | yes | 0.78% | **use it** |
| `.gradle.kts` | same Kotlin grammar | — | **0.00%** | **free** |
| `.java` | `tree-sitter-java@0.23.5` | yes | 1.03% (194 files) | viable, not built |
| `.gradle` (Groovy) | `tree-sitter-groovy@0.1.2` | yes | **31.30%** (131 files) | **unusable** |

Groovy `build.gradle` has to stay on text manipulation. That is most Android
projects today, so an AST tool does not retire `codeMod.ts` on the Android side
— it sits alongside it.

## 8. The combined plan

### Architecture

The prototype is now two-language with a shared engine:

```
src/core.js        parse, traverse, splice-based edits, idempotency, error reporting
src/languages.js   per-language adapters (node names and shapes)
src/index.js       re-export
```

`core.js` knows nothing about Swift or Kotlin. `languages.js` absorbs the
differences, and they are real:

| | Swift | Kotlin |
|---|---|---|
| import node | `import_declaration` | `import` |
| class body | field `body` | child `class_body` |
| supertypes | `inheritance_specifier` | `delegation_specifiers` → `delegation_specifier` |
| return | `control_transfer_statement` | `jump_expression` |
| selector | argument labels: `application(_:didFinishLaunchingWithOptions:)` | parameter types: `onCreate(Bundle?)` |

Kotlin has no argument labels, so selectors use parameter types — overloads
there differ by type, not label. Adding Java is an adapter, not an engine
change.

```js
// Swift
const file = parseSwift(contents);
file.addImport('Expo', { access: 'internal' });
file.type('AppDelegate')
    .setSupertype('ExpoAppDelegate', { replacing: ['UIResponder', 'UIApplicationDelegate'] })
    .func('application(_:didFinishLaunchingWithOptions:)')
    .addModifier('override')
    .replaceReturnValue('super.application(application, didFinishLaunchingWithOptions: launchOptions)');

// Kotlin
const file = parseKotlin(contents);
file.addImport('expo.modules.ReactActivityDelegateWrapper');
file.type('MainActivity').func('createReactActivityDelegate()');   // same API
```

### Cost, both languages

| | native | WASM |
|---|---|---|
| installed, Swift only | 97 MB | 8.9 MB |
| installed, Swift + Kotlin | ~142 MB | ~12 MB |
| minimum shippable | 3.4 MB prebuild × 6 platforms × N languages | **3.2 MB + 3.4 MB, two files** |
| gzipped download | — | **~0.6 MB** |
| native addon / platform matrix | yes | **no** |
| startup, cold file cache | 33 ms | **20 ms** |
| startup, warm file cache | **~6 ms** | ~15 ms |
| parse throughput | 1.0x | 0.59x |

WASM's per-parse penalty is irrelevant — a plugin parses one file. Startup
depends on the file cache: cold, native is slower because it pages in a 3.4 MB
addon (33 ms vs 20 ms); warm, native wins (~6 ms vs ~15 ms), measured over
five consecutive runs. Neither figure is large enough to matter.

(An earlier draft of this document reported a single cold-cache measurement,
28.1 ms native against 19.8 ms WASM, as though it were the general case. It is
not — that was the first run only.)

### Recommendation

1. **Ship WASM for both languages.** Two committed `.wasm` files, no node-gyp,
   no ABI risk, no platform matrix, works in any Node and in the browser. Both
   are provably tree-identical to native across 11109 files (6742 Swift +
   4367 Kotlin).
2. **Own the grammars as forks, pinned as submodules.** Both grammars are now
   forks in `grammars/`, pinned to the commit matching their npm release and
   verified byte-identical to it. The Swift fork's `native-ast` branch carries
   the `calloc(0, …)` fix (blocking: nobody can use tree-sitter-swift from WASM
   without it) and the two shift-overflow UB sites; the Kotlin fork's moves
   `npm-check-updates` out of runtime `dependencies`. Each is a separate,
   cherry-pickable commit if upstream wants them, but nothing waits on review.
   `npm run grammar-sync` asserts the submodules and the npm grammar packages
   stay on the same versions — otherwise "WASM matches native" compares two
   different grammars and means nothing.
3. **Vendor the artifacts and pin the runtime.** Building needs emsdk, which is
   not a reasonable install-time dependency, so the `.wasm` files are committed
   and the submodules are only needed to rebuild them. §6 shows recovery
   behaviour changes between runtime versions, so pin `web-tree-sitter`.
4. **Start with Kotlin, not Swift.** Lower error rate (0.78% vs 6.35%), no
   patch needed, `.gradle.kts` free, and the worst regex failure mode found in
   this whole investigation (comment corruption) is on the Android side.
5. **Make "I could not parse this region" a loud error.** `hasParseErrors`,
   `errorRegions()` and `isWellFormed` exist for this. It kills the
   silent-no-op class independent of whether any edit succeeds.
6. **Add Java next** — 1.03% error rate, prebuilds available, and it is an
   adapter rather than new machinery. Without it, half the Android surface
   stays on regex.
7. **Leave Groovy alone.** 31.30% error rate. `build.gradle` stays textual, so
   this supplements `codeMod.ts` rather than replacing it.
8. **Fix the 8 invalid Kotlin fixtures in expo** regardless of whether any of
   this ships.
9. **Do not promise semantic analysis.** Syntax only: no type resolution, no
   cross-file references. Enough for every config-plugin case surveyed here;
   not SourceKit and not the Kotlin compiler.

### Known gaps

- **Swift declaration-level `#if`** still defeats recovery on runtime 0.25
  (both backends). Either upstream a grammar fix or preprocess `#if` before
  parsing.
- **Kotlin's ~0.48% real gaps** — `@Composable get()`, annotated data classes,
  backtick function names, `dynamic` as an identifier.
- **No output was compiled.** Transformed files re-parse cleanly and trees
  match native, but nothing was built by Xcode or Gradle.

## Reproduce

```sh
git clone https://github.com/gabrieldonadel/native-ast && cd native-ast && npm i

npm run swift:native    # regex vs AST, Swift, native backend
npm run swift:wasm      # regex vs AST, Swift, WASM backend
npm run kotlin:native   # regex vs AST, Kotlin, native backend
npm run kotlin:wasm     # regex vs AST, Kotlin, WASM backend
npm run bench           # cold start + parse cost
npm run probe           # the Swift '#' minimal cases

# corpus equivalence (needs the repos under ~/Developer)
node test/corpus.js swift  '*.swift'      ~/Developer/ios-oss …
node test/corpus.js kotlin '*.kt'         ~/Developer/expo …
node test/corpus.js kotlin '*.gradle.kts' ~/Developer/expo …

./build-wasm.sh         # rebuild both .wasm files (needs emsdk on PATH)
```

Both `.wasm` files are built from the forks in `grammars/`, via
`tree-sitter-cli@0.25.10` and emscripten 3.1.74:

- `tree-sitter-swift` at `0.7.1-with-generated-files` plus the scanner fixes —
  byte-identical to `tree-sitter-swift@0.7.1` on npm before patching.
- `tree-sitter-kotlin` at `v1.1.0`, no grammar changes — byte-identical to
  `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` on npm.

Rebuilding from the submodules reproduces the Kotlin artifact byte-for-byte.
The Swift artifact differs from the earlier calloc-only build by the two shift
fixes, which measurably change nothing: 0 tree divergence from native across
all three corpora either way.
