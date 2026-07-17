# Benchmarks

## 2026-07-17 - TypeScript build loop

- Scenario: two-module TypeScript userscript with an external source map.
- Method: `npm run benchmark`; 10 programmatic clean builds followed by 10 source edits handled by one persistent esbuild watch context.
- Environment: Windows x64, Node v24.18.0, AMD Ryzen 7 5700, 16 logical CPUs.
- Startup time: not separately sampled; the first clean build was included in the cold-build range.
- Clean-build latency/job duration: min 25.08 ms, median 26.16 ms, mean 29.89 ms, max 65.00 ms.
- Incremental observed edit-to-output latency/job duration: min 128.84 ms, median 132.84 ms, mean 135.88 ms, max 170.69 ms. This includes esbuild watch notification latency, so it is not comparable to direct API execution time alone.
- Memory after the run: 71.4 MiB RSS, 24.1 MiB V8 heap used.
- CPU: not isolated; shared workstation load may affect values.
- Event-loop lag: not sampled because individual build operations were sub-100 ms; watch notification latency dominates the incremental metric.
- Reproduction: `npm run benchmark` from the repository root.
