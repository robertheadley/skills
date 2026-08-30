#!/usr/bin/env python3
"""Validate and report on a Universal Capability Map.

The map is a lightweight, machine-readable, evidence-backed model of what a
software product actually supports. This tool is the mechanical conscience
of that model: it validates the schema, derives current state from active
evidence, flags regressions and conflicts instead of guessing, and reports
the result in a terminal- or machine-readable form.

Usage:
    python check_capabilities.py [ROOT]                   # validation only
    python check_capabilities.py --report [ROOT]          # human-readable report
    python check_capabilities.py --report --gaps [ROOT]   # filtered report
    python check_capabilities.py --report --area workspace [ROOT]
    python check_capabilities.py --report --capability panel-docking [ROOT]
    python check_capabilities.py --json [ROOT]            # machine-readable report

Exit codes:
    0  map is consistent (warnings may still be printed)
    1  structural errors and/or RECONCILIATION REQUIRED items exist

Required non-stdlib dependency: PyYAML (for capabilities.yaml).
"""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - reported at runtime
    yaml = None

# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

STATUSES = ["unknown", "not_implemented", "partial", "implemented", "verified"]
STATUS_ORDER = {s: i for i, s in enumerate(STATUSES)}

# Evidence kinds prove different things. Existence-level kinds show that
# something exists or ran; verification-level kinds demonstrate behavior.
KIND_LEVELS = {
    "implementation": {
        "file_change", "command_result", "diagnostic", "inspection", "build_result",
    },
    "verification": {
        "test_result", "integration_test", "e2e_test", "review", "manual",
        "visual_review", "accessibility_test",
    },
}
ALL_KINDS = frozenset().union(*KIND_LEVELS.values())

OUTCOMES = {"pass", "fail", "unknown"}

SOURCE_TYPES = {
    "spec", "issue", "task", "user_requirement", "design",
    "api_contract", "release", "other",
}

CAP_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

EVIDENCE_FIELDS = {
    "uid", "capability_id", "kind", "outcome", "scenario", "locator", "date",
    "commit", "branch", "version", "environment", "platform", "notes",
    "supersedes", "source_fingerprint",
}


def kind_level(kind: str):
    for level, kinds in KIND_LEVELS.items():
        if kind in kinds:
            return level
    return None


def parse_date(value):
    """Parse ISO date/datetime; return datetime or None when absent/empty."""
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def load_yaml(path: Path):
    if yaml is None:
        raise RuntimeError("PyYAML is required: pip install pyyaml")
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def load_evidence_dir(ev_dir: Path):
    """Return (records_by_uid, problems). records keep their file path."""
    records, problems = {}, []
    if not ev_dir.is_dir():
        return records, problems
    for f in sorted(ev_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            problems.append(f"[error] {f.name}: unparsable JSON ({exc})")
            continue
        if not isinstance(data, dict):
            problems.append(f"[error] {f.name}: evidence must be a JSON object")
            continue
        uid = data.get("uid")
        if not uid:
            problems.append(f"[error] {f.name}: missing evidence 'uid'")
            continue
        if uid in records:
            problems.append(
                f"[error] duplicate evidence uid {uid!r} ({f.name} and {records[uid]['_file']})"
            )
            continue
        data["_file"] = f.name
        records[str(uid)] = data
    return records, problems


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class Findings:
    """Collected errors (fatal), reconciliation items, and warnings."""

    def __init__(self):
        self.errors = []
        self.reconcile = []
        self.warnings = []
        self.regressions = []  # capability ids with latest active FAIL

    def ok(self):
        return not self.errors and not self.reconcile


def validate_capability_ids(caps: dict, findings: Findings):
    seen = set()
    for cid, cap in caps.items():
        if cid in seen:
            findings.errors.append(f"duplicate capability id {cid!r}")
        seen.add(cid)
        if not CAP_ID_RE.match(cid):
            findings.errors.append(
                f"malformed capability id {cid!r} (use lowercase kebab-case, e.g. panel-docking)"
            )
        for field in ("name", "area"):
            if not cap.get(field):
                findings.errors.append(f"{cid}: missing required field {field!r}")
        if not str(cap.get("claim") or "").strip():
            findings.warnings.append(
                f"{cid}: no 'claim' — a capability should answer "
                "'what observable thing can the product do?'"
            )


def validate_aliases_tags(cap: dict, cid: str, findings: Findings):
    for field in ("aliases", "tags"):
        value = cap.get(field)
        if value is None:
            continue
        if not isinstance(value, list) or not all(
            isinstance(item, str) and item.strip() for item in value
        ):
            findings.errors.append(f"{cid}: {field} must be a list of non-empty strings")


def validate_sources(cap: dict, cid: str, findings: Findings):
    sources = cap.get("sources")
    if sources is None:
        return
    if not isinstance(sources, list):
        findings.errors.append(f"{cid}: sources must be a list")
        return
    for src in sources:
        if not isinstance(src, dict):
            findings.errors.append(f"{cid}: each source must be an object with type/locator")
            continue
        stype = str(src.get("type") or "")
        if stype not in SOURCE_TYPES:
            findings.errors.append(
                f"{cid}: invalid source type {stype!r} "
                f"(allowed: {', '.join(sorted(SOURCE_TYPES))})"
            )
        if not str(src.get("locator") or "").strip():
            findings.errors.append(f"{cid}: source record missing 'locator'")


def validate_dimensions(cap: dict, cid: str, findings: Findings):
    dims = cap.get("dimensions")
    if dims is not None:
        if not isinstance(dims, dict):
            findings.errors.append(f"{cid}: dimensions must be a mapping of name -> state")
        else:
            for dim, state in dims.items():
                if str(state) not in STATUSES:
                    findings.errors.append(
                        f"{cid}: dimension {dim!r} has invalid state {state!r} "
                        f"(allowed: {', '.join(STATUSES)})"
                    )
    required = cap.get("required_dimensions")
    if required is not None:
        if not isinstance(required, list) or not all(isinstance(d, str) and d for d in required):
            findings.errors.append(f"{cid}: required_dimensions must be a list of dimension names")
            return
        for dim in required:
            state = str((dims or {}).get(dim, ""))
            if state not in ("implemented", "verified"):
                findings.warnings.append(
                    f"{cid}: required dimension {dim!r} is incomplete ({state or 'missing'})"
                )


def validate_dependencies(caps: dict, findings: Findings):
    for cid, cap in caps.items():
        for field in ("depends_on", "blocked_by"):
            deps = cap.get(field)
            if deps is None:
                continue
            if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
                findings.errors.append(f"{cid}: {field} must be a list of capability ids")
                continue
            for dep in deps:
                if dep == cid:
                    findings.errors.append(f"{cid}: {field} references itself")
                elif dep not in caps:
                    findings.errors.append(f"{cid}: {field} references missing capability {dep!r}")

    # Cycle detection over depends_on (obvious cycles only; DFS with a path).
    def visit(node, path):
        if node in path:
            cycle = " -> ".join(path[path.index(node):] + [node])
            findings.errors.append(f"dependency cycle: {cycle}")
            return
        for dep in (caps.get(node, {}).get("depends_on") or []):
            if dep in caps:
                visit(dep, path + [node])

    for cid in caps:
        visit(cid, [])


def validate_scenarios(cap: dict, cid: str, findings: Findings):
    ver = cap.get("verification")
    if ver is None:
        return
    scenarios = ver.get("scenarios") if isinstance(ver, dict) else None
    if scenarios is None:
        findings.errors.append(f"{cid}: verification must contain a scenarios list")
        return
    if not isinstance(scenarios, list):
        findings.errors.append(f"{cid}: verification.scenarios must be a list")
        return
    seen = set()
    for sc in scenarios:
        if not isinstance(sc, dict) or not sc.get("id"):
            findings.errors.append(f"{cid}: each scenario needs an id")
            continue
        sid = str(sc["id"])
        if sid in seen:
            findings.errors.append(f"{cid}: duplicate scenario id {sid!r}")
        seen.add(sid)


def validate_evidence_records(records: dict, caps: dict, root: Path, findings: Findings):
    superseded_by = defaultdict(list)  # uid -> uids that supersede it
    supersedes_graph = {}

    for uid, rec in records.items():
        cid = rec.get("capability_id")
        if not cid:
            findings.errors.append(f"{uid}: missing 'capability_id'")
        elif cid not in caps:
            findings.errors.append(f"{uid}: targets unknown capability {cid!r}")
        kind = rec.get("kind")
        if not kind:
            findings.errors.append(f"{uid}: missing 'kind'")
        elif kind not in ALL_KINDS:
            findings.errors.append(
                f"{uid}: invalid kind {kind!r} "
                f"(allowed: {', '.join(sorted(ALL_KINDS))})"
            )
        outcome = rec.get("outcome")
        if not outcome:
            findings.errors.append(f"{uid}: missing 'outcome'")
        elif outcome not in OUTCOMES:
            findings.errors.append(
                f"{uid}: invalid outcome {outcome!r} (allowed: pass, fail, unknown)"
            )
        date_value = rec.get("date")
        if date_value is not None and parse_date(date_value) is None:
            findings.errors.append(f"{uid}: malformed date {date_value!r} (use ISO YYYY-MM-DD)")
        for field in rec:
            if field not in EVIDENCE_FIELDS and not field.startswith("_"):
                findings.warnings.append(f"{uid}: unknown evidence field {field!r}")

        supersedes = rec.get("supersedes") or []
        if isinstance(supersedes, str):
            supersedes = [supersedes]
        if not isinstance(supersedes, list):
            findings.errors.append(f"{uid}: supersedes must be a list of uids")
            supersedes = []
        supersedes_graph[uid] = [str(s) for s in supersedes]
        for target in supersedes_graph[uid]:
            if target not in records:
                findings.errors.append(f"{uid}: supersedes references missing evidence {target!r}")
            elif target == uid:
                findings.errors.append(f"{uid}: supersedes itself")
            else:
                superseded_by[target].append(uid)

        scenario = rec.get("scenario")
        if scenario is not None and cid in caps:
            cap = caps[cid]
            declared = set()
            ver = cap.get("verification")
            if isinstance(ver, dict) and isinstance(ver.get("scenarios"), list):
                declared = {str(s.get("id")) for s in ver["scenarios"] if isinstance(s, dict)}
            if str(scenario) not in declared:
                findings.errors.append(
                    f"{uid}: scenario reference {scenario!r} is not declared by capability {cid!r}"
                )

    # Supersession cycles (including chains A -> B -> A).
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {uid: WHITE for uid in records}

    def visit(uid, path):
        color[uid] = GRAY
        for target in supersedes_graph.get(uid, []):
            if target not in color:
                continue
            if color[target] == GRAY:
                cycle = " -> ".join(path[path.index(target):] + [target])
                findings.errors.append(f"evidence supersession cycle: {cycle}")
            elif color[target] == WHITE:
                visit(target, path + [uid])
        color[uid] = BLACK

    for uid in records:
        if color[uid] == WHITE:
            visit(uid, [])

    return superseded_by


def active_evidence_for(cap: dict, records: dict, superseded_by: dict):
    """Usable (active) evidence records linked to a capability, in no order."""
    refs = [str(r) for r in (cap.get("evidence") or [])]
    active = []
    for ref in refs:
        rec = records.get(ref)
        if rec is None:
            continue  # dangling refs are reported separately
        if ref in superseded_by:
            continue  # superseded: preserved historically, not authoritative
        active.append(rec)
    return active


def derive_status(active: list):
    """Return (derived_status, reason, reconcile_msgs).

    derived_status is None when it cannot be safely derived.
    """
    if not active:
        return None, "no usable evidence", []
    outcomes = {r.get("outcome") for r in active}
    dated = [(parse_date(r.get("date")), r) for r in active]
    if len(outcomes) > 1 and any(d is None for d, _ in dated):
        return None, "ambiguous chronology", [
            "latest PASS and FAIL have ambiguous ordering (active evidence lacks dates)"
        ]
    ordered = sorted(
        dated,
        key=lambda item: (
            item[0] or datetime.min,
            str(item[1].get("commit") or ""),
            str(item[1].get("uid") or ""),
        ),
    )
    latest = ordered[-1][1]
    outcome = latest.get("outcome")
    if outcome == "fail":
        return "not_implemented", f"latest active evidence is FAIL ({latest.get('uid')})", []
    if outcome == "pass":
        level = kind_level(str(latest.get("kind") or ""))
        if level == "verification":
            return "verified", f"latest active verification PASS ({latest.get('uid')})", []
        return "implemented", f"latest active implementation PASS ({latest.get('uid')})", []
    return None, "latest active evidence outcome unknown", [
        f"latest active evidence ({latest.get('uid')}) has unknown outcome"
    ]


def check_status_mismatch(cid: str, declared: str, derived, cap: dict, findings: Findings):
    """Apply the state-change policy:

    - status must never be silently changed to hide history;
    - demotions/regressions are allowed, but the reason must be explicit;
    - claims above what evidence supports are never silently accepted.
    """
    if derived == declared:
        return
    verified_by = cap.get("verified_by")
    legacy_verified = bool(verified_by)  # old maps used verified_by as the gate
    has_reason = bool(str(cap.get("regression") or cap.get("state_change_reason") or "").strip())

    if derived is None:
        if declared in ("unknown", "not_implemented"):
            return
        if declared == "partial":
            findings.warnings.append(
                f"{cid}: declared partial but there is no usable evidence"
            )
            return
        if declared == "verified" and legacy_verified:
            findings.warnings.append(
                f"{cid}: declared verified via verified_by metadata only; "
                "no usable evidence — add verification-level evidence"
            )
            return
        findings.errors.append(
            f"{cid}: declared {declared} but there is no usable evidence to support it"
        )
        return

    if declared == "verified":
        if derived == "implemented":
            if legacy_verified:
                findings.warnings.append(
                    f"{cid}: declared verified via verified_by; active evidence only "
                    "supports implemented — add verification-level evidence"
                )
            else:
                findings.reconcile.append(
                    f"{cid}: declared verified but active evidence only supports implemented"
                )
            return
        # derived == not_implemented falls through to the regression branch
    if declared == "implemented" and derived == "verified":
        findings.warnings.append(
            f"{cid}: active evidence supports verified; consider promoting"
        )
        return
    if declared == "partial" and derived in ("implemented", "verified"):
        findings.warnings.append(
            f"{cid}: active evidence supports {derived}; consider promoting"
        )
        return
    if derived == "not_implemented":
        if has_reason:
            return  # explicit, reason-bearing demotion: allowed by policy
        findings.reconcile.append(
            f"{cid}: latest active evidence is FAIL (regression) but no explicit reason "
            "given — demote with a 'regression:' reason or add newer pass evidence"
        )
        return
    if derived in ("implemented", "verified") and declared in ("unknown", "not_implemented"):
        findings.warnings.append(
            f"{cid}: active evidence supports {derived} but the map says {declared} "
            "— the map is not current"
        )
        return
    findings.reconcile.append(
        f"{cid}: declared {declared} does not match usable evidence (derives {derived})"
    )


def check_scenario_coverage(cap: dict, cid: str, active: list, findings: Findings):
    if str(cap.get("status") or "") != "verified":
        return
    ver = cap.get("verification")
    if not isinstance(ver, dict):
        return
    scenarios = ver.get("scenarios")
    if not isinstance(scenarios, list):
        return
    covered = {
        str(s.get("id"))
        for s in scenarios
        if isinstance(s, dict)
        and any(
            r.get("scenario") == s.get("id")
            and r.get("outcome") == "pass"
            and kind_level(str(r.get("kind") or "")) == "verification"
            for r in active
        )
    }
    for sc in scenarios:
        if not isinstance(sc, dict):
            continue
        sid = str(sc.get("id"))
        if sid not in covered:
            findings.reconcile.append(
                f"{cid}: claims verified but scenario {sid!r} has no verification pass evidence"
            )


def locator_looks_local(locator: str):
    """Heuristic: is this locator plausibly a local filesystem path?"""
    text = locator.split("::", 1)[0].strip()
    if not text:
        return False
    if text.startswith(("#", "http://", "https://", "git@", "ssh://")):
        return False
    if " " in text:  # e.g. "npm run check" or a sentence
        return False
    if text.endswith((".py", ".js", ".ts", ".tsx", ".json", ".md", ".yaml", ".yml", ".toml")):
        return True
    return "/" in text or "\\" in text or text.startswith(".")


def validate_locators(records: dict, caps: dict, root: Path, findings: Findings):
    for uid, rec in records.items():
        locator = rec.get("locator")
        if not locator or not locator_looks_local(str(locator)):
            continue
        path = Path(str(locator).split("::", 1)[0])
        if not path.is_absolute():
            path = root / path
        if not path.exists():
            findings.warnings.append(f"{uid}: local locator not found: {locator!r}")


def build_superseded_set(superseded_by: dict) -> set:
    return set(superseded_by.keys())


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------


def analyze(caps: dict, records: dict, superseded_by: dict, root: Path):
    """Validate + derive. Returns (findings, per-capability analysis)."""
    findings = Findings()
    validate_capability_ids(caps, findings)
    superseded = build_superseded_set(superseded_by)

    per_cap = {}
    for cid, cap in caps.items():
        validate_aliases_tags(cap, cid, findings)
        validate_sources(cap, cid, findings)
        validate_dimensions(cap, cid, findings)
        validate_scenarios(cap, cid, findings)

        refs = [str(r) for r in (cap.get("evidence") or [])]
        for ref in refs:
            if ref not in records:
                findings.errors.append(f"{cid}: dangling evidence reference {ref!r} (no file)")

        active = active_evidence_for(cap, records, superseded_by)
        derived, reason, reconcile_msgs = derive_status(active)
        for msg in reconcile_msgs:
            findings.reconcile.append(f"{cid}: {msg}")

        declared = str(cap.get("status") or "unknown")
        if declared not in STATUSES:
            findings.errors.append(
                f"{cid}: invalid status {declared!r} (allowed: {', '.join(STATUSES)})"
            )
        else:
            check_status_mismatch(cid, declared, derived, cap, findings)

        if derived == "not_implemented" and any(
            r.get("outcome") == "fail" for r in active
        ):
            findings.regressions.append(cid)

        check_scenario_coverage(cap, cid, active, findings)

        per_cap[cid] = {
            "cap": cap,
            "derived": derived,
            "reason": reason,
            "active": active,
        }

    validate_dependencies(caps, findings)
    validate_locators(records, caps, root, findings)

    # Unreferenced evidence files (present on disk, cited by nobody).
    referenced = set()
    for cap in caps.values():
        referenced.update(str(r) for r in (cap.get("evidence") or []))
    unreferenced = sorted(set(records) - referenced)
    for uid in unreferenced:
        findings.warnings.append(f"unreferenced evidence {uid!r} (no capability cites it)")

    return findings, per_cap


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def capability_status(cap: dict) -> str:
    return str(cap.get("status") or "unknown")


def is_blocked(cap: dict, caps: dict) -> list:
    blockers = []
    for dep in (cap.get("depends_on") or []):
        target = caps.get(dep)
        if target is None:
            continue
        if capability_status(target) not in ("implemented", "verified"):
            blockers.append(dep)
    for dep in (cap.get("blocked_by") or []):
        if dep in caps:
            blockers.append(dep)
    return blockers


def build_report(caps: dict, records: dict, superseded_by: dict, per_cap: dict, findings: Findings):
    status_counts = Counter(capability_status(c) for c in caps.values())
    by_area = defaultdict(list)
    for cid, cap in caps.items():
        by_area[str(cap.get("area") or "?")].append(cid)

    gaps = sorted(
        cid for cid, c in caps.items()
        if capability_status(c) == "not_implemented" and not c.get("deprecated")
    )
    unknowns = sorted(cid for cid, c in caps.items() if capability_status(c) == "unknown")
    partials = sorted(cid for cid, c in caps.items() if capability_status(c) == "partial")
    deprecated = sorted(cid for cid, c in caps.items() if c.get("deprecated"))
    regressions = sorted(set(findings.regressions))

    blockers = {cid: is_blocked(cap, caps) for cid, cap in caps.items()}
    blockers = {cid: deps for cid, deps in blockers.items() if deps}

    req_dim_gaps = []
    for cid, cap in caps.items():
        dims = cap.get("dimensions") or {}
        for dim in (cap.get("required_dimensions") or []):
            if str(dims.get(dim, "")) not in ("implemented", "verified"):
                req_dim_gaps.append(f"{cid}:{dim}")

    scenario_coverage = {}
    for cid, cap in caps.items():
        ver = cap.get("verification")
        if isinstance(ver, dict) and isinstance(ver.get("scenarios"), list):
            active = per_cap[cid]["active"]
            scenario_coverage[cid] = {
                str(s.get("id")): any(
                    r.get("scenario") == s.get("id")
                    and r.get("outcome") == "pass"
                    and kind_level(str(r.get("kind") or "")) == "verification"
                    for r in active
                )
                for s in ver["scenarios"]
                if isinstance(s, dict) and s.get("id")
            }

    dependents = defaultdict(int)
    for cap in caps.values():
        for dep in (cap.get("depends_on") or []):
            dependents[dep] += 1
    high_impact = sorted(
        ((dep, n) for dep, n in dependents.items() if n > 1),
        key=lambda item: (-item[1], item[0]),
    )

    superseded_count = len(superseded_by)
    referenced = set()
    for cap in caps.values():
        referenced.update(str(r) for r in (cap.get("evidence") or []))
    unreferenced = sorted(set(records) - referenced)

    return {
        "totals": dict(status_counts),
        "areas": {area: sorted(ids) for area, ids in by_area.items()},
        "gaps": gaps,
        "unknown": unknowns,
        "partial": partials,
        "regressions": regressions,
        "reconciliation": findings.reconcile,
        "deprecated": deprecated,
        "dependency_blockers": blockers,
        "required_dimension_gaps": req_dim_gaps,
        "scenario_coverage": scenario_coverage,
        "evidence": {
            "total": len(records),
            "superseded": superseded_count,
            "unreferenced": len(unreferenced),
        },
        "high_impact_dependencies": high_impact,
    }


def print_human_report(report: dict, findings: Findings, root: Path, filters: dict):
    print(f"Capability map report for {root}")
    totals = report["totals"]
    print("totals: " + " | ".join(f"{s} {totals.get(s, 0)}" for s in STATUSES if totals.get(s, 0)))
    if report["evidence"]["total"]:
        ev = report["evidence"]
        print(
            f"evidence: {ev['total']} records, {ev['superseded']} superseded, "
            f"{ev['unreferenced']} unreferenced"
        )

    def section(title, items, printer=None):
        if filters and title not in filters:
            return
        if not items:
            return
        print(f"\n{title} ({len(items)}):")
        for item in items:
            print(printer(item) if printer else f"  {item}")

    section("areas", sorted(report["areas"]), printer=lambda a: f"  {a}: {', '.join(report['areas'][a])}")
    section("gaps", report["gaps"])
    section("unknown", report["unknown"])
    section("partial", report["partial"])
    section("regressions", report["regressions"])
    section("reconciliation required", report["reconciliation"])
    section("deprecated", report["deprecated"])
    section(
        "dependency blockers",
        sorted(report["dependency_blockers"]),
        printer=lambda cid: f"  {cid}: blocked by {', '.join(report['dependency_blockers'][cid])}",
    )
    section("required-dimension gaps", report["required_dimension_gaps"])
    if report["scenario_coverage"] and (not filters or "scenarios" in filters):
        print("\nscenario coverage:")
        for cid, cov in sorted(report["scenario_coverage"].items()):
            marks = " ".join(
                f"{sid}={'✓' if ok else '✗'}" for sid, ok in sorted(cov.items())
            )
            print(f"  {cid}: {marks}")
    if report["high_impact_dependencies"] and (not filters or "dependencies" in filters):
        print("\nhigh-impact dependencies:")
        for dep, n in report["high_impact_dependencies"]:
            print(f"  {dep} ({n} dependents)")

    if findings.errors:
        print(f"\nerrors ({len(findings.errors)}):")
        for msg in findings.errors:
            print(f"  [error] {msg}")
    if findings.reconcile:
        print(f"\nRECONCILIATION REQUIRED ({len(findings.reconcile)}):")
        for msg in findings.reconcile:
            print(f"  [!] {msg}")
    if findings.warnings:
        print(f"\nwarnings ({len(findings.warnings)}):")
        for msg in findings.warnings:
            print(f"  [warn] {msg}")
    if findings.ok():
        print("\nCapability map is consistent.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", help="project root (default: .)")
    parser.add_argument("--report", action="store_true", help="print the human-readable report")
    parser.add_argument("--json", action="store_true", help="print a machine-readable report")
    parser.add_argument("--gaps", action="store_true", help="report: show gaps")
    parser.add_argument("--regressions", action="store_true", help="report: show regressions")
    parser.add_argument("--unknown", action="store_true", help="report: show unknown capabilities")
    parser.add_argument("--partial", action="store_true", help="report: show partial capabilities")
    parser.add_argument("--deprecated", action="store_true", help="report: show deprecated capabilities")
    parser.add_argument("--reconciliation", action="store_true", help="report: show reconciliation items")
    parser.add_argument("--area", metavar="AREA", help="report: restrict to one area")
    parser.add_argument("--capability", metavar="ID", help="report: restrict to one capability")
    args = parser.parse_args(argv)

    root = Path(args.root)
    yaml_path = root / "capabilities.yaml"
    ev_dir = root / "capabilities" / "evidence"

    if yaml is None:
        print("PyYAML is required: pip install pyyaml")
        return 2
    if not yaml_path.is_file():
        print(f"[error] no capabilities.yaml in {root}")
        return 1
    try:
        data = load_yaml(yaml_path)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] capabilities.yaml unparsable: {exc}")
        return 1

    findings = Findings()
    cap_entries = []
    seen_ids = set()
    for entry in data.get("capabilities", []) or []:
        if not isinstance(entry, dict) or not entry.get("id"):
            findings.errors.append("[error] capability entry missing id")
            continue
        cid = str(entry["id"])
        if cid in seen_ids:
            findings.errors.append(f"duplicate capability id {cid!r}")
        seen_ids.add(cid)
        cap_entries.append((cid, entry))
    caps = dict(cap_entries)

    records, load_problems = load_evidence_dir(ev_dir)
    findings.errors.extend(load_problems)

    superseded_by = validate_evidence_records(records, caps, root, findings)
    findings2, per_cap = analyze(caps, records, superseded_by, root)
    # merge the two passes (analyze validates caps; evidence pass validates records)
    findings.errors.extend(findings2.errors)
    findings.reconcile.extend(findings2.reconcile)
    findings.warnings.extend(findings2.warnings)
    findings.regressions.extend(findings2.regressions)

    report = build_report(caps, records, superseded_by, per_cap, findings)

    # Apply filters to the report for human output.
    filters = set()
    for flag, section in (
        ("--gaps", "gaps"), ("--regressions", "regressions"), ("--unknown", "unknown"),
        ("--partial", "partial"), ("--deprecated", "deprecated"),
        ("--reconciliation", "reconciliation required"),
    ):
        if getattr(args, flag.lstrip("-")):
            filters.add(section)
    if args.area or args.capability:
        keep = {}
        for area, ids in report["areas"].items():
            if args.area and area != args.area:
                continue
            if args.capability:
                ids = [cid for cid in ids if cid == args.capability]
            if ids:
                keep[area] = ids
        report["areas"] = keep
        all_ids = {cid for ids in keep.values() for cid in ids}
        for key in ("gaps", "unknown", "partial", "regressions", "deprecated"):
            report[key] = [cid for cid in report[key] if cid in all_ids]
        report["dependency_blockers"] = {
            cid: deps for cid, deps in report["dependency_blockers"].items() if cid in all_ids
        }
        report["scenario_coverage"] = {
            cid: cov for cid, cov in report["scenario_coverage"].items() if cid in all_ids
        }
        report["required_dimension_gaps"] = [
            g for g in report["required_dimension_gaps"] if g.split(":")[0] in all_ids
        ]

    if args.json:
        payload = {
            "ok": findings.ok(),
            "root": str(root),
            "errors": findings.errors,
            "reconciliation": findings.reconcile,
            "warnings": findings.warnings,
            "report": report,
        }
        print(json.dumps(payload, indent=2, default=str))
    elif args.report:
        print_human_report(report, findings, root, filters)
    else:
        for msg in findings.errors:
            print(f"[error] {msg}")
        for msg in findings.reconcile:
            print(f"[!] {msg}")
        for msg in findings.warnings:
            print(f"[warn] {msg}")
        if findings.ok():
            print(f"Capability map OK: {len(caps)} capabilities, {len(records)} evidence records.")
        else:
            print(
                f"Capability map has {len(findings.errors)} error(s) and "
                f"{len(findings.reconcile)} reconciliation item(s)."
            )

    return 0 if findings.ok() else 1


if __name__ == "__main__":
    sys.exit(main())
