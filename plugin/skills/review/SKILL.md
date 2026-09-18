---
name: review
description: Open the Qval review UI in a browser — set up the schema and rules, score tickets by hand, and compare your scores with the model's.
disable-model-invocation: true
---

# review

Opens the half of Qval a person has to do themselves: writing the schema and the rules, filling in the **human evaluation** ticket by ticket, and reading the human-vs-LLM comparison. It runs in an ordinary browser tab, served by a local server bound to `127.0.0.1`.

The LLM half is a different skill (`/qval:evaluate-tickets`). This one runs no model and scores nothing.

The CLI lives at `${CLAUDE_PLUGIN_ROOT}/bin/qval`. Let `QVAL` be that absolute path. Run every command from the user's working directory.

**The session outlives the command.** `qval serve` starts the server detached and returns immediately, because scoring a few hundred tickets by hand takes an hour and no Bash timeout survives that. Never wait on it, never poll it in a loop, and never start a second one — `qval status` is how the answer comes back, whenever the user says they are done.

## Step 1. Start the review server

```
"$QVAL" serve
```

With no argument it works out what to open: a single `*.qval.json` in the directory, or a single `tickets.json` (Qbort's shape) if there is no eval file yet. Pass the file explicitly when the user named one, as `"$QVAL" serve <path>`.

Read the first token of stdout:

- **`SERVING`** — followed by `URL`, `WORKING_FILE`, `DATASET`, `CANDIDATES` (how many other eval files it found to merge), and `OPENED yes|no`. Go to Step 2.
- **`ALREADY_SERVING`** — a session is already live here. Give the user that `URL` again. Do not start another.
- **Exit 2**: `NO_DATASET` (nothing here to review), `AMBIGUOUS` (it lists the candidates — **ask the user which one with `AskUserQuestion`**, then re-run with that path), `MISSING_FILE`, `BAD_TICKETS`, `SERVER_FAILED`, `SERVER_TIMEOUT`.
- **Exit 1**: a bad flag. Fix the command.

Optional flags: `--compare a.qval.json,b.qval.json` (offer files from elsewhere for merging, on top of the ones found next to the working file), `--port N`, `--no-open`, `--out <dir>` (default `.qval-run`).

## Step 2. Hand the URL to the user

**Always print the `URL` line to the user, whatever `OPENED` says.** It is the only way into the session, and it carries a per-session token, so a URL from a previous run will not work.

- `OPENED yes` — a browser was launched. Tell them it should be open, and give the URL anyway in case it opened somewhere they cannot see.
- `OPENED no` — nothing was launched (that is what happens when `$BROWSER` is set to a sentinel, which Claude Code's own agent view does). Tell them to open the URL themselves.

Then say what they can do there: edit the schema and rules under **Settings**, click a ticket to score it by hand, **Merge** other people's eval files for a side-by-side comparison, and **Finish** when they are done.

Every edit is written to the eval file as it happens. There is nothing to save.

## Step 3. Stop, and report back when asked

Say the session is open and **stop**. Do not tail the log, do not poll `status`, and do not spawn anything to watch it. The user will come back.

When they say they are finished (or ask what happened):

```
"$QVAL" status
```

- **`REVIEW live`** — still open. Print the `URL` again if they lost it.
- **`REVIEW done`** — they clicked Finish. Report the counts on the `LLM` and `HUMAN` lines.
- **`REVIEW abandoned`** — the tab was closed without clicking Finish, or it was never opened. The work is still saved; only the ending is unrecorded. Say so plainly rather than treating it as a failure.
- **`REVIEW stale`** — the server process died without recording an outcome. The eval file is intact; offer to start a new session.
- **`REVIEW none`** — no session has run in this directory.

`status` also prints `FILE`, the LLM and human scored counts, and `UPDATED`, whether or not a session ever ran. It is the cheap way to answer "how far along is this?" at any time.

## Notes / invariants

- **The server never sees a path.** Both files are resolved here, before the browser exists, and no endpoint accepts one. That is what removes the path-traversal problem instead of defending against it. Merging works the same way: `serve` resolves the mergeable files and the browser picks one by name.
- **Merging refuses on mismatched fingerprints**, and it should. Two eval files pool into one comparison only when they are of the same tickets *and* the same schema *and* the same rules. The refusal shows up in the merge panel with the reason.
- **The config files are shared with `/qval:evaluate-tickets`.** `serve` seeds a new session's schema and rules from `EVAL_SCHEMA.json` / `EVAL_RULES.md` when they exist, and writes back whatever the person ended up using when the session ends. So a schema built in the browser is the one a follow-up LLM run scores against.
- **Don't run an evaluation against the same eval file while a review session is live.** The engine's stale-file guard will refuse rather than overwrite a human evaluation made mid-run, which means a refused run, not lost work. Ask the user to click Finish first.
- **LLM values are never editable by hand**, in the browser or anywhere else. Disagreeing with the model is what the human evaluation is for, and the comparison is what shows the gap.
- `.qval-run/` is scratch: the session record, the settings, and the server log. Suggest adding it to `.gitignore` if the user doesn't want it tracked.
- Requires Node (`node --version`). No npm install; the CLI, the server, and the UI bundle are dependency-free and ship with the plugin.
