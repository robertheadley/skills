# Universal Capability Map

A lightweight, machine-readable, evidence-backed model of what a software
product actually supports. Capabilities are stable, named **claims** about
observable product behavior; **evidence** records prove or disprove each
claim; current state is derived from the active evidence, never from
vibes.

> What can this product actually do right now, and what evidence supports
> that claim?

Works for any software product: desktop applications, web applications,
APIs, CLIs, libraries, games, plugins/extensions, internal tools, agent
systems, and more.

## What you get

- **Five states** — `unknown`, `not_implemented`, `partial`, `implemented`,
  `verified` — with `deprecated` independent of state. Regressions and
  demotions are allowed, but never silently: history stays intact and the
  reason must be explicit.
- **Claims, not labels** — each capability answers "what observable thing
  can the product do?".
- **Evidence that ages** — kinds prove different things (a unit test
  proves behavior in isolation, an e2e test proves integration, a file
  change proves almost nothing). Later FAIL evidence invalidates earlier
  PASS; `supersedes` makes the ordering explicit; ambiguous evidence is
  reported as RECONCILIATION REQUIRED, never guessed.
- **Planning information** — dependencies (`depends_on`, `blocked_by`),
  dimensions ("where is it complete?"), aliases and tags for discovery,
  and `sources` for why a capability exists.
- **A mechanical conscience** — the checker validates the schema, derives
  state from active evidence, and reports gaps, regressions, unknowns,
  blockers, and reconciliation items.

## Quick start

```bash
# 1. Declare the map (see SKILL.md for the full schema)
cat > capabilities.yaml <<'EOF'
capabilities:
  - id: auth-login
    name: Authentication
    area: auth
    claim: A user can sign in with valid credentials.
    status: verified
    evidence: [EV-001]
EOF

# 2. Record evidence
mkdir -p capabilities/evidence
cat > capabilities/evidence/EV-001.json <<'EOF'
{"uid": "EV-001", "capability_id": "auth-login", "kind": "test_result",
 "outcome": "pass", "locator": "tests/test_auth.py", "date": "2026-08-30"}
EOF

# 3. Validate and report
python scripts/check_capabilities.py .           # exit 0 = consistent
python scripts/check_capabilities.py --report . # areas, gaps, regressions, ...
```

A complete working example lives in [`examples/basic-map/`](examples/basic-map/).

## Checker

```bash
python scripts/check_capabilities.py .                    # validation
python scripts/check_capabilities.py --report .           # human-readable report
python scripts/check_capabilities.py --report --gaps .    # filtered report
python scripts/check_capabilities.py --report --area workspace .
python scripts/check_capabilities.py --json .             # machine-readable report
```

Filters: `--gaps`, `--regressions`, `--unknown`, `--partial`,
`--deprecated`, `--reconciliation`, `--area AREA`, `--capability ID`.
Exit codes: `0` = consistent, `1` = errors and/or RECONCILIATION REQUIRED.

Requires Python 3.9+ and PyYAML (the only non-stdlib dependency).

## Development

```bash
python tests/run_tests.py   # self-contained checker test suite (stdlib only)
```

## Documentation

- [`SKILL.md`](SKILL.md) — the full methodology: state model, claims,
  dependencies, dimensions, evidence freshness and supersession,
  verification scenarios, UI/support functions as first-class
  capabilities, how coding agents use the map, maintenance, and pitfalls.
- [`examples/basic-map/`](examples/basic-map/) — a valid map exercising the
  full schema.

## License

MIT
