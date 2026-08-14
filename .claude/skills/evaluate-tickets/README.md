# evaluate-tickets (Claude Code skill)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that evaluates a set of customer-support tickets and writes a Qval eval file (`*.qval.json`). It's the [Qval](../../../README.md) desktop app's **LLM evaluation** step, done headlessly: instead of calling a hosted or local LLM API with your own key, it uses the **ambient Claude model** (via parallel subagents) to do the judging, while a small, dependency-free Node engine owns everything structural.

Everything else stays in the app. Browsing tickets, reading the LLM's scores per ticket, doing the **human evaluation** by hand, merging other people's files, and the comparison and insights surfaces are all app work. This skill produces the file they operate on.

## Requirements

- **Claude Code** (the skill runs inside it). No Anthropic API key needed; that's the point.
- **Node.js** on your `PATH` (`node --version`). No `npm install`, since the engine is dependency-free ESM.
- A **`tickets.json`** to evaluate, as produced by [Qbort](https://github.com/balevine/qbort).

## Install

- **Project-scoped** (this repo): it already lives at `.claude/skills/evaluate-tickets/`.
- **Global** (any project on your machine): copy the whole folder to `~/.claude/skills/evaluate-tickets/`.

## Usage

1. `cd` into the directory holding your `tickets.json` (the skill reads and writes there).
2. Invoke the skill: type **`/evaluate-tickets`**, or just ask (e.g. "evaluate these support tickets").
3. If **`EVAL_RULES.md`** and **`EVAL_SCHEMA.json`** don't exist, the skill scaffolds them from the templates and stops so you can say what you actually want measured. Describe it in prose and Claude drafts both files; `engine.mjs config --check` validates the schema and prints it back as a table before anything runs.
4. Confirm the **model** to record. It's stamped permanently into the eval file, so there's no default and no placeholder; the skill asks if it can't resolve one.
5. The skill plans the run, fans the batches out to parallel subagents, assembles the results, and runs one retry round over anything that failed or produced an off-schema value.
6. Open the resulting **`*.qval.json`** in the Qval app to review the scores and add your human evaluation.

`.qval-run/` is scratch (run state, per-batch compiled prompts, raw subagent output). Add it to `.gitignore` if you don't want it tracked. The eval file is deliberately kept out of it, because it's the durable artifact.

## What you get

A standard Qval eval file, the same shape as one the app produces: a snapshot of `{schema, rules}`, a `dataset` fingerprint and a `config` fingerprint, and an `llm` evaluator whose `provider` is `claude-code` and whose `model` is the one you confirmed (so it shows up as `LLM · Opus 5`, following the app's own naming). It references the dataset by fingerprint rather than embedding the tickets.

When you omit `--eval-file`, the path is derived from the dataset filename (`tickets.json` → `./tickets.qval.json`), matching what the app's save dialog would suggest for the same dataset.

Because the fingerprints are computed by a port of the app's own code (guarded by a parity test in the repo), a CLI-produced file and an app-produced file of the same tickets, rules, and schema still **merge** with each other.

## How it works

```
skill (SKILL.md drives Claude):
  ├─ locate tickets.json                (ask if ambiguous)
  ├─ engine.mjs init                    (scaffold EVAL_RULES.md + EVAL_SCHEMA.json, then stop)
  ├─ draft rules + schema with the user
  ├─ engine.mjs config --check          (row-level errors, property table, config fingerprint)
  ├─ resolve the model to record        (explicit → $ANTHROPIC_MODEL → session model → ask)
  ├─ engine.mjs plan                    (fingerprints, target selection, batching, prompt files)
  ├─ fan out one subagent per batch     (parallel, single message; each writes raw JSON to a batch file)
  ├─ engine.mjs assemble --round 0      (validate per value, merge into the eval file, atomic write)
  └─ engine.mjs retry --round 1 + assemble   (once, over failed or dropped tickets only)
```

The engine owns the deterministic spine: config validation, both fingerprints, target selection, batching, prompt compilation, per-value validation and repair, retry accounting, eval-file assembly, and atomic writes. The subagents only supply judgment, reading a compiled prompt and writing a JSON object of schema-keyed values. Ticket ids come from the dataset and are never trusted from the model, exactly as in the app.

One improvement over Qbort's sibling [generate-tickets](https://github.com/balevine/qbort) skill: the engine reads the batch files in Node, so **ticket content and scores never round-trip through Claude's context**. Only the engine's short stdout summary does, which keeps large runs cheap.

Most of the pure logic in `lib/` is ported from the app's `src/shared` and `src/main` (`schema`, `rules`, `fingerprint`, `promptCompiler`, `validate`, `evalFile`, `fsUtil`), with zod's parse-and-repair replaced by equivalent plain-JS guards. `test/skillParity.test.ts` in the repo runs both implementations over one case table, because silent fingerprint drift would mean files quietly stop merging.

## Files

```
SKILL.md                    instructions Claude follows (not human docs)
engine.mjs                  CLI: init | config | plan | assemble | retry | status
lib/                        ported pure logic (schema, rules, fingerprint, tickets, promptCompiler, evalValidate, evalFile, fsUtil, args)
templates/EVAL_RULES.md     starter rules text
templates/EVAL_SCHEMA.json  starter schema
```

## Caveats

- **No token or cost stats.** Ambient generation isn't a metered API call, so there's nothing to count. The app's estimate and usage numbers have no equivalent here.
- **One model per eval file.** The recorded model is the one that scored every ticket, and `plan` refuses to continue a file under a different one. Scoring the same dataset with a second model means a second eval file, which you can then merge (that's what merging is for).
- **The app blocks in-app re-runs of a skill-produced file.** Pressing EVALUATE explains itself and points back here. Letting the app top up a file scored by the ambient model would make the file's recorded provider and model a lie.
- **Changing the rules or schema needs a new eval file.** Both are hashed into the config fingerprint, so an edit makes the existing file incompatible on purpose. `plan` refuses with `CONFIG_MISMATCH` rather than mixing criteria in one file.
- **Batch size is a tradeoff.** Bigger batches (`--batch-size`, default 10) mean fewer subagents and less overhead, but a truncated or garbled response loses more tickets at once. They're recoverable either way, since the retry round picks them up.
- **Don't run it while the app is editing the same eval file.** A stale-file guard refuses rather than overwriting a human evaluation made mid-run, but the cleanest habit is to close the file in the app first.
- **One retry round, not a loop.** A ticket that's genuinely unscoreable stays in the file as an error rather than burning subagents forever. Re-plan with `--mode remaining` if you want another go.
