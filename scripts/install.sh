#!/bin/sh
# Noushi CLI installer: downloads the standalone binary for this platform
# from GitHub Releases and installs it to ~/.noushi/bin.
#
# Usage:
#   curl -fsSL <raw-url>/install.sh | sh
#   curl -fsSL <raw-url>/install.sh | sh -s -- --version v0.1.0 --dir /usr/local/bin
#
# Env:
#   NOUSHI_INSTALL_DIR   target directory (default ~/.local/bin)
#   NOUSHI_VERSION       release tag (default latest)
set -eu

REPO="ens-Emilio/NoushiCLI"
DEFAULT_DIR="${HOME}/.local/bin"
TARGET_DIR="${NOUSHI_INSTALL_DIR:-$DEFAULT_DIR}"
VERSION="${NOUSHI_VERSION:-latest}"

print_help() {
	sed -n '2,12p' "$0"
	exit 0
}
for arg in "$@"; do
	case $arg in
	--help | -h) print_help ;;
	--version)
		shift
		VERSION="${1:?--version requires a value}"
		shift
		;;
	--dir)
		shift
		TARGET_DIR="${1:?--dir requires a value}"
		shift
		;;
	*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
Linux) os="linux" ;;
Darwin) os="darwin" ;;
*)
	echo "Unsupported OS: $OS. Use npm: npm install -g --ignore-scripts @noushi/cli" >&2
	exit 1
	;;
esac
case "$ARCH" in
x86_64 | amd64) arch="x64" ;;
aarch64 | arm64) arch="arm64" ;;
*)
	echo "Unsupported architecture: $ARCH." >&2
	exit 1
	;;
esac
platform="$os-$arch"

if [ "$VERSION" = "latest" ]; then
	url="https://github.com/$REPO/releases/latest/download/noushi-$platform.tar.gz"
else
	case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
	url="https://github.com/$REPO/releases/download/$VERSION/noushi-$platform.tar.gz"
fi

echo "==> Installing Noushi ($platform${VERSION:+ $VERSION})"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "==> Downloading $url"
curl -fsSL "$url" -o "$tmp/noushi.tar.gz"

tar -xzf "$tmp/noushi.tar.gz" -C "$tmp"
binary="$tmp/pi/noushi"
if [ ! -f "$binary" ]; then
	binary="$tmp/pi/pi"
fi
if [ ! -f "$binary" ]; then
	echo "Installer archive did not contain the Noushi executable." >&2
	exit 1
fi

mkdir -p "$TARGET_DIR"
install -m 0755 "$binary" "$TARGET_DIR/noushi"
# Runtime assets the binary resolves next to itself (themes, export templates, docs).
for asset in package.json theme assets export-html; do
	src="$tmp/pi/$asset"
	if [ -e "$src" ]; then
		dirname="$TARGET_DIR"
		case "$asset" in
		theme) dirname="$TARGET_DIR/theme" ;;
		assets) dirname="$TARGET_DIR/assets" ;;
		export-html) dirname="$TARGET_DIR/export-html" ;;
		esac
		mkdir -p "$dirname"
		cp -R "$src/." "$dirname/" 2>/dev/null || cp -R "$src" "$dirname/"
	fi
done
[ -f "$tmp/pi/photon_rs_bg.wasm" ] && install -m 0644 "$tmp/pi/photon_rs_bg.wasm" "$TARGET_DIR/photon_rs_bg.wasm"

echo "==> Installed $TARGET_DIR/noushi"
case ":$PATH:" in
*":$TARGET_DIR:"*) ;;
*) echo "NOTE: $TARGET_DIR is not on your PATH. Add: export PATH=\"$TARGET_DIR:\$PATH\"" ;;
esac
"$TARGET_DIR/noushi" --version
