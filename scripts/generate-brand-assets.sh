#!/bin/bash
set -e

# Requirements: ImageMagick (convert) or rsvg-convert
# Fallback to pure node/puppeteer if needed, but assuming a standard environment first

if ! command -v rsvg-convert &> /dev/null; then
    echo "rsvg-convert could not be found. Install it first (e.g., sudo apt-get install librsvg2-bin)"
    exit 1
fi

echo "Generating PNG components from SVGs..."

# Generate Avatar (280x280)
rsvg-convert -w 280 -h 280 -f png -o brand/avatar.png brand/logo-mark.svg

# Generate Favicon (64x64)
# rsvg-convert -w 64 -h 64 -f png -o brand/favicon.png brand/logo-mark.svg
# Note: we are using logo-mark.svg as the canonical source.

echo "Done."
