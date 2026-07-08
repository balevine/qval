# Qval — Code Review & Remediation Backlog

Review date: 2026-07-04. Baseline: typecheck clean, 113 tests passing (18 files).
Working through these one-by-one. Check items off as completed.

Severity: 🔴 high · 🟠 medium · 🟡 low · ℹ️ info

---

## 1. Gaps vs. spec

### [x] 🔴 A1 — Config source is split; opening a file never syncs it (data-integrity) — DONE 2026-07-05
Implemented: file is authoritative (main reads `workingFile.meta.config` for run/estimate/human-validate),
open/loadLast hydrate settings from the snapshot, unlocked files re-stamp config on schema/rules edits,
`configLocked`/`providerLocked` freeze Schema+Rules (any score) and Provider+model (llm score), and a top-bar
**New evaluation** button resets. Spec §3/§4/§10/§13/§16 + IPC list synced. Tests green, build clean.

<details><summary>Original problem &amp; decided solution (kept for history)</summary>

The **renderer** reads/edits/aggregates against the **file snapshot** `workingFile.meta.config.schema/rules`
(`DatasetView.tsx:191,242`, `TicketDetailModal.tsx:142,178`, `aggregate.ts:254`).
The **main process** runs evaluations and validates human input against **`settings.schema/rules`**
(`service.ts:120-121`, `estimate.ts:21,26`, `ipc.ts:111`).

`Workspace.openEvalFile` (`storage.ts:145`) loads a file but never writes its snapshot back into settings,
and there is no divergence warning. Spec §3 (open loads snapshot into working config + warns if it differs)
and §4 (editing schema/rules warns that re-run is advisable / file will no longer merge) are both unimplemented
(no `configFingerprint`/warning references in the renderer).

Consequences when an opened file's config ≠ current settings:
- LLM run compiles/validates under settings config B but writes into a file still stamped with config A
  (`applyLlmResults` never touches `meta.config`) → the file's declared config no longer describes its data;
  merge gating (which trusts the fingerprint) becomes meaningless.
- Human form renders from snapshot A but `humanSetValues` validates against settings B → properties in
  A-but-not-B are silently dropped; the user's entry disappears.

**DECIDED SOLUTION (2026-07-04):** The loaded file is the single authoritative config source.
- On open, hydrate `settings.schema` + `settings.rules` from the file's `meta.config`.
- Main reads `workingFile.meta.config.schema/rules` (not `settings.*`) for run / estimate / human-validate,
  so the config used to produce data can never diverge from what the file declares.
- **Lock when the file has real data.** Trigger = any evaluator has ≥1 result with non-empty `values`
  (error-only / empty results do NOT lock). While locked, freeze **Provider (incl. model), Schema, and Rules**
  — evaluator uniformity across tickets requires the same model + criteria for every ticket. **Storage stays
  editable.** Concurrency/batch-size are throughput-only (keep editable if separable from the Provider lock).
- While a working file is empty/unlocked, editing schema/rules also re-stamps the working file's `meta.config`
  (re-fingerprint) so the two never drift during setup.
- **Add a "New evaluation" button** (top bar): unloads the current file, opens a `tickets.json` picker, creates
  a fresh (editable) working file from current settings; first save prompts for a new filename (no overwrite).

</details>

### [x] 🔴 A2 — Human editing of LLM values (`edits` / "reset to model") — DESCOPED 2026-07-05
Decision: LLM output is **never** hand-editable — a human cannot alter/clear the `llm` evaluator's values.
To disagree with the model, fill the human eval; the human-vs-LLM comparison surfaces it. Removed the dormant
`EvalEdit` type + `edits?` field (`types.ts`) and the `edits` zod parse (`evalFile.ts`). Spec §2.4/§6/§8/§9.2/§16
updated (LLM values read-only; issue badges remain read-only provenance — that's A3). The `HumanEvalForm`
read-only "LLM: …" reference line stays (spec §7). 121 tests green, build clean.

### [x] 🟠 A3 — Validation/repair review UI — DONE 2026-07-08
The working file's `llm` `issues[]` now render as read-only badges next to the LLM reference value in the
ticket-detail human form (`HumanEvalForm` `LlmReference`/`IssueMark`, fed via `llmIssues` from
`TicketDetailModal`): a ⚠ on `clamped`/`coerced` (hover/focus title shows the pre-repair `original` + what
the auto-repair did) and a "— (dropped)" marker for a value the model couldn't produce (the badges show
what the automatic per-value repair §6 did to the model's raw output). 121 tests green, typecheck + build clean.
Optional follow-up (not done): a "next ticket with issues" nav / overview hint to help *find* them.

### [x] 🟠 A4 — Human edits during an LLM run can be lost (race) — DONE 2026-07-08
Resolved by making the working file **read-only during a run** (simpler than merging concurrent edits):
`EvaluationService.isRunning()` + an `assertIdle()` guard in `ipc.ts` blocks `human.setValues`, `settings.set`,
`session.open`/`newEvaluation`/`addComparison` while a run is in flight (authoritative). UI mirrors it: TopBar
New/Open/Merge disabled (`busy`), ticket-detail human form disabled + notice, Settings modal content disabled +
notice — all off `EvaluationContext.phase === 'running'`. No concurrent access → no race. New service test asserts
`isRunning()` transitions + concurrent-start refusal. Spec §6/§7/§16 synced. 122 tests green, typecheck + build clean.

### [x] 🟡 A5 — Completeness-stat drift — DONE 2026-07-08
- **Part 1 (fixed):** the LLM "eval" count was `filter(r => !r.error)`, so an all-dropped result (no error,
  empty values) counted as evaluated. Added `evaluatedCount(file, kind)` in `evalFile.ts` (≥1 non-empty value,
  the same definition as the human count) and switched both summary stats to it (`DatasetView.tsx`).
  Test added; `humanEvaluatedCount` now delegates to it.
- **Part 2 (descoped):** the spec's "0 partial" human stat + per-property fill counts are dropped from §7 —
  a single count of scored tickets per stream is enough for now. Spec §7 updated to match the simpler UI.

### [x] 🟡 A6 — Progress `batchesDone` can exceed `batchesTotal` during retry pass — DONE 2026-07-08
`batchesTotal` was fixed at the pass-1 `batches.length` while `processedBatches` kept incrementing through the
validation-retry pass. Fixed: `batchesTotal` is now a mutable `totalBatches` that grows by the retry pass's
batch count when it's scheduled, so retried batches count as done only once they complete and `batchesDone`
never exceeds `batchesTotal` (ends exactly equal). Regression test asserts the invariant across a retry run.

---

## 2. Duplicate code / refactor — DONE 2026-07-08

- [x] 🟡 `showOpen`/`showSave` extracted to `src/main/dialogs.ts`; `ipc.ts` + `storage.ts` import them (and no
  longer import `BrowserWindow`/`dialog`).
- [x] 🟡 Token-budget heuristics consolidated: removed `maxTokensFor`/`resolveMaxTokens` from `common.ts`;
  `GenerateBatchArgs.maxOutputTokens` is now **required** and providers consume it directly. The schema-aware
  `maxOutputTokensForBatch` (`shared/evaluation.ts`) is the single source, set by the orchestrator.
- [x] 🟡 Removed hello-world `app.ping`/`appPing` (IpcApi, IpcChannels, ipc handler, preload). `app.getVersion` kept.
- [x] 🟡 Optimistic-vs-persisted skew: exported `clampScore(n, p)` from `evalValidate.ts` (extracted from
  `coerceScore`, so main and UI share one clamp/snap); `HumanEvalForm` clamps its number input client-side. Test added.
- [ ] ℹ️ Similar abort-timer patterns in `connection.ts:5` (`withTimeout`) and `orchestrator.ts:45` (`abortableSleep`).
  Left as-is — they serve different purposes (a timeout that aborts vs. an abortable sleep); merging would obscure both.

---

## 3. Security (posture is strong; notes below)

- ✅ Keys encrypted via `safeStorage`, decrypted only in main, never on the IPC surface.
- ✅ Prod CSP locked to `'self'` with object/base/frame/form-action denied; `will-navigate` blocks remote nav.
- [ ] 🟡 (deferred — user: not a concern for this app now) `setWindowOpenHandler` opens ANY url via
  `shell.openExternal` unconditionally (`index.ts:64-67`). Allow-list `http:`/`https:` before opening.
- [ ] 🟡 (deferred) `style-src 'unsafe-inline'` in prod (`index.ts:34`) — needed by Radix/Tailwind; add a comment explaining why.
- [ ] ℹ️ Provider error bodies surfaced verbatim (300-char slice, `common.ts:69-79`) — low risk.
- [x] Evaluation fetches now have a hang guard — DONE 2026-07-08. `withDeadline(signal, ms)` in
  `providers/common.ts` combines the run's cancel signal with a timeout: a **total** cap (`REQUEST_TIMEOUT_MS`,
  10 min) on the non-streaming Anthropic `postJson`, and an **idle** cap (`STREAM_IDLE_TIMEOUT_MS`, 5 min, reset
  on each chunk) on the Ollama stream. A timeout raises a **retryable** `ProviderError` (orchestrator retries it);
  a user Cancel still stops the run. Unit-tested with fake timers. (Values are generous — they only fire on a
  genuinely hung socket, never clip slow-but-progressing work.)

---

## 4. Drift from TS/Electron norms

- [x] 🟡 Spec §12 IPC surface reconciled to `session.*` + `newEvaluation` + client-side compile (during A1);
  §12 tree + phase-7 renamed `ResultsTable.tsx` → `DatasetView.tsx` (2026-07-08).
- [x] 🟡 `z.enum(X as unknown as [...])` casts replaced with `enumFrom()` (`src/shared/zodUtil.ts`); the cast now
  lives in one place, used by `validate.ts` + `evalFile.ts`.
- [ ] ℹ️ No shared fetch wrapper (timeout/abort/error) across providers; fine for two, will duplicate as they grow.
- [ ] Phase 9 (packaging + README) outstanding: no `README.md`, no `release.yml`. §17 checklist open.

---

## Second review (2026-07-08) — findings + status

Baseline before: 130 tests. After these fixes: **134 tests**, typecheck clean.

- [x] 🟠 G1 — **Single validation-retry silently discarded a good first-attempt value.** `runBatches`
  mirrors its sink into the shared `results` map every batch, so pass 2 overwrote `results` with the
  retry attempt *before* the merge ran → `mergeResults(results.get(id), retrySink.get(id))` was
  effectively `merge(retry, retry)`, losing a value pass 1 got right (spec §6 "first attempt wins").
  Fix: snapshot `firstPass = new Map(retryTickets → results.get)` before the retry pass and merge
  from it (`orchestrator.ts`). Regression test asserts pass-1 `empathy` survives a retry that
  regresses it (verified: fails on the old code, passes on the fix).
- [x] 🟠 G2 — **Merging two files with the same basename could silently drop an evaluator.**
  `buildStreams` deduped streams on `(kind, name, source)` with `source = comparison.name` (basename),
  so two merged files sharing a filename collapsed a same-named evaluator. Fix: key dedup on the
  comparison's unique `id` (path); display label still routes through `streamLabel` (unchanged).
  Tests: two same-basename files keep both evaluators; same id twice still collapses. (Display-name
  disambiguation for the columns themselves — G5 — remains out of scope.)
- [x] 🟡 D1 — **"Needs attention" predicate duplicated** in `service.selectTargets` and
  `EvaluateModal` counts. Extracted `needsAttention(result)` to `shared/evalFile.ts`; both callers use
  it. Test added. (Remaining second-review items G3/G4/G5/N1–N4 not addressed — out of scope for now.)

## Progress

**Done (2026-07-05 → 07-08):** A1 (config authoritative + lock + New evaluation), A2 (descoped LLM-value editing),
A3 (read-only repair badges), A4 (working file read-only during a run). Spec synced throughout.
Suite now at **122 tests**, typecheck + build clean.

**Remaining:**
1. Phase 9: packaging (`.dmg`/`.zip` + release workflow) and a user-facing README. (Separate task.)

**Deferred by the user** (not a concern for this app right now): §3 `setWindowOpenHandler` scheme allow-list,
`unsafe-inline` style-CSP comment. The genuine hang risk (evaluation socket timeout) is done.

(A1–A6 done; §2 cleanups + §4 drift done, except the two ℹ️ future-facing notes; §3 socket timeout done.)
