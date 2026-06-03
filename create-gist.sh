#!/bin/bash
# Run this ONCE to create the public gist, then delete this file.
# Requires: gh CLI (brew install gh && gh auth login)

GIST_URL=$(gh gist create CURRENT_WORK.md --public --desc "RPOS session handoff for Claude" 2>&1 | grep "gist.github.com")
GIST_ID=$(echo $GIST_URL | grep -oE '[a-f0-9]{32}')

echo ""
echo "✅ Gist created: $GIST_URL"
echo ""
echo "👉 At the start of every new Claude chat, paste this URL:"
echo "   https://gist.githubusercontent.com/Serv-OS/$GIST_ID/raw/CURRENT_WORK.md"
echo ""
echo "👉 At the end of every session, run:"
echo "   gh gist edit $GIST_ID CURRENT_WORK.md"
echo ""
