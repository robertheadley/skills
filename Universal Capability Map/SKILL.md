---
name: doofus-capability-map
description: Use when creating or maintaining a Universal Capability Map.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [capabilities, product-map, evidence, verification, standalone]
    related_skills: [hermes-agent-skill-authoring]
---

# Universal Capability Map (Doofus style)

## When to Use

- Starting work that needs a product-wide picture of what actually works —
  create the map first, keep it current as you go.
- After any completed change or release — update evidence and statuses so
  the map reflects reality.
- Auditing an existing map — run the checker and reconcile statuses with
  evidence.
- Don't use for task-level tracking (requirements/backlog) or for
  implementation planning that doesn't need evidence-backed status.

## What it is

The Universal Capability Map is the product-wide answer to "what can this
product actually do?". Requirements tell a task what it promised; the map
tells the product what it delivers. It is:

- **Universal** — covers every capability in every area, including ones that
  are not yet implemented. A gap on the map is a plan, not an omission.
- **Evidence-backed** — a capability is never "implemented" because a
  function with the right name exists. Status moves only through evidence.
- **Persistent** — plain files committed with the project; the map survives
  tasks, sessions, and releases.
- **Strictly forward** — status is a lattice: `not_implemented` →
  `implemented` → `verified`. Never demote silently; regression is recorded
  as FAIL evidence and flagged, not hidden.

## The promotion gate (hard rule)

| target | requires |
| --- | --- |
| `implemented` | ≥1 linked evidence with outcome `pass` |
| `verified` | the above AND ≥1 **verification-level** evidence with outcome `pass` AND a `verified_by` note (task / PR / release that verified it) |

`verified` is never earned by a bare file edit — only by verification-level
evidence (`test_result`, `review`, `manual`). This is the same
`implemented != tested != verified` invariant the evidence kinds encode.

## Project layout (everything plain files)

```
capabilities.yaml                  # declaration + declared status
capabilities/evidence/EV-001.json  # one evidence record per file
```

`capabilities.yaml`:

```yaml
capabilities:
  - id: auth-login
    name: Login
    area: auth
    description: Authenticated login flow
    status: implemented            # declared; must equal what evidence derives
    evidence: [EV-001]
    verified_by: ""                # task/PR/release ref — required for verified
    # dimensions (optional, informational):
    dimensions:
      backend: implemented
      api: implemented
      ui: partial
      tests: implemented
      docs: implemented
```

`capabilities/evidence/EV-001.json`:

```json
{
  "uid": "EV-001",
  "capability_id": "auth-login",
  "kind": "test_result",
  "outcome": "pass",
  "locator": "tests/test_auth.py",
  "date": "2026-08-30"
}
```

Evidence kinds and their level: `file_change`, `command_result`,
`diagnostic` → **implementation**; `test_result`, `review`, `manual` →
**verification**. Outcome is `pass` | `fail` | `unknown` (default
`unknown` — never counts as evidence for promotion).

## Method — create the map

1. **Inventory.** From the product spec (architecture, port-source table,
   feature lists) enumerate every user-visible behavior the product must
   support, grouped by area. Cover the whole product: implemented, partial,
   and not-yet-started. One capability = one user-visible behavior, with a
   stable kebab-case id (e.g. `auth-login`, `panel-docking`).
   Completion: every spec'd behavior appears exactly once.

2. **Declare.** Write `capabilities.yaml` as above — every capability with
   `status: not_implemented` and `evidence: []` initially. The engine
   (checker) enforces one status per capability; when per-dimension
   granularity matters (backend / api / ui / tests / docs), split into
   sibling capabilities (`panel-docking-backend`, `panel-docking-ui`) or
   record the split in `dimensions`.
   Completion: file parses and the checker runs clean.

3. **Evidence.** When a capability exists and works, write an evidence JSON
   under `capabilities/evidence/` (prefer `test_result` with the actual
   test file as `locator`) and add its `uid` to the capability's
   `evidence` list. Never reference an evidence file that does not exist.
   Completion: every promoted capability has ≥1 resolving evidence ref.

4. **Promote to implemented.** Set `status: implemented` in the YAML —
   only when step 3's evidence (outcome `pass`) is in place. The checker
   will reject a status the evidence does not support.

5. **Promote to verified.** Only when a task / PR / release actually
   verified the capability: add verification-level evidence (e.g. a
   `review` or fresh `test_result`) AND set `verified_by` to that task /
   PR / release reference. Never promote on a bare file edit.

6. **Commit the map.** Commit `capabilities.yaml` and the evidence files
   with the change that created/updated the capability — the map and its
   proof are declarative knowledge. Never commit runtime traces or logs
   into the evidence directory.

## Automatic maintenance — keep the map current

Statuses change only through the gate, never by hand-editing to make the
checker pass. Wire these triggers into the normal completion flow so the
map updates in the same turn as the work — a map maintained only
"sometimes" is a manual document again.

1. **Every change / task completion.** Run the affected tests. For each
   capability with passing results, write the `test_result` evidence,
   reference it, and promote to `implemented`. Then run the checker.
2. **On VERIFIED task / PR / release.** When a task or release is
   verified, add verification-level evidence and set `verified_by` so the
   capability reaches `verified` in the same change.
3. **On regression.** A failing test means: write the FAIL evidence (never
   delete or edit old evidence), re-run the checker — it flags the
   mismatch. Then either fix and add fresh pass evidence, or demote with an
   explicit `regression:` note in the description. Never silently edit a
   status down.
4. **Session start / periodic.** Run the checker. Reconcile: every YAML
   capability present, every `implemented` / `verified` status explainable
   by resolving evidence. Investigate anything that is not.
5. **Spec changes.** When the product spec adds or changes behavior, extend
   `capabilities.yaml` in the same change. Never delete a capability id —
   ids are stable identifiers; add `deprecated: true` instead.

## Reading and using the map

The map is a decision surface, not a trophy. Read it before planning,
building, shipping, or answering "does the product support X?".

**How to read a status:**

- `not_implemented` — promised or planned, no working evidence yet. A gap.
- `implemented` — exists and works, backed by pass evidence (tests, command
  results).
- `verified` — additionally confirmed by an independent task / PR / release;
  `verified_by` says which. Stronger than "we tested it".
- `deprecated: true` — historical, not planned anymore; kept for
  traceability.
- Dimensions tell you WHERE a capability is thin: `backend: implemented`
  with `ui: partial` means the backend exists but the surface does not.

**How to read the evidence:**

- Follow `evidence` refs to the JSON files: `kind` says what proved it
  (`test_result` outranks `manual`), `locator` points at the artifact (test
  file, command), `date` says when.
- FAIL evidence = a regression the map is not allowed to hide.
- An evidence ref with no file (the checker flags it) = the claim lost its
  proof — treat the status as unproven until re-recorded.

**How to use it:**

1. **Before building** — check whether the capability already exists. If
   `implemented`, don't rebuild: extend the evidence. If thin (partial
   dimension), finish the thin part instead of starting over.
2. **Planning / roadmap** — the diff between the product spec and the map
   IS the roadmap: every `not_implemented` gap is planned work or a
   deliberate exclusion. Prioritize against gaps, not vibes.
3. **Release readiness** — a release claims capabilities; ship only the
   ones whose status + evidence back the claim. `verified` + `verified_by`
   is what a changelog or release note should cite.
4. **Answering questions** — "does the product support X?" is answered from
   the map: status + evidence locators, never from memory. A question with
   no capability is answered "not implemented" — which is also a product
   gap to surface, not hide.
5. **Onboarding / handoff** — a new session or contributor reads the map
   and the evidence trail instead of re-discovering the product. The map is
   durable product knowledge; keep it committed and current.
6. **Audit** — when a claim is challenged, the map is the single source of
   truth: status must be derivable from linked evidence (the checker
   enforces it). Anything else is opinion.

## Mechanical check

Run the bundled checker after every map change and at session start:

```bash
python <skill_dir>/scripts/check_capabilities.py <project_root>
```

It validates: YAML parses and every capability has `id`/`name`/`area`;
every evidence ref resolves to a file; every evidence file targets a known
capability; declared status equals the status the evidence derives;
`verified` has verification-level pass evidence and `verified_by`; FAIL
evidence is flagged as a regression. Exit code 0 = consistent, 1 =
problems (each printed as `[x] ...`). Requires PyYAML (`pip install pyyaml`
if missing).

For a human-readable readout — the quick way to READ the map before
planning, release, or at session start:

```bash
python <skill_dir>/scripts/check_capabilities.py --report <project_root>
```

Prints capabilities grouped by area with their status, status counts, the
gap list (`not_implemented`), and any regressions — same exit-code
semantics as the plain check.

## Pitfalls

- Declaring `implemented` with no pass evidence → checker error. That is
  the design: add evidence first.
- An evidence ref without a file (or an evidence file nothing references)
  → stale; the checker flags it.
- `verified` without `verified_by`, or `verified_by` without
  verification-level pass evidence → checker error.
- `file_change` / `command_result` evidence is implementation-level; only
  `test_result`, `review`, `manual` can support `verified`.
- Deleting or rewriting old evidence to hide a regression is worse than the
  regression — append FAIL evidence and let the map tell the truth.
- Editing a status to match a wish instead of the evidence: the checker
  derives status from evidence and will not agree.

## Verification

- [ ] `python <skill_dir>/scripts/check_capabilities.py .` exits 0.
- [ ] Every capability in the YAML appears exactly once with a stable id.
- [ ] Every `implemented` capability has ≥1 resolving pass evidence.
- [ ] Every `verified` capability has verification-level pass evidence and
      a `verified_by` reference.
- [ ] No FAIL evidence is ignored; each is answered by a fix + pass
      evidence or an explicit `regression:` note.
- [ ] Map reflects the last completed change (statuses match fresh
      evidence), and the map + evidence are committed.
