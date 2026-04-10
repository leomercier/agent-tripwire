#!/usr/bin/env bash
set -e

SKILL_DIR="${HOME}/.openclaw/workspace/skills/agent-tripwire"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "▸ Installing agent-tripwire CLI..."
npm install
npm run build
npm link

echo "▸ Installing openclaw skill..."
mkdir -p "$SKILL_DIR"
cp "$SCRIPT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"

echo ""
echo "✓ agent-tripwire installed"
echo ""
echo "  CLI:   atw --help"
echo "  Skill: $SKILL_DIR/SKILL.md"
echo ""
echo "  Reload openclaw to pick up the skill:"
echo "    openclaw gateway restart"
echo "    openclaw skills list | grep tripwire"
