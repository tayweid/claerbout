#!/bin/bash
# Complete a Claerbout app with Electron's framework (APP.md, "Electron, one
# shell for Claerbout"). An app ships without it (286 of Electron's 288 MB);
# this puts it in: cloned from an installed Claerbout app with the same
# bytes on the same volume, which on APFS takes no space, or else
# downloaded from Electron's release on GitHub and checked against its
# published SHA-256 sums and the hash the app records.
#
#   complete.sh <App.app> [status-file] [sibling.app ...]
#
# Run by the app's launcher on a launch that finds no framework, and by the
# install line. With a status file, progress goes there as "percent|text"
# lines (percent empty when unknown), for the launcher's window. Apps named
# after it are looked at first as siblings: the install line names the app
# an update replaces.
#
# Overrides, for testing: CLAERBOUT_SIBLINGS (folders to look in for a
# sibling instead of the Applications folders; empty means none),
# ELECTRON_MIRROR (where Electron's releases are).
set -euo pipefail

app="${1:?usage: complete.sh <App.app> [status-file] [sibling.app ...]}"
status="${2:-/dev/null}"
shift $(( $# < 2 ? $# : 2 ))
mirror="${ELECTRON_MIRROR:-https://github.com/electron/electron/releases/download}"
framework="Electron Framework.framework"
target="$app/Contents/Frameworks/$framework"
# The framework is put together beside its place and renamed into it only
# once whole and checked, so the launcher's test (does the framework's
# binary exist?) can never find a half-copied one: a completion quit or
# slept through midway leaves only this, which the next launch replaces.
incoming="$app/Contents/Frameworks/.$framework.incoming"

say() { printf '%s|%s\n' "$1" "$2" >> "$status"; }
die() { printf 'complete.sh: %s\n' "$*" >&2; exit 1; }
plist() { /usr/libexec/PlistBuddy -c "Print :$2" "$1/Contents/Info.plist" 2>/dev/null || true; }
binary_hash() { shasum -a 256 "$1/Versions/A/Electron Framework" 2>/dev/null | cut -d' ' -f1; }
volume() { stat -f %d "$1" 2>/dev/null; }

version="$(plist "$app" ClaerboutElectronVersion)"
expected="$(plist "$app" ClaerboutFrameworkSHA256)"
[ -n "$version" ] && [ -n "$expected" ] || die "$app does not say which Electron it needs."
case "$(uname -m)" in
    arm64) arch=arm64 ;;
    *) arch=x64 ;;
esac

if [ -d "$target" ] && [ "$(binary_hash "$target")" = "$expected" ]; then
    exit 0
fi
rm -rf "$target" "$incoming"

# Whole, checked, then renamed into place (a rename within a folder is
# atomic).
place() {
    [ "$(binary_hash "$incoming")" = "$expected" ] || die "the copied Electron does not match the build this app expects."
    mv "$incoming" "$target"
}

# A sibling: a Claerbout app on the same Electron version, on the same volume
# (a clone cannot cross volumes), whose framework is the exact bytes this app
# was built against.
here="$(volume "$app")"
candidates=("$@")
if [ -n "${CLAERBOUT_SIBLINGS+set}" ]; then
    for folder in $CLAERBOUT_SIBLINGS; do candidates+=("$folder"/*.app); done
else
    candidates+=(/Applications/*.app "$HOME/Applications"/*.app)
fi
for candidate in ${candidates[@]+"${candidates[@]}"}; do
    fw="$candidate/Contents/Frameworks/$framework"
    [ -d "$fw" ] || continue
    [ "$(plist "$candidate" ClaerboutElectronVersion)" = "$version" ] || continue
    [ "$(volume "$candidate")" = "$here" ] || continue
    [ "$(binary_hash "$fw")" = "$expected" ] || continue
    say 100 "Sharing Electron with $(basename "$candidate" .app)…"
    # -c clones (APFS): a complete, independent copy that takes no space
    # until one side changes. Falls back to an ordinary copy by itself.
    cp -Rc "$fw" "$incoming" || die "could not copy Electron from $(basename "$candidate")."
    place
    echo "shared Electron $version with $candidate"
    exit 0
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
release="electron-v$version-darwin-$arch.zip"
url="$mirror/v$version/$release"
fetch() { # fetch <url-or-path> <file>
    case "$1" in
        http*) curl -fsSL -o "$2" "$1" ;;
        *) cp "$1" "$2" ;;
    esac
}
fetch "$mirror/v$version/SHASUMS256.txt" "$work/SHASUMS256.txt" \
    || die "could not download Electron's checksums — check the connection."
sum="$(grep " \*\{0,1\}$release\$" "$work/SHASUMS256.txt" | cut -d' ' -f1)"
[ -n "$sum" ] || die "Electron's checksums do not list $release."

say 0 "Downloading Electron $version…"
case "$url" in
    http*)
        size="$(curl -fsSLI "$url" | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')"
        curl -fsSL -o "$work/$release" "$url" &
        download=$!
        while kill -0 "$download" 2>/dev/null; do
            if [ "$size" -gt 0 ] && [ -f "$work/$release" ]; then
                have="$(stat -f %z "$work/$release")"
                say "$((have * 100 / size))" "Downloading Electron $version ($((have / 1048576)) of $((size / 1048576)) MB)…"
            fi
            sleep 0.3
        done
        wait "$download" || die "could not download Electron — check the connection."
        ;;
    *) cp "$url" "$work/$release" || die "could not read $url." ;;
esac
say "" "Checking Electron…"
[ "$(shasum -a 256 "$work/$release" | cut -d' ' -f1)" = "$sum" ] \
    || die "the Electron download does not match its published checksum."
mkdir "$work/electron"
ditto -x -k "$work/$release" "$work/electron"
[ "$(binary_hash "$work/electron/Electron.app/Contents/Frameworks/$framework")" = "$expected" ] \
    || die "Electron's release is not the build this app expects."
ditto "$work/electron/Electron.app/Contents/Frameworks/$framework" "$incoming"
place
say 100 "Starting…"
echo "downloaded Electron $version into $app"
