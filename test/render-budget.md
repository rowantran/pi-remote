# Production render-budget fixes

## Changes

- `src/presentation-history.ts` caches cloned, recursively frozen history entries. Unchanged reads reuse frozen arrays; appends copy only new entries. Streaming messages use weakly cached current versions. Branch, snapshot and session changes select new data. An eight-result branch cache and teardown cleanup bound retained state. Extensions still cannot mutate authoritative history.
- `pi-extensions/compact-tools.ts` resolves dynamic row values on every render, then reuses width fitting when the row strings, truncation flags and width are unchanged. `codemode/render.ts` uses this shared helper. It does not freeze completed tool output or skip dynamic values; theme, expansion, partial results and timers remain live.
- `src/transcript.ts` preserves parsed tool-argument identities across unchanged rebuilds and owns weak projections of immutable custom/compaction entries. This lets existing historical components keep their Markdown/layout caches during metadata and text-delta updates. Changed arguments or entry objects still rebuild the affected components. Other callers of `transcriptMessages()` keep the original uncached behavior.
- `src/scheduled-tui.ts` uses an 8 ms minimum interval between **normal frame starts**, including CPU time in that interval. Requests coalesce; force and focused keyboard input remain immediate. Stop/restart and `renderNow()` cancel queued work. This uses Pi's public methods and protected subclass render hook, not private-field or installed-package patches. `TuiOptions.renderIntervalMs` permits a 16 ms control.

The original [diagnostic investigation](scroll-performance.md) froze whole components to estimate savings. These production fixes instead retain normal rendering behavior and cache only unchanged data/layout.

## Measured production results

Apple M4 Max, Node v22.23.2, Pi 1.0.4, gruvbox-dark, thinking visible, 140×45, full saved branch (338 entries, 336 remote transcript records, 3,174 rendered lines). Eight warmup frames and 60 measured frames. Timing runs are sequential and offline. No diagnostic `--experiment` mode is enabled.

Two runs of each remote combination:

| Active production changes | Mean render range | p95 range |
|---|---:|---:|
| Neither cache | 46.59–46.97 ms | 48.93–50.12 ms |
| Protected history cache only | 35.83–36.38 ms | 38.08–39.10 ms |
| Tool-row layout cache only | 15.73–16.05 ms | 17.45–18.72 ms |
| Both caches | **6.11–6.14 ms** | **6.71 ms** |

Native full-history diagnostic rendering improves from 34.13 ms (p95 36.71) to **5.71 ms** (p95 6.12) with the same tool-row cache. The native benchmark uses a real AgentSession and InteractiveMode. Its model context remains unchanged. Native transcript hashes match before/after; remote transcript hashes match across all four combinations. Source snapshot unchanged; zero replay/provider/network calls.

After retaining unchanged argument and custom/compaction projection identities during transcript reconciliation, final before/after replay uses an **identical benchmark script, snapshot, package lock and matching initial/before/after transcript hashes**:

| Full-history scroll workload | Before mean | After mean / p95 |
|---|---:|---:|
| Idle | 47.12 ms | **6.07 / 6.55 ms** |
| Metadata update each frame | 66.40 ms | **6.58 / 7.21 ms** |
| Synthetic assistant text delta each frame | 67.47 ms | **6.72 / 7.22 ms** |

The measured full event/input/render p95 is at most 7.31 ms. Synthetic streaming uses saved data and local fake events, never a real provider or session. New large tool outputs and real provider workload remain outside this benchmark.

## Scheduling versus displayed FPS

With both production caches, a separate two-second monotonic wheel-input test performs **no `renderNow()` calls during measurement**:

| Normal frame-start interval | Moving writes/s | Moving frames |
|---|---:|---:|
| 16 ms control | 59.49 | 119 |
| 8 ms default | 112.91 | 226 |

Every measured frame moved the viewport; transcript hashes remained unchanged. Counts are synchronized-output writes to a memory terminal, **not real terminal display FPS**. The 8 ms interval removes the old roughly-60-FPS ceiling, but timer resolution, rendering and terminal throughput still affect cadence. These results do not establish sustained 120 FPS. Stock native Pi's scheduler is unchanged at 16 ms.

## Reproduction and limits

Use `PI_REMOTE_RENDERER_REPO=/path/to/updated/pi-extensions` with the worktree-local `examples/rowan-ui.ts` adapter in both remote and native runners. Replay the same private snapshot with fixed theme, dimensions, dependencies and terminal environment. Keep history and profiles outside Git.

For CPU cost: `npm run test:scroll -- --snapshot FILE --ui-config NONEXISTENT_FILE --ui-extension ./examples/rowan-ui.ts --theme gruvbox-dark --scenario idle-scroll --iterations 60`.

For scheduled writes, append `--scheduled-duration 2000 --render-interval 8` (or 16 for control). The default input interval is 4 ms. The script rejects runs that reach the transcript top, change transcript content, or overlap metadata refresh. Scheduled runs are idle-only; duration is limited to ten seconds.

Validation passed 304 remote tests, build and strict benchmark type checks, 107 extension tests against both Pi 0.99.2 and 1.0.4, and real stock-Pi terminal comparisons at 80/120 columns plus 40-column Rowan layouts. Independent reviews approved both caches, scheduling and reconciliation changes.

Cold startup, resizing, theme changes, expansion and large new tool results can require fresh layout. This is a steady-scroll budget, not a guarantee that every possible frame stays below 8 ms. The global Pi install, primary checkouts and real running session are not modified by validation.
