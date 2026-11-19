#!/usr/bin/env bash
# Tests the skill the way a customer uses it.
#
# A fresh Claude Code session is given only the built skill and a copy of an
# uninstrumented demo service, and is asked to set metrics up. Nothing else
# from this repository is visible to it. The result is left in a temporary
# directory for you to review and, if it is good, copy over the instrumented
# demo service.
#
#   scripts/test-skill.sh checkout-node
#   scripts/test-skill.sh inventory-python
#
# Then, to check the result on the running stack:
#   1. copy the printed directory over infra/demo/<service>
#   2. make dev
#   3. pnpm conformance
#
# Needs the `claude` command, signed in. It spends model usage.
set -euo pipefail

service="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
baseline="$root/infra/demo/baseline/$service"
if [[ -z "$service" || ! -d "$baseline" ]]; then
  echo "Usage: scripts/test-skill.sh <$(ls "$root/infra/demo/baseline" | grep -v README | paste -sd'|' -)>" >&2
  exit 2
fi

cd "$root"
product="$(node --input-type=module -e "import('./packages/config/src/product.ts').then((m) => console.log(m.PRODUCT_NAME))")"
slug="$(node --input-type=module -e "import('./packages/config/src/product.ts').then((m) => console.log(m.PRODUCT_SLUG))")"
pnpm --silent skill:build

# What the owner of each service asks for, beyond the standard metrics.
case "$service" in
  checkout-node) extra="I also want to track orders completed, by payment method." ;;
  inventory-python) extra="I also want to see the stock level per warehouse, and how long the restock job takes." ;;
  *) extra="" ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/skill-test-$service-XXXXXX")"
cp -R "$baseline/." "$work/"
mkdir -p "$work/.claude/skills"
cp -R "$root/skill/dist/$slug-metrics" "$work/.claude/skills/"

echo "Running Claude Code with only the skill, in $work"
(
  cd "$work"
  claude --print "Set up $product metrics for this service. $extra" \
    --permission-mode acceptEdits \
    --allowedTools "Read,Write,Edit,Glob,Grep,Bash"
)

rm -rf "$work/.claude" "$work/node_modules" "$work/.venv"
echo
echo "Result: $work"
echo "Compare: diff -ru $baseline $work"
