# draft (Claude Code skill)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that writes [Qval](../../../README.md)'s scoring config, `EVAL_SCHEMA.json` (the scorer and the typed properties every ticket is scored on) and `EVAL_RULES.md` (free-text scoring guidance), into your working directory. It is the first step. Nothing else in Qval creates those two files.

The two sibling skills both read them, and run in either order once they exist: [`evaluate-tickets`](../evaluate-tickets/README.md) scores every ticket with the scorer you chose, and [`review`](../review/README.md) opens the tickets in a browser for you to score by hand.

## Requirements

- **Claude Code** (the skill runs inside it).
- **Node.js** on your `PATH` (`node --version`). No `npm install`.
- Optionally, your scoring rules written in plain language in a **`RULES.md`** in the working directory.

## Usage

1. `cd` into the directory holding your ticket file.
2. Type **`/qval:draft`**. It is deliberately not model-invocable, so asking in prose will not trigger it.
3. Pick a path.
   - **From `RULES.md`.** Claude asks which scorer you want (`claude` or `jev`), drafts both files from your rules for that scorer, and checks the draft with `engine.mjs draft-check`. You see the properties as a table with Claude's notes on each, warnings about anything the draft cannot enforce, and what was taken out of your rules. Nothing is written until you approve, and then `engine.mjs draft-apply` writes the two files.
   - **From a description.** Say what you want measured and Claude writes a `claude` config, checks it with `engine.mjs config`, and shows it back as a table.
   - **The starter config.** `engine.mjs init` writes Qval's built-in schema and rules, for when you would rather edit something in the browser.
4. Run **`/qval:evaluate-tickets`** or **`/qval:review`**, in whichever order you like.

`RULES.md` is never modified, and every redraft starts from it. To change what is measured, change `RULES.md` and draft again. Redrafting while a review session is open is refused, because that session writes its own config back when it ends. Click **Finish** there first.

An eval file with no scores yet takes on the new config the next time either skill opens it. One with scores keeps the criteria it was scored under, and the new config is scored into a new eval file.

## Files

```
SKILL.md                                 instructions Claude follows (not human docs)
DRAFTING.md                              how Claude turns RULES.md into a draft, read only when drafting
../evaluate-tickets/engine.mjs           init | config | draft-check | draft-apply (the same engine the
                                         evaluation runs on, so a draft that passes is a config that runs)
```

The draft waiting for your approval is kept in `.qval-run/draft.json`, which is scratch.
