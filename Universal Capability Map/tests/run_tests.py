#!/usr/bin/env python3
"""Self-contained test suite for the Universal Capability Map checker.

Each test builds a small map in a temp directory, runs
scripts/check_capabilities.py against it, and asserts the exit code and
diagnostic output. No test framework beyond the stdlib.

Run:  python tests/run_tests.py
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "check_capabilities.py"
EXAMPLE = Path(__file__).resolve().parent.parent / "examples" / "basic-map"


def write_map(root: Path, yaml_text: str, evidence: dict | None = None):
    (root / "capabilities" / "evidence").mkdir(parents=True, exist_ok=True)
    (root / "capabilities.yaml").write_text(yaml_text, encoding="utf-8")
    for uid, rec in (evidence or {}).items():
        (root / "capabilities" / "evidence" / f"{uid}.json").write_text(
            json.dumps(rec), encoding="utf-8"
        )


def run_checker(root: Path, *extra):
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), *extra, str(root)],
        capture_output=True,
        text=True,
    )
    return proc.returncode, (proc.stdout + proc.stderr)


def ev(uid, cap, kind="test_result", outcome="pass", **kw):
    rec = {"uid": uid, "capability_id": cap, "kind": kind, "outcome": outcome}
    rec.update(kw)
    return rec


class BasicMap(unittest.TestCase):
    def make(self, status="implemented", extra="", evidence=None, evidence_ids=None):
        tmp = Path(tempfile.mkdtemp())
        ids = evidence_ids if evidence_ids is not None else (["EV-001"] if evidence else [])
        ev_line = f"    evidence: [{', '.join(ids)}]\n" if ids else ""
        yaml_text = (
            "capabilities:\n"
            "  - id: file-upload\n"
            "    name: File upload\n"
            "    area: core\n"
            "    claim: A user can upload a file and see it listed.\n"
            f"    status: {status}\n"
            + ev_line
            + extra
        )
        write_map(tmp, yaml_text, evidence)
        return tmp

    def test_valid_basic_map(self):
        tmp = self.make(evidence={"EV-001": ev("EV-001", "file-upload", "file_change")})
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)

    def test_unknown_capability(self):
        tmp = self.make(status="unknown")
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)

    def test_partial_capability(self):
        tmp = self.make(status="partial", evidence={"EV-001": ev("EV-001", "file-upload", "file_change")})
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)  # promote warning only

    def test_valid_verified_capability(self):
        tmp = self.make(status="verified", evidence={"EV-001": ev("EV-001", "file-upload")})
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)

    def test_regression_after_pass(self):
        tmp = self.make(
            evidence={
                "EV-001": ev("EV-001", "file-upload", date="2026-08-30"),
                "EV-002": ev("EV-002", "file-upload", outcome="fail", date="2026-08-31"),
            },
            evidence_ids=["EV-001", "EV-002"],
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("latest active evidence is FAIL", out)

    def test_explicit_demotion_allowed(self):
        tmp = self.make(
            status="partial",
            extra="    regression: upload broke after 1.4.1; demoted while fixing.\n",
            evidence={
                "EV-001": ev("EV-001", "file-upload", date="2026-08-30"),
                "EV-002": ev("EV-002", "file-upload", outcome="fail", date="2026-08-31"),
            },
            evidence_ids=["EV-001", "EV-002"],
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)

    def test_repaired_regression(self):
        tmp = self.make(
            status="verified",
            evidence={
                "EV-001": ev("EV-001", "file-upload", date="2026-08-30"),
                "EV-002": ev("EV-002", "file-upload", outcome="fail", date="2026-08-31"),
                "EV-003": ev("EV-003", "file-upload", date="2026-09-01"),
            },
            evidence_ids=["EV-001", "EV-002", "EV-003"],
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)

    def test_unsupported_claim_no_evidence(self):
        tmp = self.make(status="verified")
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("no usable evidence", out)

    def test_verified_needs_verification_evidence(self):
        tmp = self.make(
            status="verified",
            evidence={"EV-001": ev("EV-001", "file-upload", "file_change")},
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("only supports implemented", out)


class SchemaValidation(unittest.TestCase):
    def run_map(self, yaml_text, evidence=None):
        tmp = Path(tempfile.mkdtemp())
        write_map(tmp, yaml_text, evidence)
        return run_checker(tmp)

    def base(self, extra=""):
        return (
            "capabilities:\n"
            "  - id: file-upload\n"
            "    name: File upload\n"
            "    area: core\n"
            "    claim: A user can upload a file and see it listed.\n"
            "    status: implemented\n"
            + extra
        )

    def test_duplicate_ids(self):
        code, out = self.run_map(
            "capabilities:\n"
            "  - id: file-upload\n    name: A\n    area: core\n    status: implemented\n"
            "  - id: file-upload\n    name: B\n    area: core\n    status: implemented\n"
        )
        self.assertEqual(code, 1, out)
        self.assertIn("duplicate capability id", out)

    def test_malformed_id(self):
        code, out = self.run_map(
            "capabilities:\n  - id: 'Panel Docking'\n    name: A\n    area: core\n    status: implemented\n"
        )
        self.assertEqual(code, 1, out)
        self.assertIn("malformed capability id", out)

    def test_invalid_status(self):
        code, out = self.run_map(
            "capabilities:\n  - id: file-upload\n    name: A\n    area: core\n    status: done\n"
        )
        self.assertEqual(code, 1, out)
        self.assertIn("invalid status", out)

    def test_missing_required_fields(self):
        code, out = self.run_map("capabilities:\n  - id: file-upload\n    status: implemented\n")
        self.assertEqual(code, 1, out)
        self.assertIn("missing required field 'name'", out)

    def test_missing_dependency(self):
        code, out = self.run_map(self.base("    depends_on: [ghost-capability]\n"))
        self.assertEqual(code, 1, out)
        self.assertIn("references missing capability", out)

    def test_self_dependency(self):
        code, out = self.run_map(self.base("    depends_on: [file-upload]\n"))
        self.assertEqual(code, 1, out)
        self.assertIn("references itself", out)

    def test_dependency_cycle(self):
        code, out = self.run_map(
            "capabilities:\n"
            "  - id: alpha\n    name: A\n    area: core\n    status: implemented\n    depends_on: [beta]\n"
            "  - id: beta\n    name: B\n    area: core\n    status: implemented\n    depends_on: [alpha]\n"
        )
        self.assertEqual(code, 1, out)
        self.assertIn("dependency cycle", out)

    def test_malformed_aliases(self):
        code, out = self.run_map(self.base("    aliases: 'favorite models'\n"))
        self.assertEqual(code, 1, out)
        self.assertIn("aliases must be a list", out)

    def test_malformed_tags(self):
        code, out = self.run_map(self.base("    tags: [ok, '']\n"))
        self.assertEqual(code, 1, out)
        self.assertIn("tags must be a list of non-empty strings", out)

    def test_malformed_dimensions(self):
        code, out = self.run_map(self.base("    dimensions:\n      backend: shipped\n"))
        self.assertEqual(code, 1, out)
        self.assertIn("invalid state", out)

    def test_invalid_source_type(self):
        code, out = self.run_map(
            self.base("    sources:\n      - type: spec-jira\n        locator: x\n")
        )
        self.assertEqual(code, 1, out)
        self.assertIn("invalid source type", out)

    def test_required_dimension_gap(self):
        code, out = self.run_map(
            self.base(
                "    evidence: [EV-001]\n"
                "    dimensions:\n      backend: implemented\n      ui: not_implemented\n"
                "    required_dimensions: [ui]\n"
            ),
            evidence={"EV-001": ev("EV-001", "file-upload", "file_change")},
        )
        self.assertEqual(code, 0, out)
        self.assertIn("required dimension 'ui' is incomplete", out)


class EvidenceValidation(unittest.TestCase):
    def run_ev(self, records, cap_yaml_extra=""):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: panel-docking\n"
            "    name: Panel docking\n"
            "    area: workspace\n"
            "    claim: A user can dock a panel.\n"
            "    status: verified\n"
            + cap_yaml_extra
            + "    evidence:\n"
            + "".join(f"      - {uid}\n" for uid in records),
            records,
        )
        return run_checker(tmp)

    def test_duplicate_evidence_uid(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n  - id: panel-docking\n    name: P\n    area: w\n    status: verified\n    evidence: [EV-001]\n",
        )
        ev_dir = tmp / "capabilities" / "evidence"
        (ev_dir / "EV-001.json").write_text(
            json.dumps(ev("EV-001", "panel-docking")), encoding="utf-8"
        )
        (ev_dir / "EV-001-copy.json").write_text(
            json.dumps(ev("EV-001", "panel-docking")), encoding="utf-8"
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("duplicate evidence uid", out)

    def test_missing_evidence_uid(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n  - id: panel-docking\n    name: P\n    area: w\n    status: verified\n    evidence: [EV-001]\n",
        )
        ev_dir = tmp / "capabilities" / "evidence"
        (ev_dir / "EV-001.json").write_text(
            json.dumps({"capability_id": "panel-docking", "kind": "test_result", "outcome": "pass"}),
            encoding="utf-8",
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("missing evidence 'uid'", out)

    def test_evidence_targets_unknown_capability(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(tmp, "capabilities: []\n")
        ev_dir = tmp / "capabilities" / "evidence"
        (ev_dir / "EV-001.json").write_text(
            json.dumps(ev("EV-001", "ghost")), encoding="utf-8"
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("targets unknown capability", out)

    def test_dangling_capability_reference(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n  - id: panel-docking\n    name: P\n    area: w\n    status: implemented\n    evidence: [EV-999]\n",
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("dangling evidence reference", out)

    def test_unreferenced_evidence(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(tmp, "capabilities:\n  - id: panel-docking\n    name: P\n    area: w\n    status: unknown\n")
        ev_dir = tmp / "capabilities" / "evidence"
        (ev_dir / "EV-001.json").write_text(
            json.dumps(ev("EV-001", "panel-docking")), encoding="utf-8"
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)
        self.assertIn("unreferenced evidence", out)

    def test_malformed_evidence_missing_outcome(self):
        code, out = self.run_ev(
            {"EV-001": {"uid": "EV-001", "capability_id": "panel-docking", "kind": "test_result"}}
        )
        self.assertEqual(code, 1, out)
        self.assertIn("missing 'outcome'", out)

    def test_malformed_evidence_bad_kind(self):
        code, out = self.run_ev(
            {"EV-001": ev("EV-001", "panel-docking", kind="magic")}
        )
        self.assertEqual(code, 1, out)
        self.assertIn("invalid kind", out)

    def test_malformed_date(self):
        code, out = self.run_ev(
            {"EV-001": ev("EV-001", "panel-docking", date="31/08/2026")}
        )
        self.assertEqual(code, 1, out)
        self.assertIn("malformed date", out)

    def test_invalid_scenario_reference(self):
        code, out = self.run_ev(
            {"EV-001": ev("EV-001", "panel-docking", scenario="dock-right")},
            cap_yaml_extra="    verification:\n      scenarios:\n        - id: dock-left\n",
        )
        self.assertEqual(code, 1, out)
        self.assertIn("not declared by capability", out)

    def test_scenario_coverage_incomplete_for_verified(self):
        code, out = self.run_ev(
            {"EV-001": ev("EV-001", "panel-docking", scenario="dock-left")},
            cap_yaml_extra=(
                "    verification:\n"
                "      scenarios:\n"
                "        - id: dock-left\n"
                "        - id: persist-layout\n"
            ),
        )
        self.assertEqual(code, 1, out)
        self.assertIn("scenario 'persist-layout' has no verification pass evidence", out)

    def test_duplicate_scenario_ids(self):
        code, out = self.run_ev(
            {"EV-001": ev("EV-001", "panel-docking", scenario="dock-left")},
            cap_yaml_extra=(
                "    verification:\n"
                "      scenarios:\n"
                "        - id: dock-left\n"
                "        - id: dock-left\n"
            ),
        )
        self.assertEqual(code, 1, out)
        self.assertIn("duplicate scenario id", out)

    def test_supersession_cycle(self):
        code, out = self.run_ev(
            {
                "EV-001": {**ev("EV-001", "panel-docking"), "supersedes": ["EV-002"]},
                "EV-002": {**ev("EV-002", "panel-docking"), "supersedes": ["EV-001"]},
            }
        )
        self.assertEqual(code, 1, out)
        self.assertIn("supersession cycle", out)

    def test_invalid_supersedes_reference(self):
        code, out = self.run_ev(
            {"EV-001": {**ev("EV-001", "panel-docking"), "supersedes": ["EV-404"]}}
        )
        self.assertEqual(code, 1, out)
        self.assertIn("supersedes references missing evidence", out)

    def test_superseded_evidence_not_authoritative(self):
        # Newer FAIL supersedes the older PASS; only the FAIL remains active.
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: panel-docking\n    name: P\n    area: w\n    status: not_implemented\n"
            "    regression: docking broke after the layout engine change.\n"
            "    evidence: [EV-001, EV-002]\n",
            {
                "EV-001": {**ev("EV-001", "panel-docking"), "date": "2026-08-01"},
                "EV-002": {
                    **ev("EV-002", "panel-docking", outcome="fail", date="2026-08-10"),
                    "supersedes": ["EV-001"],
                },
            },
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)
        code, out = run_checker(tmp, "--report")
        self.assertIn("1 superseded", out)


class ChronologyAndSupersession(unittest.TestCase):
    def test_conflicting_evidence_ambiguous_ordering(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: sync\n    name: Sync\n    area: core\n    status: implemented\n"
            "    evidence: [EV-001, EV-002]\n",
            {
                "EV-001": ev("EV-001", "sync"),  # no date
                "EV-002": ev("EV-002", "sync", outcome="fail"),  # no date
            },
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 1, out)
        self.assertIn("ambiguous ordering", out)

    def test_latest_active_pass_resolves_earlier_fail(self):
        # FAIL is older, a newer PASS exists: latest active wins -> verified.
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: sync\n    name: Sync\n    area: core\n    status: verified\n"
            "    evidence: [EV-001, EV-002]\n",
            {
                "EV-001": ev("EV-001", "sync", outcome="fail", date="2026-08-10"),
                "EV-002": ev("EV-002", "sync", date="2026-08-20"),
            },
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)


class ReportingAndCompatibility(unittest.TestCase):
    def test_report_output(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: file-upload\n    name: Upload\n    area: core\n    status: verified\n"
            "    evidence: [EV-001]\n"
            "  - id: export\n    name: Export\n    area: core\n    status: not_implemented\n",
            {"EV-001": ev("EV-001", "file-upload")},
        )
        code, out = run_checker(tmp, "--report")
        self.assertEqual(code, 0, out)
        self.assertIn("totals:", out)
        self.assertIn("gaps (1):", out)
        self.assertIn("file-upload", out)

    def test_report_filters_and_area(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: a1\n    name: A\n    area: alpha\n    status: not_implemented\n"
            "  - id: b1\n    name: B\n    area: beta\n    status: not_implemented\n",
        )
        code, out = run_checker(tmp, "--report", "--gaps", "--area", "alpha")
        self.assertEqual(code, 0, out)
        self.assertIn("a1", out)
        head = out.split("warnings")[0]  # b1 may legitimately appear in warnings
        self.assertNotIn("b1", head)

    def test_json_report(self):
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n  - id: file-upload\n    name: Upload\n    area: core\n    status: verified\n    evidence: [EV-001]\n",
            {"EV-001": ev("EV-001", "file-upload")},
        )
        code, out = run_checker(tmp, "--json")
        self.assertEqual(code, 0, out)
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["report"]["totals"]["verified"], 1)

    def test_backward_compat_old_map_implemented(self):
        # Old 3-state map: implemented + test_result evidence (no new fields).
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: auth-login\n    name: Login\n    area: auth\n    status: implemented\n"
            "    evidence: [EV-001]\n",
            {"EV-001": ev("EV-001", "auth-login")},
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)  # promote warning only

    def test_backward_compat_old_verified_by_string(self):
        # Old verified gate: verified_by string + implementation-level evidence.
        tmp = Path(tempfile.mkdtemp())
        write_map(
            tmp,
            "capabilities:\n"
            "  - id: auth-login\n    name: Login\n    area: auth\n    status: verified\n"
            "    verified_by: PR-7\n"
            "    evidence: [EV-001]\n",
            {"EV-001": ev("EV-001", "auth-login", "file_change")},
        )
        code, out = run_checker(tmp)
        self.assertEqual(code, 0, out)  # legacy pattern warning only

    def test_example_basic_map_is_clean(self):
        code, out = run_checker(EXAMPLE)
        self.assertEqual(code, 0, out)
        self.assertNotIn("[warn]", out)
        self.assertNotIn("[error]", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
