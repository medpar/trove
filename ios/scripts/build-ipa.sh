#!/bin/bash
# Builds an unsigned Trove.ipa for sideloading (LiveContainer, SideStore, AltStore sign it on install).
#   ios/scripts/build-ipa.sh [output dir]      (default: ios/build)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-$PWD/build}"
DERIVED="$OUT/DerivedData"
mkdir -p "$OUT"

xcodebuild -project Trove.xcodeproj -scheme Trove -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  build | grep -E "error:|warning:|BUILD (SUCCEEDED|FAILED)" || true

APP="$DERIVED/Build/Products/Release-iphoneos/Trove.app"
[ -d "$APP" ] || { echo "Build failed: $APP not found" >&2; exit 1; }

STAGE="$(mktemp -d)"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
rm -f "$OUT/Trove.ipa"
(cd "$STAGE" && zip -qry "$OUT/Trove.ipa" Payload)
rm -rf "$STAGE"

VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Info.plist")
echo "Trove $VERSION -> $OUT/Trove.ipa ($(du -h "$OUT/Trove.ipa" | cut -f1))"
