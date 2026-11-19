# Baseline demo services

The demo services as a customer would have them **before** installing the skill:
working services with no metrics at all.

They exist to test the skill. `scripts/test-skill.sh` gives a fresh Claude Code
session only the built skill and a copy of one of these, and asks it to set
metrics up. The result is checked against the convention on the running stack
(`pnpm conformance`). The instrumented services next to this directory
(`../checkout-node`, `../inventory-python`) are the output of that test.

Do not add metrics here.
