---
name: draft
description: Draft the Qval scoring config (EVAL_SCHEMA.json and EVAL_RULES.md) from the user's RULES.md or a description, for the Claude or Jev scorer. Run before /qval:review or /qval:evaluate-tickets.
disable-model-invocation: true
---

# draft

Writes the two config files every Qval evaluation scores against, `EVAL_SCHEMA.json` (the typed properties and the scorer) and `EVAL_RULES.md` (free-text scoring guidance), into the user's working directory. Nothing else in Qval creates them. `/qval:review` refuses to start a new evaluation without them (`NO_CONFIG`), and `/qval:evaluate-tickets` stops and sends the user here.

This is the only place the scorer is chosen. `claude` is the ambient model through subagents. `jev` is Typesafe's Jev classifier, which needs a Typesafe API key at run time.

Let `ENGINE` be `${CLAUDE_PLUGIN_ROOT}/skills/evaluate-tickets/engine.mjs`. This skill has no engine of its own. Drafting is checked by the same code that checks a config before a run, so it calls that one. Run every `node "$ENGINE" ...` command from the user's working directory.

**How to read the engine.** Each command's first stdout/stderr token plus its exit code is the contract. Exit codes: **0** ok, **1** a bad or missing flag (fix the command), **2** unusable state (fix the files or ask the user; never retry the same command verbatim), **3** `init` wrote the starter config.

## Step 1. Pick the path

Look for `RULES.md`, `EVAL_SCHEMA.json`, and `EVAL_RULES.md` in the working directory.

- **`RULES.md` exists**: go to Step 2. `RULES.md` is the user's own plain-language rules, and nothing here ever modifies it.
- **No `RULES.md`**: ask what they want to measure if they haven't said, then go to Step 3. If they would rather write their rules down first, ask them to write a `RULES.md` and go to Step 2 once it exists. Write `RULES.md` yourself only if they ask you to, from their words.
- **They just want something to edit in the browser**: go to Step 4.

If both `EVAL_*` files already exist, say so before replacing them. They may be hand-written, and the user may only want to run what is there.

## Step 2. Draft from RULES.md

1. **Ask which scorer** with `AskUserQuestion`: `claude` (the ambient model through subagents) or `jev` (Typesafe's Jev classifier, which needs a Typesafe API key).
2. **Read `DRAFTING.md`** (next to this file), then `RULES.md`, and write the draft to `.qval-run/draft.json` in the shape DRAFTING.md defines. Read only the core section for `claude`.
3. Run `node "$ENGINE" draft-check --scorer <scorer>`. On exit 2, fix every listed problem in the draft and check again, **at most two fix rounds**. If problems remain, show them to the user and stop.
4. On `DRAFT_OK`, **show the user** the property table, the notes, the warnings, what was removed from the rules (`REMOVED_FROM_RULES`), and any `OTHER_CRITERIA` eval files. Get **explicit approval** before writing anything. If they want changes, the change goes into `RULES.md` and you redraft from `RULES.md`, never from `EVAL_RULES.md`, which no longer holds the questions.
5. Run `node "$ENGINE" draft-apply`. It re-checks the draft and writes `EVAL_SCHEMA.json` and `EVAL_RULES.md`, replacing any that exist. `SESSION_LIVE` (exit 2) means a review session is open here and would write its own config back over these files when it ends. Ask the user to click FINISH in that tab, then re-run.
6. Go to Step 5. If `OTHER_CRITERIA` listed eval files that already hold scores, the new config is scored into a new eval file, so a later run needs a new `--eval-file`.

## Step 3. Draft from a description

Write both files yourself from what the user said. This is drafting work, not a per-property interview. Do not ask 6 questions per property. This path writes a `claude` config. A `jev` config needs the extra fields only Step 2 writes, so a user who wants Jev writes a `RULES.md` first.

`EVAL_RULES.md` is free text, injected verbatim into the prompt: context about the dataset, definitions, a rubric, edge cases. `EVAL_SCHEMA.json` is `{ "scorer": "claude", "properties": [...] }`. Each property has these fields.

- `key`: required, camelCase, unique, stable (it is what gets stored and hashed).
- `label`: required, human-readable.
- `type`: required, one of `score`, `boolean`, `enum`, `text`.
- `description`: optional, but worth writing (the model reads it).
- `multiple`: optional `true`. Allowed on `score` and `enum` only, never `boolean` or `text`.
- `min`/`max`/`step`: `score` only. Needs `min < max` and `step > 0`.
- `options`: `enum` only. Two or more unique non-empty strings.

Keep the schema small (2 to 6 properties). Every property is judged for every ticket, and a human will later fill the same form by hand in the review UI.

Then check it:

```
node "$ENGINE" config
```

- **Exit 0**: prints the property table, `CONFIG OK`, and `FINGERPRINT <hash>`. **Show the user the table** and confirm it is what they meant.
- **Exit 2**: `SCHEMA_INVALID` (with a per-row `ERRORS` block), `BAD_JSON`, `BAD_SCHEMA`, `BAD_SCORER`, `SCHEMA_EMPTY`, `MISSING_RULES`, `MISSING_SCHEMA`. Fix the file and re-check.

Optional: `config --write` rewrites `EVAL_SCHEMA.json` in normalized form (cosmetic only. It runs the check first and refuses on failure). `config --preview` prints the exact static prefix the model will read, worth showing if the user is unsure how their rules will land.

Then go to Step 5.

## Step 4. Write the starter config

Only when the user asks for a starting point to edit rather than a drafted one:

```
node "$ENGINE" init
```

It writes whichever of the two files is missing from Qval's built-in starter config and never overwrites one that exists. **Exit 3** means it created at least one. `READY` (exit 0) means both were already there. The starter is a `claude` config, and its schema and rules are editable under **Settings** in `/qval:review` until the first score is saved.

## Step 5. Hand off

Tell the user the config is in place and name the next step. They can run these in either order.

- **`/qval:review`** opens the tickets in a browser to score by hand, and to adjust the schema and rules under **Settings** before anything is scored.
- **`/qval:evaluate-tickets`** scores every ticket with the chosen scorer.

Offer them. Don't run either unless the user asks.

## Notes / invariants

- **Never write `EVAL_SCHEMA.json` or `EVAL_RULES.md` by hand on the `RULES.md` path.** `draft-apply` writes them, after the user approved what `draft-check` showed.
- **Redrafting replaces the config, not the evaluations.** An eval file with no scores adopts the new config the next time `/qval:review` or `/qval:evaluate-tickets` opens it. One that has scores keeps its old criteria, and scoring under the new ones needs a new eval file.
- **`.qval-run/draft.json`** is scratch, and starting an evaluation run leaves it alone.
- Requires Node (`node --version`). No npm install. The engine is dependency-free ESM.
