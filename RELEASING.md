# Releasing `native-ast`

Releases are automated. Push a `vX.Y.Z` tag to run
[.github/workflows/release.yml](.github/workflows/release.yml), which verifies
the tarball and publishes to npm.

There is no build step — `src/` is plain CommonJS and the `.wasm` grammars are
committed — so CI publishes from a plain checkout.

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

# 2. Sanity-check the tarball contents. Both .wasm files must be listed.
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
2. **Both `.wasm` grammars are in the tarball.** They are the whole package —
   a tarball without them installs and then fails at `Language.load`.
3. **`npm run smoke` passes** on the WASM backend: parses and edits a Swift and
   a Kotlin fixture, asserts the output re-parses and that re-running is a
   no-op, and asserts `#if DEBUG` parses (see the patch note below).

## Notes

- **The `.wasm` grammars are committed to git.** CI publishes them from a plain
  checkout and does not need emscripten. After changing a grammar version or
  the patch, run `npm run build:wasm` (needs emsdk on `PATH`) and commit the
  new `tree-sitter-swift.wasm` / `tree-sitter-kotlin.wasm`.

- **`tree-sitter-swift.wasm` carries a patch.** `build-wasm.sh` applies
  [`scanner-calloc.patch`](./scanner-calloc.patch) before compiling: upstream's
  `external_scanner_create()` calls `calloc(0, sizeof(struct ScannerState))`,
  which allocates zero bytes, and without the fix every `#` token fails in
  WASM. The smoke test asserts `#if DEBUG` parses, so an unpatched rebuild
  fails CI rather than shipping. The Kotlin grammar needs no patch — its
  scanner is stateless.

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
