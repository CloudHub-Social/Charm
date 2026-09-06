#!/bin/zsh
set -euo pipefail

archive="${1:?usage: fix-ios-swiftrs-archive.sh /path/to/libapp.a}"

if [[ ! -f "$archive" ]]; then
  print -u2 "SwiftRs archive fix: missing archive: $archive"
  exit 1
fi

# Xcode 27's linker cannot satisfy swift-rs' runtime references when every
# duplicate SwiftRs.o member keeps the helper functions local. Export one copy
# and leave the remaining plugin copies local to avoid duplicate definitions.
if xcrun nm "$archive" 2>/dev/null | grep ' T _release_object$' >/dev/null; then
  exit 0
fi

host="$(rustc -vV | sed -n 's/^host: //p')"
tool_dir="$(rustc --print sysroot)/lib/rustlib/$host/bin"
ar_tool="$tool_dir/llvm-ar"
objcopy_tool="$tool_dir/llvm-objcopy"
scratch="$(mktemp -d)"

cleanup() {
  [[ -f "$scratch/SwiftRs.o" ]] && unlink "$scratch/SwiftRs.o"
  [[ -d "$scratch" ]] && rmdir "$scratch"
}
trap cleanup EXIT

cd "$scratch"
"$ar_tool" xN 1 "$archive" SwiftRs.o
"$ar_tool" dN 1 "$archive" SwiftRs.o
"$objcopy_tool" \
  --globalize-symbol=_release_object \
  --globalize-symbol=_retain_object \
  --globalize-symbol=_string_from_bytes \
  SwiftRs.o
"$ar_tool" q "$archive" SwiftRs.o
"$ar_tool" s "$archive"

if ! xcrun nm "$archive" 2>/dev/null | grep ' T _release_object$' >/dev/null; then
  print -u2 "SwiftRs archive fix did not export the runtime helper symbols"
  exit 1
fi
