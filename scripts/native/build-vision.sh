#!/usr/bin/env bash
# Build cortexos-vision Swift helper and install to ~/.cortexos/bin/.
#
# Phase 8 — screen perception. Swift is optional; if it's not installed the
# rest of cortexOS keeps running and perception features degrade to
# "OCRUnavailableError" / "CaptureUnavailableError".
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="$here/cortexos-vision"
install_dir="${CORTEXOS_BIN_DIR:-$HOME/.cortexos/bin}"
install_path="$install_dir/cortexos-vision"

if ! command -v swift >/dev/null 2>&1; then
  echo "[build-vision] swift toolchain not found — skipping. Install Xcode or swift.org toolchain." >&2
  exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[build-vision] cortexos-vision only builds on macOS (ScreenCaptureKit + Vision are Apple-only)." >&2
  exit 0
fi

echo "[build-vision] building in $pkg_dir"
cd "$pkg_dir"
swift build -c release

binary="$pkg_dir/.build/release/cortexos-vision"
if [[ ! -x "$binary" ]]; then
  echo "[build-vision] build artifact missing at $binary" >&2
  exit 1
fi

mkdir -p "$install_dir"
cp "$binary" "$install_path"
chmod +x "$install_path"
echo "[build-vision] installed to $install_path"
