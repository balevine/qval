# review (Claude Code skill)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) skill that opens [Qval](../../../README.md)'s review UI in your browser. It is the half of Qval a person has to do by hand: writing the schema and the rules, filling in the **human evaluation** ticket by ticket, merging other people's eval files, and reading the human-vs-LLM comparison.

The LLM half is the sibling skill [`evaluate-tickets`](../evaluate-tickets/README.md). This one runs no model and scores nothing on its own.

## Requirements

- **Claude Code** (the skill runs inside it, and `bin/qval` lands on its PATH while the plugin is enabled).
- **Node.js** on your `PATH` (`node --version`). No `npm install`: the CLI, the server, and the UI bundle are all dependency-free and ship with the plugin.
- A **ticket file** in the directory you run it from, or an existing **`*.qval.json`** in its `qval-output/`. Ticket files are found by shape rather than by name, so your own export works as well as a generated set, and a `qbort-output/` subdirectory is searched too. You can also just name the file: `qval serve <path>`.

## Usage

1. `cd` into the directory holding your tickets or eval file.
2. Type **`/qval:review`**. It is deliberately not model-invocable, so asking in prose will not trigger it.
3. Claude starts the server and gives you a URL. A browser usually opens by itself; when it can't, the URL is printed for you to open.
4. Score tickets, merge files, and click **Finish** when you're done.
5. Ask Claude how it went. It runs `qval status` and reports the counts back.

The session is **detached**: the command that starts it returns immediately, and the server keeps running while you work. Scoring a few hundred tickets takes an hour, and no Bash timeout survives that.

## What the browser can and can't do

Everything is written to the eval file as you make it, so there is no Save. There is also no Open, no folder picker, and no Save-As, and that's deliberate rather than missing.

**No endpoint accepts a path.** The CLI resolves the tickets file, the eval file, and the files on offer to merge before the browser exists; the page names them by id. A local page that can name any path on your disk is a shell, not a feature, so the surface simply isn't there. The rest is ordinary hygiene: bound to `127.0.0.1`, a per-session token on every request, the `Host` header pinned to the loopback literals (that's the DNS-rebinding defense), `Sec-Fetch-Site: same-origin` on every mutation, no CORS headers at all, and a CSP that names the hash of the bundle's own inline script.

## Merging

`serve` offers every other `*.qval.json` next to your working file, plus anything you pass to `--compare`. Merging pools that file's evaluators into the comparison; it never modifies either file.

Two files merge only when **both** fingerprints match: the same tickets *and* the same schema *and* the same rules. Anything else is refused with the reason, which is the point. Pooling scores given under different criteria would quietly produce a meaningless average.

## Shared config

`serve` seeds a new session's schema and rules from `EVAL_SCHEMA.json` and `EVAL_RULES.md` when they're there, and writes back whatever you ended up using when the session ends, but only if you changed it. So the two skills always score against the same config, whichever one you set it up in, and opening an old eval file just to read it never rewrites the config in your working directory.

## Files

```
SKILL.md          instructions Claude follows (not human docs)
../../bin/qval    CLI: serve | status
../../server/     the local review server (dependency-free node)
../../ui/         the built single-file UI bundle
../../lib/        the logic, shared with the engine and the UI
```

Gitignore both. `.qval-run/` is scratch (the session record and your settings) and is safe to delete between runs. `qval-output/` holds your eval files and exported reports. It's where `serve` looks for what to open and what to offer for merging, and it's the one thing here you can't regenerate, so ignore it in git but don't clear it.
