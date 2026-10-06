# evaluate-tickets (Claude Code skill)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that evaluates a set of customer support tickets and writes a Qval eval file (`*.qval.json`). It is [Qval](../../../README.md)'s **LLM evaluation** step, and the only one there is. Under the default `claude` scorer it uses the **ambient Claude model** (via parallel subagents) to do the judging, with no API key. Under the optional `jev` scorer the engine sends each ticket to Typesafe's Jev itself. Either way, a small, dependency-free Node engine owns everything structural.

The config it scores against comes from the sibling skill **[`/qval:draft`](../draft/README.md)**, which runs first. Everything else happens in the review UI, the sibling skill **[`/qval:review`](../review/SKILL.md)**, which runs before or after this one. Browsing tickets, reading the LLM's scores per ticket, doing the **human evaluation** by hand, merging other people's files, and the comparison and insights surfaces all live there. This skill writes the LLM half of the file they operate on.

## Requirements

- **Claude Code** (the skill runs inside it). No Anthropic API key needed. That's the point.
- For the **Jev** scorer only, a Typesafe key in `TYPESAFE_API_KEY`, exported from your shell profile. It is read from the environment and nowhere else, and you never paste it into the chat.
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

1. `cd` into the directory holding your ticket file (the skill reads and writes there). The filename doesn't matter. Candidates are found by opening the `.json` files and checking the shape. A `qbort-output/` subdirectory is searched too, if you have one. If there's more than one dataset, you'll be asked which you meant. If there's none, you'll be asked for the path.
2. Invoke the skill by typing **`/qval:evaluate-tickets`**. It is deliberately not model-invocable: it stays out of the context window until you ask for it, which means asking in prose ("evaluate these tickets") will not trigger it.
3. The skill needs **`EVAL_RULES.md`** and **`EVAL_SCHEMA.json`**, which **[`/qval:draft`](../draft/README.md)** writes. If they're missing it stops and sends you there. `engine.mjs config` validates them and prints the schema back as a table before anything runs. `/qval:review` reads and writes the same two files, so a schema adjusted in the browser is one this skill can run against.
4. Confirm the **model** to record. It's stamped permanently into the eval file, so there's no default and no placeholder. The skill asks if it can't resolve one.
5. The skill plans the run, fans the batches out to parallel subagents, assembles the results, and runs one retry round over anything that failed or produced an off-schema value. A `jev` config skips steps 4 and 5: `engine.mjs jev` sends each ticket to Typesafe from Node in the background, saves each response under `.qval-run/jev/`, and records `provider: typesafe`, `model: jev-latest`. An interrupted run continues with `--resume`, which re-sends only tickets with no saved response.
6. Run **`/qval:review`** to open the resulting **`*.qval.json`** in a browser, read the scores, and add your human evaluation.

Both directories are generated, so gitignore `qval-output/` and `.qval-run/` alike. `.qval-run/` is scratch (run state, per-batch compiled prompts, raw subagent output, saved Jev responses, a draft awaiting approval) and is safe to delete between runs. The eval file is deliberately kept out of it, in `qval-output/`, because that one is not. Neither location is configurable.

Starting a run (`plan` or `jev`) clears the previous run's prompts, batch files, round manifests, and saved Jev responses, so a run is never assembled from output an earlier one left behind. `jev --resume` is the exception, and it only resumes the run that saved them. The review half's session record and settings, and any pending draft, are left alone. Those live in the same directory and outlast any single run.

## What you get

A standard Qval eval file: a snapshot of `{scorer, schema, rules}`, a `dataset` fingerprint and a `config` fingerprint, and an `llm` evaluator. Under `claude` its `provider` is `claude-code` and its `model` is the one you confirmed (so it shows up as `LLM · Opus 5`). Under `jev` they are `typesafe` and `jev-latest`. It references the dataset by fingerprint rather than embedding the tickets.

When you omit `--eval-file`, the path is derived from the dataset filename and written to `qval-output/`, wherever the dataset itself lives (`exports/zendesk-q3.json` → `./qval-output/zendesk-q3.qval.json`). A file an older version left loose in the working directory is used where it lies instead, so upgrading never starts a second, empty evaluation beside a full one.

The fingerprints are computed by the very same code the review UI runs, so two files of the same tickets, rules, and schema always **merge** with each other, whichever side produced them.

## How it works

```
skill (SKILL.md drives Claude):
  ├─ locate the ticket file             (by shape, not name; ask if ambiguous or absent)
  ├─ EVAL_RULES.md + EVAL_SCHEMA.json?  (missing → stop, run /qval:draft)
  ├─ engine.mjs config                  (row-level errors, property table, config fingerprint)
  │
  ├─ scorer claude:
  │  ├─ resolve the model to record     (explicit → $ANTHROPIC_MODEL → session model → ask)
  │  ├─ engine.mjs plan                 (fingerprints, target selection, batching, prompt files)
  │  ├─ fan out one subagent per batch  (parallel, single message; each writes raw JSON to a batch file)
  │  ├─ engine.mjs assemble --round 0   (validate per value, merge into the eval file, atomic write)
  │  └─ engine.mjs retry --round 1 + assemble   (once, over failed or dropped tickets only)
  │
  └─ scorer jev:
     └─ engine.mjs jev                  (in the background; one request per ticket to Typesafe,
                                         each response saved, then validated and merged; --resume)
```

The engine owns the deterministic spine: config validation, both fingerprints, target selection, batching, prompt compilation, per-value validation and repair, retry accounting, eval-file assembly, and atomic writes. The subagents only supply judgment, reading a compiled prompt and writing a JSON object of schema-keyed values. A Jev run has no subagents, and its answers go through the same per-value validation. Ticket ids come from the dataset and are never trusted from the model.

One improvement over Qbort's sibling [generate-tickets](https://github.com/balevine/qbort) skill: the engine reads the batch files and Jev responses in Node, so **ticket content and scores never round-trip through Claude's context**. Only the engine's short stdout summary does, which keeps large runs cheap.

`../../lib/` holds Qval's logic itself, not a copy of it. The review UI and the review server import the same files. That is why it is dependency-free ESM: it has to run here on bare `node`, and there is nowhere else for it to live. Exported functions carry JSDoc types, which the TypeScript side checks against and node ignores. It sits one level up from this skill because the review server and the `qval` CLI import it too.

## Files

```
SKILL.md                    instructions Claude follows (not human docs)
engine.mjs                  CLI: init | config | draft-check | draft-apply | plan | assemble | retry | jev | status
                            (init and the draft commands are run by /qval:draft)
../../lib/                  the logic, shared with the review UI (schema, rules, fingerprint, tickets,
                            promptCompiler, evalValidate, evalFile, aggregate, settings, workspace,
                            settingsStore, fsUtil, paths, args, host, version, draft, jev, typesafe)
```

## Caveats

- **No token or cost stats.** Ambient generation isn't a metered API call, and Qval doesn't price Jev requests either, so there's nothing to count and no estimate to show.
- **One provider and one model per eval file.** The recorded model is the one that scored every ticket, and `plan` and `jev` refuse to top up a file whose `llm` evaluator records a different one (`MODEL_LOCKED`, `PROVIDER_LOCKED`), because a second model's values inside one evaluator would make its recorded model a lie. Scoring the same dataset with a second model means a second eval file. Two files merge only when their config matches, and a Jev config never matches a Claude one.
- **Once an eval file has scores, changing the rules, the schema, or the scorer needs a new eval file.** All of them are hashed into the config fingerprint, so an edit makes a scored file incompatible on purpose. `plan` and `jev` refuse with `CONFIG_MISMATCH` rather than mixing criteria in one file. A file with no scores yet takes on the current config instead and says so with `CONFIG_ADOPTED`.
- **Batch size is a tradeoff.** Bigger batches (`--batch-size`, default 10) mean fewer subagents and less overhead, but a truncated or garbled response loses more tickets at once. They're recoverable either way, since the retry round picks them up.
- **Don't run it while a review session has the same eval file open.** It refuses (`SESSION_LIVE`) rather than race the review server for the file. That is a refused run, not lost work. Click **Finish** in the review tab first.
- **One retry round, not a loop.** A ticket that's genuinely unscoreable stays in the file as an error rather than burning subagents forever. Re-plan with `--mode remaining` if you want another go.
