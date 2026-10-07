# Scroll render investigation

## Result

Steady scrolling can fit an 8 ms CPU frame budget. Vanilla Pi and pi-remote already do. Rowan's visual extensions repeatedly format completed tool output; pi-remote also repeatedly copies history for its custom footer. Diagnostic caching brings both renderers below 5 ms without discarding history. These experiments are **not production fixes**.

## Measurements

Pi 1.0.4, Node v22.23.2, Apple M4 Max, gruvbox-dark, thinking visible, 140×45 terminal, 8 warmup and 40 measured moving-viewport frames. Runners execute sequentially without concurrent tests. These are CPU render times, not terminal-delivered FPS.

| Presentation and displayed history | Native mean / p95 | Remote mean / p95 |
|---|---:|---:|
| Vanilla, compacted entries | 3.81 / 3.95 ms | 3.91 / 4.17 ms |
| Rowan, compacted entries | 12.06 / 13.04 ms | 18.95 / 21.51 ms |
| Vanilla, full branch | 3.86 / 3.96 ms | 4.48 / 4.83 ms |
| Rowan, full branch | 32.42 / 33.67 ms | 45.91 / 48.55 ms |

An earlier independent remote run measured 4.95 ms vanilla and 49.64 ms Rowan for the full branch; short timing runs vary. At 120×45, compacted-entry mean times are 3.39 / 3.58 ms native/remote vanilla and 10.91 / 17.65 ms native/remote Rowan.

Normal Pi startup is compaction-aware: this fixture selects 124 entries with 118 model-context messages. RemoteTui normally displays all 338 branch entries, projected into 336 transcript records. Native full-branch rendering is an **explicit diagnostic override**, not normal startup.

The matched compacted-entry remote snapshot rewires only the diagnostic display path. All 338 source entries and footer cost data remain. Native adds four notice lines: vanilla 4,034 vs remote 4,030; Rowan 1,317 vs remote 1,313. Full-branch transcript line counts match: 14,324 vanilla and 3,174 Rowan. ANSI hashes still differ; these are matched saved history and visual factories, **not byte-identical whole UI frames**.

## Costs and attainable savings

Measured-loop full-branch profiles identify:

- Native: 80.3% of render samples include `truncateToWidth()`; 86.8% include tool component rendering.
- Remote: 57.2% include `truncateToWidth()`, and 21.1% include `readonlyCopy()` through footer history access (18.1% include `structuredClone()`).
- The common tool cost comes from `compact-tools.ts:323` (`renderRows`) and `codemode/render.ts:265` in the installed Rowan extensions. Collapsed, settled tool output is formatted again every frame, including offscreen tools.
- Remote history getters deep-copy and freeze entries each time `codex-footer.ts` asks for them. Native session-manager getters do not do this deep-copy work.

Idle-only diagnostic caching, full history at 140×45:

| Experiment | Native mean / p95 | Remote mean / p95 |
|---|---:|---:|
| Freeze footer | 32.21 / 34.18 ms | 37.29 / 39.12 ms |
| Cache settled tool render output | 4.46 / 4.62 ms | 14.61 / 15.96 ms |
| Both | **4.15 / 4.34 ms** | **4.56 / 4.93 ms** |

Transcripts remain unchanged before/after each experiment. Freezing arbitrary extension output is not generally safe: renderers can depend on clocks and other changing state. Production improvements should memoize resolved row layout/truncation while evaluating dynamic values, and reuse readonly history projections until the source entries change. Width, theme, expansion, arguments and results must invalidate relevant caches.

Pi's `tui.js` separately throttles `requestRender()` to 16 ms. Wheel/PageUp scrolling uses that path, so a 4 ms CPU render does **not** establish 120 FPS. Supporting 120 FPS needs an approximately 8 ms scroll scheduling interval and a terminal throughput test. The benchmark deliberately calls `renderNow()` to isolate render CPU cost.

## Reproduction and safety

`test/native-scroll-benchmark.ts` uses actual `createAgentSession()`, `SessionManager.open()` and `InteractiveMode.init()`. Rowan runs load unchanged `examples/rowan-ui.ts` and assert all seven original compact builtin definitions are registered; disabling all tools would also disable those overrides and give a misleading comparison. Isolated resource loading excludes unrelated execution/provider extension suites. Benchmarks never prompt or execute tools. Provider/network guards report zero attempts. Source snapshot and imported entry hashes stay unchanged; temporary session history is private and removed.

Use `npm run test:native-scroll -- --help` and `npm run test:scroll -- --help`. Native `--history full` uses stock `chatContainer.clear()` and `renderSessionEntries(getBranch())` without changing the real model context. `test/context-scroll-snapshot.ts --input FILE --output NEW_FILE` creates the explicit matched-entry remote fixture. Keep input history, results and profiles private; do not commit snapshots. Profile separately from timing runs, with `--profile FILE` and a single idle scenario. `--experiment` is diagnostic and idle-only.
