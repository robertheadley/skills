#!/usr/bin/env python3
"""Validate and read a Universal Capability Map (standalone, no framework deps).

Usage:
    python check_capabilities.py [project_root]         # pass/fail check
    python check_capabilities.py --report [project_root] # human-readable readout

Validates:
- capabilities.yaml parses; every capability has id/name/area.
- Every evidence ref resolves to a file under capabilities/evidence/.
- Every evidence file targets a known capability.
- Declared status equals the status the evidence derives:
      any pass evidence            -> implemented
      verification-level pass + verified_by -> verified
      otherwise                    -> not_implemented
- verified requires verification-level pass evidence AND verified_by.
- FAIL evidence flags a regression (never silently ignored).

Exit code 0 = map consistent; 1 = problems found (printed as "[x] ...").
Requires PyYAML for the declaration file.
"""

import json
import sys
from pathlib import Path

KIND_LEVEL = {
    "file_change": "implementation",
    "command_result": "implementation",
    "diagnostic": "implementation",
    "test_result": "verification",
    "review": "verification",
    "manual": "verification",
}


def derive_status(cap: dict, evidence: dict) -> str:
    """Status the evidence supports, independent of the declared field."""
    refs = [str(r) for r in (cap.get("evidence") or [])]
    pass_ev = [evidence[r] for r in refs if r in evidence and evidence[r].get("outcome") == "pass"]
    ver_pass = [e for e in pass_ev if KIND_LEVEL.get(str(e.get("kind", ""))) == "verification"]
    verified_by = str(cap.get("verified_by") or "").strip()
    if ver_pass and verified_by:
        return "verified"
    if pass_ev:
        return "implemented"
    return "not_implemented"


def main() -> int:
    args = [a for a in sys.argv[1:]]
    report = "--report" in args
    args = [a for a in args if a != "--report"]
    root = Path(args[0]) if args else Path(".")
    yaml_path = root / "capabilities.yaml"
    ev_dir = root / "capabilities" / "evidence"
    problems: list[str] = []

    if not yaml_path.is_file():
        print(f"[x] no capabilities.yaml in {root}")
        return 1
    try:
        import yaml
    except ImportError:
        print("[x] PyYAML required: pip install pyyaml")
        return 1
    try:
        data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001
        print(f"[x] capabilities.yaml unparsable: {exc}")
        return 1

    caps: dict[str, dict] = {}
    for entry in data.get("capabilities", []) or []:
        cid = str(entry.get("id", "")).strip()
        if not cid:
            problems.append("[x] capability entry missing id")
            continue
        for field in ("name", "area"):
            if not entry.get(field):
                problems.append(f"[x] {cid}: missing '{field}'")
        caps[cid] = entry

    evidence: dict[str, dict] = {}
    if ev_dir.is_dir():
        for f in sorted(ev_dir.glob("*.json")):
            try:
                ev = json.loads(f.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                problems.append(f"[x] {f.name}: unparsable ({exc})")
                continue
            if ev.get("uid"):
                evidence[str(ev["uid"])] = ev

    for cid, cap in caps.items():
        refs = [str(r) for r in (cap.get("evidence") or [])]
        for ref in refs:
            if ref not in evidence:
                problems.append(f"[x] {cid}: stale evidence ref {ref!r} (no file in {ev_dir})")
        pass_ev = [evidence[r] for r in refs if r in evidence and evidence[r].get("outcome") == "pass"]
        fail_ev = [evidence[r] for r in refs if r in evidence and evidence[r].get("outcome") == "fail"]
        ver_pass = [e for e in pass_ev if KIND_LEVEL.get(str(e.get("kind", ""))) == "verification"]
        verified_by = str(cap.get("verified_by") or "").strip()

        if ver_pass and verified_by:
            derived = "verified"
        elif pass_ev:
            derived = "implemented"
        else:
            derived = "not_implemented"

        declared = str(cap.get("status") or "not_implemented")
        if declared != derived:
            problems.append(
                f"[x] {cid}: declared {declared!r} but evidence derives {derived!r}"
            )
        if fail_ev:
            problems.append(
                f"[x] {cid}: FAIL evidence ({', '.join(e['uid'] for e in fail_ev)}) — "
                "regression: fix and add pass evidence, or demote with an explicit regression note"
            )
        if declared == "verified" and not verified_by:
            problems.append(f"[x] {cid}: verified but no verified_by reference")
        if verified_by and not ver_pass:
            problems.append(
                f"[x] {cid}: verified_by set but no verification-level pass evidence "
                "(test_result/review/manual)"
            )

    for uid, ev in evidence.items():
        if str(ev.get("capability_id")) not in caps:
            problems.append(f"[x] {uid}: references unknown capability {ev.get('capability_id')!r}")
        if ev.get("kind") not in KIND_LEVEL:
            problems.append(f"[x] {uid}: unknown kind {ev.get('kind')!r}")

    if report:
        by_area: dict[str, list[str]] = {}
        for cid, cap in caps.items():
            area = str(cap.get("area") or "?")
            status = str(cap.get("status") or "not_implemented")
            flag = " (deprecated)" if cap.get("deprecated") else ""
            by_area.setdefault(area, []).append(f"  {status:16s} {cid}{flag}")
        print(f"Capability map report for {root}")
        for area in sorted(by_area):
            print(f"{area}:")
            print("\n".join(by_area[area]))
        from collections import Counter

        counts = Counter(str(c.get("status") or "not_implemented") for c in caps.values())
        print(f"totals: {dict(counts)}")
        gaps = [cid for cid, c in caps.items()
                if str(c.get("status") or "not_implemented") == "not_implemented"
                and not c.get("deprecated")]
        if gaps:
            print(f"gaps ({len(gaps)}): {', '.join(sorted(gaps))}")
        regressions = [cid for cid, c in caps.items()
                       if any(
                           evidence.get(r, {}).get("outcome") == "fail"
                           for r in (c.get("evidence") or [])
                       )]
        if regressions:
            print(f"regressions ({len(regressions)}): {', '.join(sorted(regressions))}")

    if problems:
        print("\n".join(problems))
        return 1
    print(f"Capability map OK: {len(caps)} capabilities, {len(evidence)} evidence records.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
