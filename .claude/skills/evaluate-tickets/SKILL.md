---
name: evaluate-tickets
description: Evaluate/score a set of customer-support tickets (a Qbort tickets.json) against user-written rules and a typed schema, producing a Qval eval file (*.qval.json). Fans the judging out to parallel subagents using the ambient Claude model (no API key); a deterministic engine owns config validation, fingerprints, batching, prompt compilation, per-value validation and repair, and the eval-file writes. Use when the user wants to evaluate tickets, score a ticket set, grade support conversations, or produce a qval file from the CLI.
---

# evaluate-tickets

Scores a Qbort `tickets.json` and writes a Qval eval file (`*.qval.json`). The **ambient Claude
model** (via subagents) supplies the *judgment*. A deterministic Node engine (`engine.mjs`) owns
everything structural: config validation, both fingerprints, target selection, batching, prompt
compilation, per-value validation and repair, retry accounting, and the atomic eval-file writes.
Never hand those structural jobs to the model.

The engine lives next to this file. Let `ENGINE = .claude/skills/evaluate-tickets/engine.mjs`
(adjust if the skill is installed elsewhere, e.g. `~/.claude/skills/evaluate-tickets/engine.mjs`).
Run all `node "$ENGINE" ...` commands from the user's working directory. Scratch state goes to
`.qval-run/` (the engine's `--out` default). The eval file itself is written **outside** it, in the
working directory, because that is the durable artifact the user opens in the app.

**How to read the engine.** Each command's first stdout/stderr token plus its exit code is the
contract. Branch on those, not on the prose around them. Exit codes: **0** ok, **1** a bad or
missing flag (fix the command), **2** unusable state (fix the files or ask the user; never retry the
same command verbatim), **3** `init` scaffolded config files (stop and let the user edit them).

## Step 1. Locate the tickets file

Find the dataset to evaluate (`ls *.json`, or a path the user gave). It is a Qbort `tickets.json`:
either `{ meta, tickets: [...] }` or a bare array of tickets.

If more than one candidate exists and the user didn't name one, **ask with `AskUserQuestion`**.
Evaluating the wrong dataset produces a file that will never merge with anyone else's.

## Step 2. Ensure the config files exist

The run needs `EVAL_RULES.md` (free-text scoring guidance) and `EVAL_SCHEMA.json` (the typed output
properties) in the working directory.

```
node "$ENGINE" init
```

- **Exit 3**: it created one or both from the starter templates. **Stop here.** Go to Step 3 and
  work with the user on the contents. Do not plan a run against a placeholder config.
- **Exit 0** (`READY`): both files already exist. Go to Step 3 if the user wants to change what is
  measured; otherwise skip to Step 4.

## Step 3. Draft the rules and schema with the user

Ask what they want to measure if they haven't said, then **write both files yourself** from their
description. This is drafting work, not a per-property interview. Do not ask 6 questions per
property.

`EVAL_RULES.md` is free text, injected verbatim into the prompt: context about the dataset,
definitions, a rubric, edge cases. `EVAL_SCHEMA.json` is a JSON **array** of properties:

| field | notes |
| --- | --- |
| `key` | required, camelCase, unique, stable (it is what gets stored and hashed) |
| `label` | required, human-readable |
| `type` | required, one of `score` \| `boolean` \| `enum` \| `text` |
| `description` | optional, but worth writing (the model reads it) |
| `multiple` | optional `true`; allowed on `score` and `enum` only, never `boolean`/`text` |
| `min`/`max`/`step` | `score` only; needs `min < max` and `step > 0` |
| `options` | `enum` only; 2 or more unique non-empty strings |

Keep the schema small (2 to 6 properties). Every property is judged for every ticket, and a human
will later fill the same form by hand in the app.

Then check it:

```
node "$ENGINE" config --check
```

- **Exit 0**: prints the property table, `CONFIG OK`, and `FINGERPRINT <hash>`. **Show the user the
  table** and confirm it is what they meant before running anything.
- **Exit 2**: `SCHEMA_INVALID` (with a per-row `ERRORS` block), `BAD_JSON`, `BAD_SCHEMA`,
  `SCHEMA_EMPTY`, `MISSING_RULES`, `MISSING_SCHEMA`. Fix the file and re-check. Do not plan a run
  against a schema that failed.

Optional: `config --write` rewrites `EVAL_SCHEMA.json` in normalized form (cosmetic only; it runs
the check first and refuses on failure). `config --preview` prints the exact static prefix the model
will read, worth showing if the user is unsure how their rules will land.

## Step 4. Resolve the model to record

The evaluator stamped into the file records the model that actually did the scoring, and **one model
scores every ticket in a file**. Resolve a value, in this order:

1. A model the user named explicitly.
2. `$ANTHROPIC_MODEL`, if it is set (`echo "$ANTHROPIC_MODEL"`).
3. **Your own model name**, valid only because subagents inherit the session model (see Step 6).

If none of those yields a value you are confident in, **stop and ask the user with
`AskUserQuestion`** and wait for the answer. There is no placeholder and no default: an unlabeled
run would let two different models score one file with nobody noticing, which is exactly what the
per-file model pin exists to prevent.

State the resolved value to the user before running. It is stamped permanently into the eval file.

## Step 5. Plan the run

```
node "$ENGINE" plan --tickets <tickets.json> --model "<resolved model>"
```

Optional flags: `--eval-file <path>` (default: `<tickets stem>.qval.json` in the working directory),
`--mode all|remaining|selection` with `--ids 1,2,3` for `selection` (default `all`), `--batch-size N`
(default 10), `--rules`/`--schema` for non-default config paths, `--out <dir>` (default `.qval-run`).

**Only ask about mode when the eval file already exists** (`ls *.qval.json`, or run
`node "$ENGINE" status --eval-file <path>`). Use `AskUserQuestion`: re-score **all** tickets, or only
the **remaining** ones (unevaluated, errored, or with a dropped value). For a fresh file, just run
`all`.

Read the output:

- **`PLANNED`**: followed by `EVAL_FILE`, `OUT`, and a **`ROUND 0`** block with one
  `BATCH <i> (<n> tickets) PROMPT=<abs path> BATCH=<abs path>` line per batch. Go to Step 6.
- **`NOTHING_TO_DO`** (exit 0): nothing needs evaluation. Report that and skip to Step 8.
- **Exit 1**: `MISSING_MODEL`, `MISSING_TICKETS`, `BAD_MODE`, `MISSING_IDS`, `BAD_IDS`,
  `BAD_BATCH_SIZE`. Your command was wrong; fix it.
- **Exit 2**: the state is wrong, and `plan` wrote nothing.
  - `DATASET_MISMATCH`: that eval file is of different tickets. Use a different `--eval-file` or a
    different dataset.
  - `CONFIG_MISMATCH`: the rules or schema changed since that file was scored. Scoring under new
    criteria needs a **new** eval file (`--eval-file <new path>`). Do not "fix" this by editing the
    existing file.
  - `MODEL_LOCKED` / `PROVIDER_LOCKED`: the file was already scored by a different model or in the
    app. Re-run with that model, continue in the app, or start a new eval file. Tell the user which.
  - `BAD_TICKETS`, `BAD_JSON`, `BAD_EVAL_FILE`, `UNKNOWN_IDS`, `MISSING_TICKETS <path>`.

## Step 6. Fan out one subagent per batch

Spawn **every batch of the round as a subagent in a single message** so they run in parallel. Use
the `Agent` tool with `subagent_type: general-purpose`, and take the `PROMPT=` and `BATCH=` paths
**verbatim from the `ROUND` block the engine just printed**. Never construct or guess them.

> **Never pass a model override when spawning these subagents.** They must inherit the session
> model, because that is the only reason the model recorded in Step 4 is true. A single overridden
> subagent makes the file's recorded model a lie, silently and permanently.

Give each subagent exactly this task, substituting its own PROMPT and BATCH paths:

> Read the file `<PROMPT path>`. It contains complete instructions, the tickets to evaluate, and the
> exact JSON output shape to produce. Follow it precisely and evaluate every ticket in it. Write ONLY
> the resulting JSON object (no markdown fences, no commentary) to `<BATCH path>`, overwriting it.
> Then reply with just `done`. Do not read or write any other files.

Do not read the prompt or batch files yourself. The engine reads them in Node, so ticket content and
scored values never enter your context. That is what keeps large runs cheap.

If a subagent fails or writes nothing, carry on to Step 7 anyway. The engine treats a missing or
garbled batch file as zero results, and those tickets become errors the retry round picks up.

## Step 7. Assemble, then at most one retry round

```
node "$ENGINE" assemble --round 0
```

It prints `ASSEMBLED`, then `EVALUATED`, `DROPPED`, `FAILED`, **`NEEDS_RETRY`**, and `FILE`.

- **`NEEDS_RETRY 0`**: done. Go to Step 8.
- **`NEEDS_RETRY > 0`**: run exactly one retry round.

  ```
  node "$ENGINE" retry --round 1     # prints a ROUND 1 block over only the failed/dropped tickets
  # then spawn that round's subagents in a single message (Step 6)
  node "$ENGINE" assemble --round 1
  ```

  Round 1 always prints `NEEDS_RETRY 0`, since the retry is capped at one round to match the app.
  Anything still unresolved is printed on a **`RESIDUAL n`** line instead. **Do not loop.** Report
  the residual; a genuinely unscoreable ticket stays in the file as an error, and the user can
  re-plan with `--mode remaining` later if they want.

Failures here: `STALE_FILE` (exit 2) means the eval file changed on disk since `plan` (the app
probably has it open). Tell the user to close it there, then re-run `plan`. `NOT_ASSEMBLED` means
round 0 hasn't been assembled yet. `RETRY_CAPPED` means you passed a round other than 1.

## Step 8. Report and hand off

```
node "$ENGINE" status
```

Tell the user the eval file path and the counts (scored / total, errors, dropped values), then hand
off to the **Qval desktop app**: open the `*.qval.json` there to browse the LLM results per ticket,
fill in the **human evaluation** by hand, and use the merge/comparison surfaces. Mention that
pressing EVALUATE in the app on this file is blocked on purpose; continuing the LLM run means coming
back to this skill.

Do not print the whole eval file. Offer to summarize a few tickets if they want a spot check.

## Notes / invariants

- **Never hand-write or hand-edit the `.qval.json`.** Every write goes through the engine, which is
  what keeps ids, fingerprints, `updatedAt`, and the evaluator record consistent. A hand-edit can
  silently break merging with other people's files.
- **Ticket ids come from the dataset, never from the model.** The engine looks the model's output up
  by id and records an error for anything it skipped. Don't post-edit ids or values to "fix" a run.
- **Values are validated per property, never per ticket.** An out-of-range or off-schema value is
  coerced when unambiguous and dropped when not, with a non-silent `issues[]` trail. One bad field
  never discards a ticket's other values, so `DROPPED n` is information, not a failed run.
- **Don't run while the app has the same eval file open and is editing it.** The stale-file guard
  will refuse rather than overwrite a human evaluation made mid-run.
- **No token or cost accounting exists for ambient runs.** Don't estimate or report either. The app's
  numbers come from a metered API call this path doesn't make.
- **Batch size is a tradeoff**, not a tuning knob to fiddle with. Bigger batches mean fewer subagents
  and less overhead, but a truncated or garbled response loses more tickets at once. The default of
  10 matches the app.
- `.qval-run/` is scratch. Suggest adding it to `.gitignore` if the user doesn't want it tracked.
- Requires Node (`node --version`). No npm install; the engine is dependency-free ESM.
