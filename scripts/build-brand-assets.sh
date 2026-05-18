#!/bin/bash
set -e

# ensure we're using svgexport or similar
npx svgexport brand/avatar.svg brand/avatar.png 280:280
npx svgexport brand/favicon.svg brand/favicon.png 120:120

echo "Brand assets generated"
