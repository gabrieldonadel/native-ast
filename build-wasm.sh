#!/bin/bash
# Build the Swift and Kotlin grammars to WASM.
# Requires emscripten on PATH (emsdk). Swift needs a scanner patch; Kotlin does not.
set -euo pipefail
CLI="npx --yes tree-sitter-cli@0.25.10"

build() {                       # build <grammar-dir> <out.wasm> <patch?>
  local src="$1" out="$2" patch="${3:-}"
  local work; work=$(mktemp -d)
  cp -R "$src"/. "$work"/
  if [ -n "$patch" ]; then
    # See scanner-calloc.patch: calloc(0, ...) allocates zero bytes, so the
    # scanner state is read out of bounds. Benign on macOS, fatal in WASM.
    sed -i '' 's|return calloc(0, sizeof(struct ScannerState));|return calloc(1, sizeof(struct ScannerState));|' "$work/src/scanner.c"
    grep -q 'calloc(1, sizeof(struct ScannerState))' "$work/src/scanner.c" || { echo "patch did not apply"; exit 1; }
  fi
  $CLI build --wasm -o "$out" "$work"
  rm -rf "$work"
  ls -la "$out"
}

build node_modules/tree-sitter-swift                              tree-sitter-swift.wasm  patch
build node_modules/@tree-sitter-grammars/tree-sitter-kotlin       tree-sitter-kotlin.wasm
