# evaluate-tickets (Claude Code skill)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that evaluates a set of customer-support tickets and writes a Qval eval file (`*.qval.json`). It is [Qval](../../../README.md)'s **LLM evaluation** step, and the only one there is: rather than calling an LLM API with your own key, it uses the **ambient Claude model** (via parallel subagents) to do the judging, while a small, dependency-free Node engine owns everything structural.

Everything else happens in the review UI, which is the sibling skill **[`/qval:review`](../review/SKILL.md)**. Browsing tickets, reading the LLM's scores per ticket, doing the **human evaluation** by hand, merging other people's files, and the comparison and insights surfaces all live there. This skill produces the file they operate on.

## Requirements

- **Claude Code** (the skill runs inside it). No Anthropic API key needed; that's the point.
- **Node.js** on your `PATH` (`node --version`). No `npm install`, since the engine is dependency-free ESM.
- A **ticket file** to evaluate: either `{ meta, tickets: [...] }` or a bare array, where each ticket is `{ id, subject, status, messages: [{ from, body, isStaff, createdAt }] }`. Only the integer `id` is required, absent fields are filled in, and unknown ones are ignored, so a script that maps your own helpdesk export into this shape is all it takes. [Qbort](https://github.com/balevine/qbort) writes the same format if you'd rather generate a set than export one.

## Install

- **As a plugin** (any project on your machine), two lines in Claude Code:

  ```
  /plugin marketplace add balevine/qval
  /plugin install qval@qval
  ```

- **From a clone**, if you'd rather read the source before you run it. The repo root is itself the marketplace, so point Claude Code at your clone:

  ```bash
  git clone https://github.com/balevine/qval
  ```
  ```
  /plugin marketplace add ./qval
  /plugin install qval@qval
  ```

  Every file is in front of you, and it installs the whole plugin rather than one skill of it. Copying the skill folder into `~/.claude/skills/` on its own no longer works: `engine.mjs` imports `../../lib/`, which the plugin shares with its server and CLI.

## Usage

1. `cd` into the directory holding your ticket file (the skill reads and writes there). The filename doesn't matter — candidates are found by opening the `.json` files and checking the shape. A `qbort-output/` subdirectory is searched too, if you have one. If there's more than one dataset, you'll be asked which you meant; if there's none, you'll be asked for the path.
2. Invoke the skill by typing **`/qval:evaluate-tickets`**. It is deliberately not model-invocable: it stays out of the context window until you ask for it, which means asking in prose ("evaluate these tickets") will not trigger it.
3. If **`EVAL_RULES.md`** and **`EVAL_SCHEMA.json`** don't exist, the skill scaffolds them from the templates and stops so you can say what you actually want measured. Describe it in prose and Claude drafts both files; `engine.mjs config --check` validates the schema and prints it back as a table before anything runs. `/qval:review` reads and writes the same two files, so a schema built in the browser is one this skill can run against.
4. Confirm the **model** to record. It's stamped permanently into the eval file, so there's no default and no placeholder; the skill asks if it can't resolve one.
5. The skill plans the run, fans the batches out to parallel subagents, assembles the results, and runs one retry round over anything that failed or produced an off-schema value.
6. Run **`/qval:review`** to open the resulting **`*.qval.json`** in a browser, read the scores, and add your human evaluation.

`.qval-run/` is scratch (run state, per-batch compiled prompts, raw subagent output). Add it to `.gitignore` if you don't want it tracked. The eval file is deliberately kept out of it, because it's the durable artifact.

## What you get

A standard Qval eval file: a snapshot of `{schema, rules}`, a `dataset` fingerprint and a `config` fingerprint, and an `llm` evaluator whose `provider` is `claude-code` and whose `model` is the one you confirmed (so it shows up as `LLM · Opus 5`). It references the dataset by fingerprint rather than embedding the tickets.

When you omit `--eval-file`, the path is derived from the dataset filename and written to the working directory, wherever the dataset itself lives (`exports/zendesk-q3.json` → `./zendesk-q3.qval.json`).

The fingerprints are computed by the very same code the review UI runs, so two files of the same tickets, rules, and schema always **merge** with each other, whichever side produced them.

## How it works

```
skill (SKILL.md drives Claude):
  ├─ locate the ticket file             (by shape, not name; ask if ambiguous or absent)
  ├─ engine.mjs init                    (scaffold EVAL_RULES.md + EVAL_SCHEMA.json, then stop)
  ├─ draft rules + schema with the user
  ├─ engine.mjs config --check          (row-level errors, property table, config fingerprint)
  ├─ resolve the model to record        (explicit → $ANTHROPIC_MODEL → session model → ask)
  ├─ engine.mjs plan                    (fingerprints, target selection, batching, prompt files)
  ├─ fan out one subagent per batch     (parallel, single message; each writes raw JSON to a batch file)
  ├─ engine.mjs assemble --round 0      (validate per value, merge into the eval file, atomic write)
  └─ engine.mjs retry --round 1 + assemble   (once, over failed or dropped tickets only)
```

The engine owns the deterministic spine: config validation, both fingerprints, target selection, batching, prompt compilation, per-value validation and repair, retry accounting, eval-file assembly, and atomic writes. The subagents only supply judgment, reading a compiled prompt and writing a JSON object of schema-keyed values. Ticket ids come from the dataset and are never trusted from the model.

One improvement over Qbort's sibling [generate-tickets](https://github.com/balevine/qbort) skill: the engine reads the batch files in Node, so **ticket content and scores never round-trip through Claude's context**. Only the engine's short stdout summary does, which keeps large runs cheap.

`../../lib/` holds Qval's logic itself, not a copy of it. The review UI and the review server import the same files. That is why it is dependency-free ESM: it has to run here on bare `node`, and there is nowhere else for it to live. Exported functions carry JSDoc types, which the TypeScript side checks against and node ignores. It sits one level up from this skill because the review server and the `qval` CLI import it too.

## Files

```
SKILL.md                    instructions Claude follows (not human docs)
engine.mjs                  CLI: init | config | plan | assemble | retry | status
../../lib/                  the logic, shared with the review UI (schema, rules, fingerprint, tickets,
                            promptCompiler, evalValidate, evalFile, aggregate, settings, evaluation,
                            workspace, settingsStore, fsUtil, args)
templates/EVAL_RULES.md     starter rules text
templates/EVAL_SCHEMA.json  starter schema
```

## Caveats

- **No token or cost stats.** Ambient generation isn't a metered API call, so there's nothing to count and no estimate to show.
- **One model per eval file.** The recorded model is the one that scored every ticket, and `plan` refuses to continue a file under a different one. Scoring the same dataset with a second model means a second eval file, which you can then merge (that's what merging is for).
- **One model scores every ticket in a file.** `plan` refuses to top up a file whose `llm` evaluator already records a different model, because a second model's values inside one evaluator would make its recorded model a lie. Start a new eval file instead.
- **Changing the rules or schema needs a new eval file.** Both are hashed into the config fingerprint, so an edit makes the existing file incompatible on purpose. `plan` refuses with `CONFIG_MISMATCH` rather than mixing criteria in one file.
- **Batch size is a tradeoff.** Bigger batches (`--batch-size`, default 10) mean fewer subagents and less overhead, but a truncated or garbled response loses more tickets at once. They're recoverable either way, since the retry round picks them up.
- **Don't run it while a review session is editing the same eval file.** A stale-file guard refuses rather than overwriting a human evaluation made mid-run, but the cleanest habit is to close the review tab first.
- **One retry round, not a loop.** A ticket that's genuinely unscoreable stays in the file as an error rather than burning subagents forever. Re-plan with `--mode remaining` if you want another go.
