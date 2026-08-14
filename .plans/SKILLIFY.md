# Qval Skillify Plan

Adding a **Claude Code skill** that runs the LLM evaluation with the user's personal Claude account (ambient model via subagents) instead of an Anthropic API key, plus CLI setup of the schema and rules. The Electron app keeps everything else: viewing tickets, viewing eval results, the human evaluation workflow, and the merge/comparison/insights surfaces.

This mirrors Qbort's `skillify` branch (`.claude/skills/generate-tickets/`), which is the reference implementation for the pattern.

Authoritative behavior spec stays `.plans/PROJECT_SPEC.md`. This file is the implementation plan and is deleted or archived once the work lands.

---

## 1. Shape of the thing

A skill at `.claude/skills/evaluate-tickets/`, copyable to `~/.claude/skills/` so it works in any directory.

```
SKILL.md                      instructions Claude follows (not human docs)
README.md                     human docs
engine.mjs                    CLI: init | config | plan | assemble | retry | status
lib/*.mjs                     dependency-free ports of src/shared pure logic
templates/EVAL_RULES.md       starter rules text
templates/EVAL_SCHEMA.json    starter schema
```

**The hard boundary (same as Qbort).** The engine owns everything structural: tickets parsing, both fingerprints, target selection, batching, prompt compilation, per-value validation and repair, retry accounting, eval-file assembly, and atomic writes. The subagents own only judgment: read a compiled prompt file, write a JSON object of schema-keyed values. Ticket ids come from the dataset and are never trusted from the model, exactly as in the app.

One improvement over Qbort's skill: the engine reads the batch files in Node, so ticket content never round-trips through Claude's context. Only the engine's short stdout summary does. Large runs stay cheap.

## 2. Decisions already made

- **Schema authoring.** Claude drafts `EVAL_SCHEMA.json` from the user's prose and `engine config --check` validates it and prints it back. This plays to the agent's strengths. A per-property Q&A is tedious past 2 or 3 properties (6 fields each) and cannot express descriptions well.
- **In-app re-run of a skill-produced file.** Blocked, with a message pointing at the CLI. This keeps the spec's one-model-scores-every-ticket invariant (§3/§4) honest. Mixing models inside one `llm` evaluator would make the file's recorded provider and model a lie.
- **Code sharing.** Ported dependency-free `.mjs` plus a parity test. The skill runs on bare `node` with no `npm install` and the folder is copyable to `~/.claude/skills`. The duplication is paid down by `test/skillParity.test.ts`.
- **Scratch directory.** `.qval-run/` (gitignored), matching Qbort's `.qbort-run/`.
- **Eval file location.** The working directory, not the scratch directory. It is the durable artifact the user opens in the app, exports, and merges. When `--eval-file` is omitted the path is derived from the tickets filename (`tickets.json` → `./tickets.qval.json`), mirroring the app's `suggestEvalName`, so the CLI and the app's save dialog suggest the same name for the same dataset.
- **Default batch size.** 10, with no Q&A, matching the app's `DEFAULT_BATCH_SIZE`. `--batch-size` overrides it.
- **Recorded evaluator.** `provider: 'claude-code'` and `model` set to the **actual model that ran** (for example `Opus 5`), which makes `name` come out as `LLM · Opus 5` from the app's own `LLM · ${model}` convention. `Evaluator.provider` is already a plain `string` in the data model, so no type change is needed.
- **How the model is resolved.** `plan` takes a **required** `--model "<name>"`, which Claude resolves in this order: an explicit value from the user, then `$ANTHROPIC_MODEL` when set, then the orchestrating Claude's own model name (valid only because a subagent inherits the session model unless an override is passed, so `SKILL.md` forbids passing one). If none of those produce a value, the skill **asks the user and waits**. There is no placeholder: an unlabeled run would let two models score one file with nobody noticing, which is what the per-file model pin exists to prevent. The resolved value is shown to the user before the run, since it is stamped permanently into the file.
- **The model is pinned per file.** `plan` refuses when `--model` disagrees with the model already recorded on a file's scored `llm` evaluator, which is the CLI-side equivalent of the app's provider lock (§3/§4). One model scores every ticket in a file.

## 3. Why this composes with the existing app

Verified against the current code, not assumed:

- `Workspace.hydrateSettingsFromFile` only adopts `provider` when it is `ollama` or `anthropic`, so an unknown provider is ignored rather than breaking settings.
- `configLocked` fires on any scored value, so opening a skill-produced file freezes schema and rules in the app and `ensureConfigStamped` becomes a no-op. The config fingerprint the CLI computed survives untouched.
- `applyLlmResults` only ever rewrites the `llm` evaluator, and `applyHumanValues` only the `human` one. So the round trip works: CLI eval, app human eval, CLI re-run of the remaining tickets, app compare.
- No renderer surface maps `Evaluator.provider` through `PROVIDER_LABELS`, so `'claude-code'` needs no label plumbing. Evaluator display uses `name`, which the engine sets.
- `effectiveRunSettings` returns settings unchanged for an unknown pinned provider, which is exactly the hole Stage 6 closes.

## 4. Risks and how each is handled

- **Fingerprint drift between the port and `src/shared`.** Silent failure mode: files simply stop merging. Handled by `test/skillParity.test.ts` running both implementations over one case table.
- **The app and the CLI writing the same file concurrently.** Handled by a stale-file guard: `plan` records the eval file's `meta.updatedAt`, `assemble` refuses if it changed on disk. Plus a documented "do not run while the app is editing it" note.
- **A subagent failing or writing garbage.** Treated as zero results for that batch, so those tickets get `error` results and the single retry round picks them up. Same posture as Qbort's top-up loop.
- **Model producing off-schema values.** Unchanged from the app: per-value coerce-or-drop with a non-silent `issues[]` trail, never a discarded ticket.

---

## Stage 1. Engine libs and parity test

Ports only. No CLI behavior yet.

- [x] `lib/args.mjs` (tiny `--flag value` parser, as in Qbort's engine)
- [x] `lib/fsUtil.mjs` (`atomicWriteJson`, `readJson`, port of `src/main/fsUtil.ts`)
- [x] `lib/schema.mjs` (`DEFAULT_SCHEMA`, `DEFAULT_SCORE`, `allowsMultiple`, `toCamelKey`, `propertyErrors`, `normalizeSchema`)
- [x] `lib/rules.mjs` (`DEFAULT_RULES`, `normalizeRules`)
- [x] `lib/fingerprint.mjs` (`canonicalizeTickets`, `canonicalizeConfig`, `sha256Hex` via `node:crypto`, `datasetFingerprint`, `configFingerprint`)
- [x] `lib/tickets.mjs` (`parseTicketsFile`, zod replaced by equivalent plain guards, same drop and coerce rules)
- [x] `lib/promptCompiler.mjs` (`SYSTEM_PROMPT`, `describeProperty`, `renderTicket`, `compilePrompt`)
- [x] `lib/evalValidate.mjs` (`clampScore`, the four coercers, `validateValues`, `hasDrops`)
- [x] `lib/evalFile.mjs` (`createWorkingFile`, `applyLlmResults`, `normalizeEvalFile`, `needsAttention`, `isScoredResult`, `mergeResults`, `ownResults`)
- [x] `test/skillParity.test.ts` asserting port and original agree over one case table:
  - [x] `datasetFingerprint`: reformatted or re-serialized tickets match, any content change does not
  - [x] `configFingerprint`: rules whitespace normalized out, schema reorder changes the hash
  - [x] `normalizeSchema`: invalid rows dropped, duplicate keys deduped, enum with fewer than 2 options rejected, empty result falls back to the default schema
  - [x] `validateValues`: clamp, coerce, drop, multiple dedupe, `[]` as a scored value, unknown keys ignored, omitted property produces no issue
  - [x] `compilePrompt`: full string equality including the output contract and example shape
  - [x] `parseTicketsFile`: duplicate ids dropped, unknown status coerced to `open`, bare array accepted
  - [x] `normalizeEvalFile`: a file written by the engine round-trips through the app's normalizer

**Gate:** `npm run typecheck` and `npm test` green. Review the ports against their originals side by side.

## Stage 2. Config authoring commands

- [x] `templates/EVAL_RULES.md` seeded from `DEFAULT_RULES`
- [x] `templates/EVAL_SCHEMA.json` seeded from `DEFAULT_SCHEMA`, with a comment-free JSON array of `EvalProperty`
- [x] `engine.mjs init` copies whichever of the two files is missing, prints what it created, exits with a code meaning "stop and let the user edit"
- [x] `engine.mjs config --check` normalizes and prints a property table, per-row errors from `propertyErrors`, and the config fingerprint
- [x] `config --write` rewrites `EVAL_SCHEMA.json` in normalized form
- [x] `config --preview` prints the compiled static prefix (rules, schema spec, output contract)
- [x] Non-zero exit on an unusable schema so the skill stops rather than planning a doomed run

Notes from the build:

- Exit codes are the skill's control flow: `0` ok, `1` usage, `2` unusable input (missing file, bad JSON, invalid schema), `3` scaffolded by `init` (stop and let the user edit).
- `propertyErrors` alone is not enough for a hand-authored file: it never checks `type`, so a row typed `"rating"` passes it and is then silently dropped by `normalizeSchema`. `engine.mjs` wraps it with a type guard plus a post-check that normalization dropped nothing.
- `--write` and `--preview` both run the check first and refuse on failure, so `--write` only ever makes cosmetic changes (trimming, field order, defaults) and never drops a property.
- `test/skillParity.test.ts` now also pins the two templates to `DEFAULT_RULES`/`DEFAULT_SCHEMA` by config fingerprint, so a hand-edit there can't drift.

**Gate:** [x] manual run in a scratch directory (`init`, `--check`, a broken schema, `--write`, `--preview`). The printed fingerprint matches `src/shared/fingerprint.ts` for both the default config and an edited 4-property one.

## Stage 3. Run commands

- [x] `engine.mjs plan --tickets <file> --model "<name>" [--eval-file <file>] [--rules <file>] [--schema <file>] [--out .qval-run] [--mode all|remaining|selection --ids 1,2,3] [--batch-size 10]`
  - [x] parse tickets, compute `datasetFingerprint`, normalize config, compute `configFingerprint`
  - [x] resolve the model from `--model`, falling back only to `$ANTHROPIC_MODEL`, and exit non-zero with a clear message when neither yields a value (no placeholder, ever). Echo the resolved value in the `PLANNED` line so it is visible before the run
  - [x] refuse when the resolved model disagrees with the model on the file's scored `llm` evaluator (one model per file, mirroring the app's provider lock)
  - [x] create the eval file when absent, load and normalize it when present
  - [x] refuse a dataset mismatch with the app's wording ("Different dataset ...")
  - [x] refuse a config mismatch with the app's wording ("Different rules or schema ...") plus a hint that a new file is the way to score under new criteria
  - [x] refuse a file whose scored `llm` evaluator has a non `claude-code` provider (the mirror of the Stage 6 app-side block)
  - [x] select targets by mode, reusing `needsAttention` for `remaining`
  - [x] chunk into batches, write `prompt-<round>-<i>.txt` with the system prompt inlined at the top (a subagent has no system slot)
  - [x] write `run-context.json` including the eval file path, its `meta.updatedAt` at plan time, and the per-batch ticket ids
  - [x] print a `PLANNED` line and a `ROUND 0` block with absolute `PROMPT=` and `BATCH=` paths
- [x] `engine.mjs assemble --round <r>`
  - [x] stale-file guard: refuse if the eval file's `updatedAt` changed since `plan`
  - [x] lenient batch read (missing, fenced, or garbled file counts as zero results)
  - [x] build one result per targeted ticket: `validateValues` on what the model returned, an `error` result for a ticket the model skipped
  - [x] `applyLlmResults` into the file, atomic write, update `run-context.json`
  - [x] print `EVALUATED`, `DROPPED`, `FAILED`, `NEEDS_RETRY`, and `FILE`
- [x] `engine.mjs retry --round 1`
  - [x] plan a round over only the tickets with an `error` or a dropped value
  - [x] capped at one round, matching the spec's single automatic validation retry (§6)
  - [x] `assemble` merges cleaner-wins against the first-pass snapshot via `mergeResults`
- [x] `engine.mjs status [--eval-file <file>]` prints LLM and human completeness, error count, and drop count

Notes from the build:

- **Default eval-file path** (the judgment call): `<tickets stem>.qval.json` in the working directory, mirroring the app's `suggestEvalName`. The scratch dir is disposable, and the eval file is what the user opens, merges, and exports, so it must not live somewhere anyone would happily delete.
- **Exit codes stay the Stage 2 convention**, split on whose mistake it is: a missing or malformed flag (`--model`, `--tickets`, `--mode`, `--ids`, `--batch-size`) exits `1`, while unusable *state* (bad JSON, fingerprint mismatch, model/provider lock, stale file, retry cap) exits `2`.
- **`plan` validates everything before it writes anything** (model, config, tickets, both fingerprints, both locks), so a refusal leaves the directory exactly as it found it, with no half-created eval file. Verified in the gate: a `MISSING_MODEL` run left only the two config files behind.
- **The schema `assemble` validates against is the eval file's own `meta.config.schema`**, not whatever `EVAL_SCHEMA.json` says at that moment. That snapshot is what the config fingerprint was taken over, so it is the only schema that can't drift out from under a round already with the subagents.
- **`NEEDS_RETRY` is a scheduling signal, not a count of problems.** Round 0 prints the unresolved count. A retry round prints `0` (the retry is capped at one, per spec §6) and reports what is left on a separate `RESIDUAL` line. Without that split, `SKILL.md`'s "retry when `NEEDS_RETRY > 0`" rule would loop forever on a genuinely unscoreable ticket.
- **The retry snapshot lives in `round-1.json`, not `run-context.json`.** `retry` copies the first-pass results for its targets into the round manifest, so `assemble --round 1` merges cleaner-wins against them. It also re-checks the dataset fingerprint, since it re-reads `tickets.json` to compile prompts and the file could have changed since `plan`.
- **The stale-file guard is re-stamped on every write the engine makes**, so `plan → assemble → retry → assemble` chains cleanly while any write by the app in between still trips it.
- `run-context.json` keeps an `assembled: []` list; `retry` refuses when round 0 isn't in it, so it can never re-plan a round that hasn't produced results yet.

**Gate:** [x] end-to-end run over Qbort's 10-ticket `tickets.json` at `--batch-size 4` (3 batches), real subagents, no model override. Round 0 was assembled with one batch file hand-garbled to unparseable prose and one ticket hand-deleted from another: 5 evaluated, 5 failed (4 batch-level, 1 `Model did not return a result for this ticket.`), `NEEDS_RETRY 5`. The retry round targeted exactly those 5 and resolved all of them → 10/10 scored, 0 errors, 0 drops. Refusals confirmed live: `MISSING_MODEL`, `DATASET_MISMATCH`, `CONFIG_MISMATCH`, `MODEL_LOCKED`, `STALE_FILE`, `RETRY_CAPPED`, plus `NOTHING_TO_DO` on a second `--mode remaining`. The resulting file was verified against the app's *own* `normalizeEvalFile`, `datasetFingerprint`, and `configFingerprint` (round-trips unchanged, both fingerprints agree). [ ] Open it in the app and confirm the LLM column renders and the human form works.

## Stage 4. Engine tests

`test/skillEngine.test.ts`, driving subcommands via `child_process` in a temp directory with pre-written batch files standing in for subagents.

- [x] fresh `plan` then `assemble` produces a file that passes the app's `normalizeEvalFile`
- [x] a garbled or missing batch file yields `error` results, and the retry round resolves them
- [x] cleaner-wins merge: a value that validated on the first attempt survives a worse retry
- [x] `--mode remaining` targets only unevaluated, errored, or dropped tickets
- [x] dataset fingerprint mismatch is refused with the expected message
- [x] config fingerprint mismatch is refused with the expected message
- [x] `plan` without a resolvable model exits non-zero and writes nothing
- [x] a `--model` that disagrees with the file's recorded model is refused
- [x] the recorded evaluator carries the resolved model and a matching `LLM · <model>` name
- [x] a re-run leaves existing `human` evaluator results untouched
- [x] stale-file guard trips when the eval file changes between `plan` and `assemble`
- [x] deterministic: no network, no real subagents, temp directories cleaned up

Notes from the build:

- **The contract under test is the exit code plus the first stdout/stderr token**, because that is all `SKILL.md` can branch on. Every case asserts both, split the Stage 2/3 way: `1` for a malformed flag (`BAD_MODE`, `MISSING_IDS`, `BAD_BATCH_SIZE`, `MISSING_TICKETS`, `MISSING_MODEL`), `2` for unusable state (`DATASET_MISMATCH`, `CONFIG_MISMATCH`, `MODEL_LOCKED`, `PROVIDER_LOCKED`, `STALE_FILE`, `RETRY_CAPPED`, `NOT_ASSEMBLED`, `UNKNOWN_IDS`, `NO_CONTEXT`, `BAD_JSON`, `SCHEMA_INVALID`, `MISSING_RULES`), `3` for `init` scaffolding.
- **Past the first token, assertions are structural, not textual.** What a round targets is read off `round-<r>.json` and what a plan resolved off `run-context.json`, rather than matched against the printed `PLANNED`/`ROUND` prose. The exceptions are the counts `SKILL.md` branches on (`EVALUATED`, `DROPPED`, `FAILED`, `NEEDS_RETRY`, `RESIDUAL`) and the echoed model. Everything the engine prints for a human to read stays free to be reworded.
- **A subagent is modeled as a file that appears at the path the engine printed.** The `respond` helper reads the round manifest and writes each batch file; returning `null` is a subagent that died. All four failure shapes are reachable without a mock: garbled prose, no file at all, a valid object that omits a ticket, and an id the model invented (ignored, since ids come from the manifest).
- **`$ANTHROPIC_MODEL` is stripped from the inherited environment** for every run. A developer who has one configured would otherwise turn the `MISSING_MODEL` cases green; the fallback is then tested by passing it explicitly.
- **"Writes nothing" is asserted as a recursive content snapshot** of the working directory, taken before the refusal and compared after, rather than as "no eval file appeared". That also covers the round manifest and `run-context.json`, where a half-planned run would actually show up.
- The cleaner-wins case is built so the two attempts fail on *different* properties (round 0 drops `severity` and keeps `empathy`, round 1 the reverse), which is the only shape where an overwrite and a merge produce different files.
- **Deliberately *not* re-tested here:** anything the parity suite already pins. The per-value coercion table, `normalizeSchema`, and the config fingerprint are covered there unit by unit, so this suite only checks that `assemble` validates against the file's own schema snapshot and turns the results into the right counts. `init`/`config` are reduced to their exit codes, the only part `SKILL.md` reads.

**Gate:** [x] `npm run typecheck` and `npm test` green: 223 tests across 21 files (20 of them here), including Stage 1's parity suite. Temp directories verified gone after the run.

## Stage 5. SKILL.md and README.md

- [x] `SKILL.md` frontmatter (`name: evaluate-tickets`, description covering "evaluate tickets", "score a ticket set", "qval")
- [x] Step: locate the `tickets.json` (ask if ambiguous)
- [x] Step: ensure `EVAL_RULES.md` and `EVAL_SCHEMA.json`, scaffolding and stopping when missing
- [x] Step: draft the schema with the user from their description, then `config --check` and show the table before running
- [x] Step: resolve the model to record (explicit value, then `$ANTHROPIC_MODEL`, then Claude's own model name). When none of those yield one, **stop and ask the user with `AskUserQuestion`** and do not proceed until they answer. State the resolved value, then pass it as `--model`
- [x] Step: `plan`, using `AskUserQuestion` for `all` vs `remaining` only when an eval file already exists
- [x] Step: fan out **all** of a round's batches as subagents in a single message, with the exact task text (read PROMPT, write only JSON to BATCH, reply `done`, touch no other files)
- [x] Never pass a model override when spawning the subagents, so they inherit the session model and the recorded model stays truthful
- [x] Step: `assemble`, then at most one `retry` round when `NEEDS_RETRY > 0`
- [x] Step: report the file path and counts, and hand off to the app for the human evaluation
- [x] Invariants section: never hand-write the `.qval.json`, never post-edit ids or values, do not run while the app is editing the same file, no cost accounting exists for ambient runs
- [x] `README.md`: requirements, project vs `~/.claude/skills` install, walkthrough, what you get, how-it-works diagram, caveats (no token or cost stats, one model per file, the app blocks in-app re-runs, batch-size tradeoff)

Notes from the build:

- **The exit-code table is stated once, up front**, and every step then names only the tokens it can produce. That is the same contract Stage 4's tests pin (first token plus exit code), so the two can't drift: a reworded message stays fine, a renamed token breaks both.
- **The `ROUND` block is read, never reconstructed.** `SKILL.md` says to take `PROMPT=`/`BATCH=` verbatim from what `plan`/`retry` printed. Reconstructing paths would duplicate the engine's `--out`/round/index naming as prose, and a silent mismatch there means "no output was produced for this batch" for every ticket.
- **Two rules the engine can't enforce get their own blocks**, not folded into a step: fan all of a round's batches out in a single message, and never pass a model override when spawning them. The second is a blockquote with the consequence spelled out, since one overridden subagent makes the recorded model permanently wrong and nothing downstream can detect it.
- **"Do not read the prompt or batch files yourself"** is explicit. Nothing stops an agent opening them out of curiosity, which throws away the point of the engine reading them in Node.
- **The retry step is written as "exactly one round, do not loop"**, with `RESIDUAL` named as the stopping signal. That mirrors the `NEEDS_RETRY 0` the engine prints on round 1 for precisely this reason.
- `CONFIG_MISMATCH` gets an explicit "do not 'fix' this by editing the existing file". The tempting repair (hand-editing the file's config snapshot) is exactly what breaks merging.

**Gate:** [ ] invoke the skill cold in a fresh directory and follow it exactly as written, changing nothing by hand.

## Stage 6. App-side guard and docs sync

- [x] `src/shared/evalFile.ts`: `CLAUDE_CODE_PROVIDER`, `isExternalLlmProvider(provider)`, and a helper returning the block reason for a file (or null)
- [x] `src/main/evaluation/service.ts`: `estimate` and `start` throw that reason, so the block holds even if the UI is bypassed
- [x] `src/shared/readiness.ts`: readiness accounts for the blocked file so the modal can explain it
- [x] `EvaluateModal`: Run disabled with "Scored by the Claude Code skill. Continue the LLM run from the CLI."
- [x] `ProviderConfig`: lock notice says the lock came from a skill-produced file
- [x] Tests: `evalFile.test.ts` (helpers), `service.test.ts` (estimate and start both throw), `readiness.test.ts`
- [x] `.gitignore`: add `.qval-run/`
- [x] `README.md`: an "Evaluate with Claude Code" section covering the CLI path and where the app picks back up
- [x] `AGENTS.md`: skill directory in the structure list, and a note that the skill's `lib/` is a port guarded by the parity test
- [x] `.plans/PROJECT_SPEC.md`: new §18 "Headless evaluation (Claude Code skill)", a phase 10 entry in §14, and a §16 decisions line
- [x] `.plans/REVIEW.md`: updated with whatever this work changes

Notes from the build:

- **The block is a refusal, not a fourth branch in `effectiveRunSettings`.** §3 identified that function as the hole (it returns settings unchanged for a provider it doesn't recognise), but the fix doesn't belong there: there is no correct provider to substitute. `llmRunBlockReason` sits in front of the run instead, so `effectiveRunSettings` never sees a file it can't pin.
- **It keys off `lockedLlmProvider`, not off any evaluator carrying the provider string.** That makes the block exactly as narrow as the app's own provider lock: an error-only skill file (nothing scored) is still runnable in-app, which is right, since nothing has been committed to yet.
- **`isExternalLlmProvider` is derived from `ALL_PROVIDERS`, not a `!== 'claude-code'` test.** Any future non-adapter provider blocks by default rather than falling into the silent-substitution hole, and adding a real adapter to `ALL_PROVIDERS` unblocks it with no second edit.
- **Reason text vs. skill-specific text.** `llmRunBlockReason` is the one string the user reads in the modal, so it names the skill and the CLI. `ProviderConfig` branches separately on `CLAUDE_CODE_PROVIDER` for its lock notice (which also shows the recorded model). A hypothetical third-party provider falls through to the original lock wording, which is still accurate.
- **The modal skips the estimate fetch when blocked.** `estimate` now throws for those files and the modal fetches on open, so without the guard, opening EVALUATE on a skill file would fire an error toast before the user read the explanation.
- Readiness took an optional third param rather than a new function, so the modal still has one thing to ask "can this run?" and one message to render.

**Gate:** [x] `npm run typecheck` and `npm test` green: 231 tests across 21 files (up from 223, +8 here). [ ] Full manual pass: CLI eval, open in app, human eval, merge a teammate's file, export the report.

---

## Definition of done

- [x] A user with no Anthropic API key can produce a complete `*.qval.json` from the CLI (Stage 3 gate: 10/10 scored, both fingerprints verified against the app's own code)
- [ ] That file opens in the app, shows LLM results, and accepts a human evaluation
- [ ] The comparison and roll-up surfaces work on it exactly as on an app-produced file
- [ ] A CLI file and an app file of the same dataset and config still merge (the parity test's real purpose)
- [x] Pressing EVALUATE on a skill-produced file explains itself rather than silently mixing models (code + tests; still to be seen in the app)
- [x] `npm run typecheck` and `npm test` green, all tests deterministic and offline
