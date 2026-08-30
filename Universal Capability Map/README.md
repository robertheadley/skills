# Universal Capability Map

An evidence-backed, product-wide map of what a product actually supports —
create it, keep it current automatically, and read it before building,
planning, shipping, or answering "does the product support X?". It doubles
as a UI checklist: enumerate the interface's support functions (state,
interaction, presentation, feedback, accessibility, data) as capabilities,
and the map's gap list becomes the UI build order.

- **Skill**: see [`SKILL.md`](SKILL.md) for the full workflow (create →
  maintain → read/use → audit).
- **Checker**: [`scripts/check_capabilities.py`](scripts/check_capabilities.py)
  validates the map mechanically and prints a human-readable `--report`
  (stdlib + PyYAML, no framework dependencies).

```bash
python scripts/check_capabilities.py .              # pass/fail check
python scripts/check_capabilities.py --report .     # readout: areas, gaps, regressions
```

Map files live in the target project: `capabilities.yaml` + one evidence
JSON per proof under `capabilities/evidence/`.
