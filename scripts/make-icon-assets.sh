#!/bin/sh
# Compiles the app icon (build/AppIcon.icon, from scripts/make-icon-composer.py) into the app's asset
# catalog, build/Assets.car, so Finder and the Dock show the light or dark icon (and macOS's clear and
# tinted styles) even while Zepper isn't running (build/icon.icns stays the icon for older macOS).
# Needs Xcode 26 or later. Run after changing the icon:
#   python3 scripts/make-icon-composer.py && sh scripts/make-icon-assets.sh
set -e
cd "$(dirname "$0")/.."
out=$(mktemp -d)
xcrun actool build/AppIcon.icon --compile "$out" --platform macosx --minimum-deployment-target 13.0 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist" --output-format human-readable-text
cp "$out/Assets.car" build/Assets.car
rm -rf "$out"
echo "Wrote build/Assets.car"
