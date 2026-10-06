---
name: evaluate-tickets
description: Score a set of customer support tickets with the ambient Claude model or Typesafe's Jev against user-written rules and a typed schema, writing a Qval eval file (*.qval.json).
disable-model-invocation: true
---

# evaluate-tickets

Scores a ticket file and writes a Qval eval file (`*.qval.json`). The **ambient Claude model** (via subagents) supplies the *judgment*. A deterministic Node engine (`engine.mjs`) owns everything structural: config validation, both fingerprints, target selection, batching, prompt compilation, per-value validation and repair, retry accounting, and the atomic eval-file writes. Never hand those structural jobs to the model. A `jev` config is the exception to the subagents: the engine sends it to Typesafe itself (see **Jev runs**).

The engine lives next to this file, at `engine.mjs`. Let `ENGINE` be its absolute path, which is `${CLAUDE_PLUGIN_ROOT}/skills/evaluate-tickets/engine.mjs`. Run all `node "$ENGINE" ...` commands from the user's working directory. Scratch state goes to `.qval-run/` and the eval file to `qval-output/`, both under that directory and **neither configurable**. The review half writes its session record into the same `.qval-run/`, and the durable artifact is kept out of a directory that is safe to delete.

**How to read the engine.** Each command's first stdout/stderr token plus its exit code is the contract. Branch on those, not on the prose around them. Exit codes: **0** ok, **1** a bad or missing flag (fix the command), **2** unusable state (fix the files or ask the user, and never retry the same command verbatim).

## Step 1. Locate the tickets file

Find the dataset to evaluate: a path the user gave, else `ls *.json qbort-output/*.json`.

A ticket file is either `{ meta, tickets: [...] }` or a bare array of tickets, where a ticket is `{ id, subject, status, messages: [{ from: { name, email }, body, isStaff, createdAt }] }`. Only an integer `id` is required; `subject`, `status`, and `messages` are filled in when absent, unknown fields are ignored, and `meta` is optional (it is dropped before fingerprinting).

**The filename means nothing.** Identify a candidate by opening it and checking the shape, not by its name. Plenty of users hand-export their own ticket set from a real helpdesk, so expect names like `zendesk-q3.json` or `support-export.json` as readily as `tickets.json`. `qbort-output/` is worth a look because [Qbort](https://github.com/balevine/qbort) writes one timestamped run per file there, but most datasets are simply sitting in the working directory.

If more than one candidate exists and the user didn't name one, **ask with `AskUserQuestion`**. For Qbort output the newest is a reasonable thing to offer first, but not a safe thing to assume. Evaluating the wrong dataset produces a file that will never merge with anyone else's.

If you find **nothing**, say so and ask the user for a path rather than guessing. A dataset elsewhere on disk is fine: `plan --tickets` takes any path.

## Step 2. Check the config

The run scores against `EVAL_SCHEMA.json` (the scorer and the typed properties) and `EVAL_RULES.md` (free-text scoring guidance) in the working directory. **This skill never writes them.** `/qval:draft` does, and `/qval:review` reads and writes the same two, so a schema adjusted in the browser is already here.

If either file is missing, **stop** and tell the user to run `/qval:draft` first. Do not scaffold or write them yourself.

Otherwise:

```
node "$ENGINE" config
```

- **Exit 0**: prints `SCORER`, the property table, `CONFIG OK`, and `FINGERPRINT <hash>`. Show the user the table if they haven't seen it. For `claude`, go to Step 3. For `jev`, go to **Jev runs** below.
- **Exit 2**: `SCHEMA_INVALID` (with a per-row `ERRORS` block), `BAD_JSON`, `BAD_SCHEMA`, `BAD_SCORER`, `SCHEMA_EMPTY`, `MISSING_RULES`, `MISSING_SCHEMA`. Show the user the problem and point them at `/qval:draft`, or fix a typo they ask you to fix. Do not plan a run against a config that failed.

`config --preview` prints the exact static prefix the model will read, worth showing if the user is unsure how their rules will land.

## Step 3. Resolve the model to record

The evaluator stamped into the file records the model that actually did the scoring, and **one model scores every ticket in a file**. Resolve a value, in this order:

1. A model the user named explicitly.
2. `$ANTHROPIC_MODEL`, if it is set (`echo "$ANTHROPIC_MODEL"`).
3. **Your own model name**, valid only because subagents inherit the session model (see Step 5).

If none of those yields a value you are confident in, **stop and ask the user with `AskUserQuestion`** and wait for the answer. There is no placeholder and no default: an unlabeled run would let two different models score one file with nobody noticing, which is exactly what the per-file model pin exists to prevent.

State the resolved value to the user before running. It is stamped permanently into the eval file.

## Step 4. Plan the run

```
node "$ENGINE" plan --tickets <tickets.json> --model "<resolved model>"
```

Optional flags: `--eval-file <path>` (default: `qval-output/<tickets stem>.qval.json`, or an existing `<tickets stem>.qval.json` loose in the working directory, which is where older versions put it), `--mode all|remaining|selection` with `--ids 1,2,3` for `selection` (default `all`), `--batch-size N` (default 10), `--rules`/`--schema` for non-default config paths.

**Only ask about mode when the eval file already exists** (`ls qval-output/*.qval.json *.qval.json`, or run `node "$ENGINE" status --eval-file <path>`). Use `AskUserQuestion`: re-score **all** tickets, or only the **remaining** ones (unevaluated, errored, or with a dropped value). For a fresh file, just run `all`.

Read the output:

- **`PLANNED`**: followed by `EVAL_FILE`, `OUT`, and a **`ROUND 0`** block with one `BATCH <i> (<n> tickets) PROMPT=<abs path> BATCH=<abs path>` line per batch. Go to Step 5. A `CONFIG_ADOPTED <path>` line after it is not an error. That eval file had no scores yet, so it now carries the current rules and schema instead of the ones it was created with. Mention it and carry on.
- **`NOTHING_TO_DO`** (exit 0): nothing needs evaluation. Report that and skip to Step 7.
- **Exit 1**: `MISSING_MODEL`, `MISSING_TICKETS`, `BAD_MODE`, `MISSING_IDS`, `BAD_IDS`, `BAD_BATCH_SIZE`. Your command was wrong; fix it.
- **Exit 2**: the state is wrong, and `plan` wrote nothing.
  - `DATASET_MISMATCH`: that eval file is of different tickets. Use a different `--eval-file` or a different dataset.
  - `CONFIG_MISMATCH`: the rules or schema changed since that file was scored. Only a file with scores refuses this way. Scoring under new criteria needs a **new** eval file (`--eval-file <new path>`). Do not "fix" this by editing the existing file.
  - `MODEL_LOCKED` / `PROVIDER_LOCKED`: the file was already scored by a different model, or by another provider (Jev, or a desktop release). One model scores every ticket in a file, so re-run with that model or start a new eval file. Tell the user which.
  - `SESSION_LIVE`: a review session (`/qval:review`) has this eval file open and is writing to it. Ask the user to click **FINISH** in that tab, then re-run. Do not work around it by passing a different `--eval-file` unless they actually want a second evaluation.
  - `BAD_TICKETS`, `BAD_JSON`, `BAD_EVAL_FILE`, `UNKNOWN_IDS`, `MISSING_TICKETS <path>`.

## Step 5. Fan out one subagent per batch

Spawn **every batch of the round as a subagent in a single message** so they run in parallel. Use the `Agent` tool with `subagent_type: general-purpose`, and take the `PROMPT=` and `BATCH=` paths **verbatim from the `ROUND` block the engine just printed**. Never construct or guess them.

> **Never pass a model override when spawning these subagents.** They must inherit the session model, because that is the only reason the model recorded in Step 3 is true. A single overridden subagent makes the file's recorded model a lie, silently and permanently.

Give each subagent exactly this task, substituting its own PROMPT and BATCH paths:

> Read the file `<PROMPT path>`. It contains complete instructions, the tickets to evaluate, and the exact JSON output shape to produce. Follow it precisely and evaluate every ticket in it. Write ONLY the resulting JSON object (no markdown fences, no commentary) to `<BATCH path>`, overwriting it. Then reply with just `done`. Do not read or write any other files.

Do not read the prompt or batch files yourself. The engine reads them in Node, so ticket content and scored values never enter your context. That is what keeps large runs cheap.

If a subagent fails or writes nothing, carry on to Step 6 anyway. The engine treats a missing or garbled batch file as zero results, and those tickets become errors the retry round picks up.

## Step 6. Assemble, then at most one retry round

```
node "$ENGINE" assemble --round 0
```

It prints `ASSEMBLED`, then `EVALUATED`, `DROPPED`, `FAILED`, **`NEEDS_RETRY`**, and `FILE`.

- **`NEEDS_RETRY 0`**: done. Go to Step 7.
- **`NEEDS_RETRY > 0`**: run exactly one retry round.

  ```
  node "$ENGINE" retry --round 1     # prints a ROUND 1 block over only the failed/dropped tickets
  # then spawn that round's subagents in a single message (Step 5)
  node "$ENGINE" assemble --round 1
  ```

  Round 1 always prints `NEEDS_RETRY 0`, since the retry is capped at one round. Anything still unresolved is printed on a **`RESIDUAL n`** line instead. **Do not loop.** Report the residual; a genuinely unscoreable ticket stays in the file as an error, and the user can re-plan with `--mode remaining` later if they want.

Failures here:

- `SESSION_LIVE` (exit 2) means a review session opened on this file while the subagents were out. Ask the user to click FINISH in that tab, then **run the same `assemble --round <n>` again**. The subagents' answers are still on disk and nothing needs re-planning. Re-run `plan` only if that second attempt also refuses, since `plan` deletes those batch files and throws the round away.
- `FILE_REPLACED` (exit 2) means the eval file is no longer the same evaluation: different tickets, or scoring criteria that changed since `plan`. Re-planning is the only answer here, because these answers were written against the old schema and rules. An ordinary human edit does not cause this. `assemble` merges onto the newer file and leaves the human evaluation alone.
- `NOT_ASSEMBLED` means round 0 hasn't been assembled yet. `RETRY_CAPPED` means you passed a round other than 1.

## Jev runs

A `jev` config is scored by the engine itself, in Node, through Typesafe's API. There are no subagents, no batches, no model to resolve (the evaluator records `jev-latest`), and no retry round. Steps 3 to 6 do not apply.

1. **The key.** The engine reads `TYPESAFE_API_KEY` from the environment and nowhere else. **Never ask for the key in chat, and never echo, print, or write it.** If it is missing (`MISSING_KEY`), tell the user to add `export TYPESAFE_API_KEY=...` to their shell profile and restart Claude Code from a shell that has it, then stop.
2. **Run it in the background**, since a large dataset outlives the Bash timeout. Use the Bash tool with `run_in_background: true`, and in auto mode `allowed_domains: ["api.typesafe.ai"]`:

   ```
   node "$ENGINE" jev --tickets <tickets.json>
   ```

   It takes `--eval-file`, `--mode all|remaining|selection --ids ...`, `--rules`/`--schema` as `plan` does (ask about mode the same way, only when the eval file exists), and `--concurrency N` (default 4). It refuses exactly as `plan` does (Step 4), plus `WRONG_SCORER` for a `claude` config. All of those exit before anything is sent.
3. **Read the summary when it lands**: `JEV_DONE`, then `SENT`, `CACHED`, `EVALUATED`, `DROPPED`, `FAILED` (with up to three error lines), `REPORTED_MODEL`, and `EVAL_FILE`, plus a `CONFIG_ADOPTED` line when an unscored eval file took on the current config (as with `plan`). A score answer is snapped to the nearest level and recorded as `clamped`, so those issues are expected. Failed and dropped tickets stay in the file; offer `--mode remaining` to try them again.
4. **If it was interrupted**, or ended in `SESSION_LIVE` (ask the user to click FINISH first), run the same command with `--resume`. Each response is saved under `.qval-run/jev/` as it arrives, so a resume only sends tickets that have none. `RESUME_MISMATCH` means the last run here was of a different eval file or different criteria, so start over without `--resume`. `KEY_REJECTED` (exit 2) means Typesafe refused the key. The user needs to fix it in their profile.

Then go to Step 7.

## Step 7. Report and hand off

```
node "$ENGINE" status
```

Tell the user the eval file path and the counts (scored / total, errors, dropped values), then hand off: **`/qval:review`** opens that file in a browser, which is where they browse the LLM results per ticket, fill in the **human evaluation** by hand, and reach the merge and comparison surfaces. Offer it; don't run it for them unless they ask. Continuing the LLM run means coming back to this skill.

Do not print the whole eval file. Offer to summarize a few tickets if they want a spot check.

## Notes / invariants

- **Never hand-write or hand-edit the `.qval.json`.** Every write goes through the engine, which is what keeps ids, fingerprints, `updatedAt`, and the evaluator record consistent. A hand-edit can silently break merging with other people's files.
- **Ticket ids come from the dataset, never from the model.** The engine looks the model's output up by id and records an error for anything it skipped. Don't post-edit ids or values to "fix" a run.
- **Values are validated per property, never per ticket.** An out-of-range or off-schema value is coerced when unambiguous and dropped when not, with a non-silent `issues[]` trail. One bad field never discards a ticket's other values, so `DROPPED n` is information, not a failed run.
- **Don't run while a review session has the same eval file open.** `plan`, `assemble`, and `jev` refuse with `SESSION_LIVE` rather than race the server for the file, and the refusal names the session's URL. This is a refusal, not lost work: ask the user to click FINISH and run again.
- **No token or cost accounting exists for ambient runs.** Don't estimate or report either. There is no metered API call here to price.
- **Batch size is a tradeoff**, not a tuning knob to fiddle with. Bigger batches mean fewer subagents and less overhead, but a truncated or garbled response loses more tickets at once. 10 is the default for that reason.
- **`plan` and `jev` delete the previous run's working files.** The prompts, the batch files, and the round lists from an earlier run are removed once this run is going ahead, so a batch file is either this run's or not there at all. Never write a batch file yourself to patch up a run. Re-run `plan` instead. A new `jev` run deletes the saved Jev responses the same way, unless it is `--resume`. The files `/qval:review` keeps in the same directory are left alone.
- **Suggest gitignoring both `qval-output/` and `.qval-run/`** if the working directory is a repo. Both are generated. They differ in what may be *deleted*, not in what may be committed: `.qval-run/` is disposable between runs, while `qval-output/` holds the eval file and any human evaluation in it, so never suggest clearing that one.
- Requires Node (`node --version`). No npm install; the engine is dependency-free ESM.
