# Benchmark: minimal-subagents vs bare Pi

## Overview

This file summarizes one controlled run.
The test compares bare Pi against Pi with `minimal-subagents`.
The goal isolates context handling as the only difference.

- Experiment: `roast-20260909t123807-87d939ab`
- Date: 2026-09-09
- Model: `azure-gateway-responses/gpt-5.6-luna`, thinking high
- Pi version: `0.85.1`
- Tasks: 3 from `luna-signal`
- Repetitions: 1 per task per variant
- Hypothesis: the variant outscores control because isolated context reduces drift.
- Result: the hypothesis failed on this sample.
- Report: `/home/joshsimon/.local/share/roastmyharness/runs/roast-20260909t123807-87d939ab/report.md`
- Data: `/home/joshsimon/.local/share/roastmyharness/runs/roast-20260909t123807-87d939ab/summary.csv`

## Outcome

| Variant | Resolved | Output | Wall total | Mean tools per trial |
|---|---|---|---|---|
| Control | 2/3 | 71k | 34m | 56 |
| minimal-subagents | 1/3 | 76k | 48m | 52 |

Details:

- Both variants pass `mobly-grouped-test-barriers`.
- Both variants fail `onedump-dump-encryption-pipeline`.
- Only `cattrs-partial-structuring-recovery` flips: control passes, variant fails.
- The flip is narrow: variant scores 68/69 tests against 69/69 for control.
- The sample is small: n=3, 95% CI is [0, 100] for both arms.
- Readers should treat the score gap as descriptive, not conclusive.

## Footprint highlight

The extension is small by design.
It adds almost no surface for the model to consider.

| Dimension | Value |
|---|---|
| Source files | 1 (`index.ts`, 331 lines, 13 KB) |
| Model-facing tools added | 1 (`subagent`) |
| Parameters per call | 1 (`task`, a string) |
| Runtime dependencies added | 0 |
| Extra skills, context files, flags | 0 |
| Recursion allowed | No |
| Session persistence | None |
| Handoff cap | 16 KB (~4k tokens) |

Runtime footprint is also small:

- Total LLM calls tie: 135 vs 136.
- Total cached traffic ties: 5.62M vs 5.70M.
- Total output rises only +7%: 76k vs 71k.
- Mean tool calls fall: 52 vs 56.
- No trial triggers compaction.
- The variant calls `subagent` twice across 3 trials.
- The one shared win uses zero `subagent` calls.
- Cache writes rise +30%, mostly from the longer failing trial.

In short, the parent keeps control.
The child runs only when the task looks self-contained.
The parent receives a short handoff, not a transcript.

## Per-task notes

- `cattrs`: variant runs longer (21.1m vs 13.8m), calls more tools (74 vs 67), and fails more tools (18.9% vs 10.4%).
- `mobly`: variant runs faster (10.8m vs 12.1m), calls fewer tools (52 vs 64), and matches control at full score.
- `onedump`: both fail; variant scores one test higher (71 vs 70), uses zero `read` calls, and relies on `bash` plus one `subagent` call.

## Takeaway

- The extension does not bloat normal runs.
- It stays idle unless the model sees clean work to isolate.
- This run shows low overhead and one narrow loss.
- The next step repeats with more tasks and more repetitions.
