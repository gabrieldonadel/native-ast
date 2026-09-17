# Releasing `native-ast`

Releases are automated. Push a `vX.Y.Z` tag to run
[.github/workflows/release.yml](.github/workflows/release.yml), which builds the
two `.wasm` grammars, verifies the tarball, and publishes to npm.

`src/` is plain CommonJS and needs no build. The `.wasm` grammars are build
output and are **not** in git — CI compiles them from the `grammars/`
submodules with emscripten, then hands them to the publish job as an artifact.

The workflow is two jobs on purpose:

- **`build-wasm`** checks out the submodules, installs emscripten and compiles.
  It has `contents: read` only, so nothing in the toolchain it installs can
  reach the npm publishing credential.
- **`publish`** has `id-token: write`, downloads the artifact, and runs only
  first-party actions.

emscripten is installed by cloning the official `emscripten-core/emsdk` repo at
a pinned version rather than via a third-party action, to keep the release path
free of actions we do not control.

## One-time setup

The workflow authenticates with npm **trusted publishing (OIDC)** — no token.
Configure it once on npmjs.com:

1. Open <https://www.npmjs.com/package/native-ast/access>.
2. Under **Trusted Publisher**, select **GitHub Actions**.
3. Set repository `gabrieldonadel/native-ast`, workflow `release.yml`.

If you push the tag before this is configured, the publish step fails.
Configure it, then re-run the workflow.

## Release steps

```bash
# 1. Bump "version" in package.json (e.g. 0.0.2), then:
git commit -am "release v0.0.2"
git tag v0.0.2

# 2. Sanity-check the tarball contents. Both .wasm files must be listed —
#    build them first if this is a fresh checkout, since they are not in git.
npm run build:wasm     # needs emsdk on PATH
npm pack --dry-run

# 3. Push the branch and the tag. The tag push triggers the release.
git push origin main v0.0.2
```

Watch the run with `gh run watch`. Confirm with `npm view native-ast@<version>`.

npm currently holds a `0.0.0` placeholder that predates this code, so the first
real release is `0.0.1`.

## What CI checks before publishing

1. **Tag matches `package.json` version.** `v0.0.2` must pair with `"version":
   "0.0.2"`.
2. **Both `.wasm` grammars are in the tarball, and each is over 1 MB.** They
   are the whole package — a tarball without them installs and then fails at
   `Language.load`. Since they are no longer in git, this also confirms the
   artifact actually made it across from `build-wasm`.
3. **`npm run grammar-sync` passes**: the `grammars/` submodules are on the
   same versions as the npm grammar packages, and the Swift fork carries the
   scanner fix.
4. **`npm run smoke` passes** on the WASM backend: parses and edits a Swift and
   a Kotlin fixture, asserts the output re-parses and that re-running is a
   no-op, and asserts `#if DEBUG` parses.
5. **`npm run plugins` passes**: the community-plugin suite from
   expo/config-plugins.

## Notes

- **The `.wasm` grammars are build output, not in git.** CI builds them on
  every release. To change a grammar: update the fork, move the submodule
  pointer, commit that, and the next tag picks it up. Locally:

  ```sh
  git submodule update --init --recursive
  source /path/to/emsdk/emsdk_env.sh
  npm run build:wasm
  npm run grammar-sync     # keep the npm grammar devDeps on the same version
  ```

- **`.gitignore` lists both `.wasm` files, and npm still publishes them.**
  npm's `files` allowlist takes precedence over `.gitignore`, so the tarball
  contains them even though git does not. Verified; the tarball check in CI
  guards it anyway.

- **CI artifacts are not byte-compared against a local build.** emscripten
  output is not guaranteed identical across host platforms, so the gates are
  behavioural — `smoke` and `plugins` run against the freshly built artifacts,
  and their digests are printed in the build log for provenance.

- **The Swift fork carries scanner fixes.** Upstream's
  `external_scanner_create()` calls `calloc(0, sizeof(struct ScannerState))`,
  which allocates zero bytes; without the fix every `#` token fails in WASM.
  `build-wasm.sh` refuses to build a submodule missing it, and the smoke test
  asserts `#if DEBUG` parses, so an unpatched grammar cannot ship.
  [`scanner-calloc.patch`](./scanner-calloc.patch) is the standalone diff kept
  for upstreaming. The Kotlin grammar needs no patch — its scanner is stateless.

- **`grammar-sync` guards a real hazard.** The `.wasm` comes from `grammars/`
  and the native backend used for diffing comes from the npm grammar packages.
  If they drift to different versions, the equivalence tests compare nothing.
  CI runs `npm run grammar-sync` before publishing.

- **Only `web-tree-sitter` is a runtime dependency.** `tree-sitter` and the two
  native grammar packages are devDependencies, used to diff WASM against native.
  Consumers install no native addon and no platform prebuilds.

- **`.npmrc` sets `legacy-peer-deps=true`.** Both grammar packages pin stale
  `tree-sitter` peer ranges (`^0.22.1` Swift, `^0.22.4` Kotlin) against the
  0.25.1 runtime, so `npm ci` fails without it. This affects development only.

- **Pin the `web-tree-sitter` version deliberately.** Parser error-recovery
  behaviour changes between tree-sitter runtime versions — see §6 of
  [FINDINGS.md](./FINDINGS.md). Treat a runtime bump as a behaviour change and
  re-run the corpus tools, not just the smoke test.

- **The `swift:*` and `kotlin:*` scripts need a local `expo/expo` checkout** at
  `~/Developer/expo`, because they diff against the real fixtures. They are not
  part of the release gate; `npm run smoke` is.
