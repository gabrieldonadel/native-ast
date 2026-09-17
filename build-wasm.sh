#!/bin/bash
# Build the Swift and Kotlin grammars to WASM from the submodules in grammars/.
#
# The submodules are our forks, pinned to a commit. The Swift fork carries the
# scanner fixes on its `native-ast` branch, so there is no patching here — what
# is checked out is what gets built. Requires emscripten on PATH (emsdk).
set -euo pipefail

CLI="npx --yes tree-sitter-cli@0.25.10"

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc not found. Activate emsdk first, e.g.:" >&2
  echo "  source /path/to/emsdk/emsdk_env.sh" >&2
  exit 1
fi

for sub in grammars/tree-sitter-swift grammars/tree-sitter-kotlin; do
  if [ ! -f "$sub/src/parser.c" ]; then
    echo "$sub/src/parser.c missing. Run: git submodule update --init --recursive" >&2
    exit 1
  fi
done

# The Swift fix is what makes '#' tokens work in WASM at all, so refuse to
# build an unpatched grammar rather than ship one. See FINDINGS.md §6.
if ! grep -q 'calloc(1, sizeof(struct ScannerState))' grammars/tree-sitter-swift/src/scanner.c; then
  echo "grammars/tree-sitter-swift is missing the scanner calloc fix." >&2
  echo "The submodule should be on the 'native-ast' branch of the fork." >&2
  exit 1
fi

build() {                       # build <submodule> <out.wasm>
  echo "building $2 from $1 ($(git -C "$1" describe --tags --always))"
  $CLI build --wasm -o "$2" "$1"
  ls -la "$2"
}

build grammars/tree-sitter-swift  tree-sitter-swift.wasm
build grammars/tree-sitter-kotlin tree-sitter-kotlin.wasm
