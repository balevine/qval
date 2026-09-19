# Qval

A local-first **Claude Code plugin** for evaluating customer-support tickets with an LLM, with humans, and then comparing the two. Qval is the companion to [Qbort](https://github.com/balevine/qbort). Qbort *generates* a `tickets.json`, Qval *scores* it.

It is two commands. `/qval:evaluate-tickets` runs the LLM evaluation inside Claude Code on whatever model your session is using. `/qval:review` opens a browser tab for the parts a person has to do by hand, which are writing the schema and the rules, filling in the human evaluation ticket by ticket, and reading the comparison. Both halves read and write the same `*.qval.json`, and two people's files of the same ticket set **merge** into per-ticket means, distributions, and a human-vs-LLM comparison.

Everything runs on your machine. There is no API key and no provider to configure. The review UI is served from `127.0.0.1` and the only network egress is Claude Code's own.

![The Qval review UI, showing the results table with the LLM-vs-human comparison](docs/screenshot.png)

**Highlights**

- **No API key.** The evaluation runs on the ambient Claude model through parallel subagents, with a dependency-free Node engine owning everything structural (schema validation, fingerprints, batching, per-value validation, atomic writes). Ticket content never enters the orchestrating agent's context.
- **Typed schema** (score / boolean / enum / text, each optionally multi-valued) and **free-form rules**, both snapshotted into every eval file and hashed into a fingerprint that merging gates on.
- LLM and human scores are pooled **separately** and compared per property. The gap between them is the output, not an afterthought.
- Nothing to install past the plugin itself. No build step, no `npm install`, no PATH management. Just Node.

---

## Install

In Claude Code:

```
/plugin marketplace add balevine/qval
/plugin install qval@qval
```

"Marketplace" is a misleading word for it. It means a git repo with a manifest in it, and there is no listing and no approval from anyone.

If you would rather read the source before running it, clone the repo and point Claude Code at the clone. The repo root is itself the marketplace, so it installs the same way a remote does.

```bash
git clone https://github.com/balevine/qval
```
```
/plugin marketplace add ./qval
/plugin install qval@qval
```

Requires **Node.js 20+** on your `PATH`. Nothing else.

Both skills set `disable-model-invocation: true`, so they cost nothing in your context window until you type them. The trade is that asking in prose ("evaluate these tickets") will not trigger them. Type `/qval:evaluate-tickets` or `/qval:review`.

---

## Usage

Put your ticket file in a directory and open Claude Code there. Qval reads and writes in the working directory and never modifies the ticket set.

The ticket file is whatever [Qbort](https://github.com/balevine/qbort) produces, so you can port your own data into that shape. Either `{ meta, tickets: [...] }` or a bare array, where each ticket is `{ id, subject, status, messages: [{ from, body, isStaff, createdAt }] }`. Only the integer `id` is required.

If you generated it with Qbort, there is nothing to move: Qbort writes `qbort-output/tickets-YYYYMMDD-HHMMSS.json` and Qval looks there too. It keeps every run, so once you have generated a few you will be asked which one you meant.

### 1. Score with Claude

```
/qval:evaluate-tickets
```

On the first run the skill scaffolds **`EVAL_RULES.md`** and **`EVAL_SCHEMA.json`** and stops, so you can say what you actually want measured. Describe it in a sentence or two and Claude drafts both files, then shows you the validated schema as a table and waits before running anything.

- **Rules** are a free-form block telling the evaluator *how* to score (prose, definitions, scoring philosophy, edge cases). They go into the prompt verbatim and sit next to the human form in the browser.
- **Schema** is the ordered list of typed properties every ticket is scored on. Each one has a `label`, a camelCase `key`, a `type` (**score**, **boolean**, **enum**, or **text**), an optional `multiple` flag for multi-valued answers, and a `description` shown to both the model and the human.

It then confirms the model to record, plans the run, fans the batches out to parallel subagents, assembles the results, and runs **one** retry round over anything that failed or came back off-schema. The result is a `*.qval.json` in your working directory, named after the ticket file it scored.

Validation is **per value, never per ticket**. Each value is coerced where that is unambiguous (a score clamped to range and snapped to step, an enum case-matched to a canonical option) or **dropped** where it isn't, leaving that one property unscored rather than discarding the ticket's other answers. Every coercion and drop is recorded in the result's `issues[]`, so nothing is silently faked.

Full skill docs: [`plugin/skills/evaluate-tickets/README.md`](plugin/skills/evaluate-tickets/README.md).

### 2. Review by hand

```
/qval:review
```

This starts a local server and opens a browser tab at it. Claude prints the URL whether or not the tab opened, which matters because some environments (Claude Code's own agent view among them) leave `$BROWSER` set to something that launches nothing. Open it yourself in that case. The URL carries a per-session token, so one from a previous run will not work.

The session runs **detached** and outlives the command that started it, because scoring a few hundred tickets by hand takes an hour and no Bash timeout survives that. Come back whenever and ask Claude how it went.

With no argument the CLI works out what to open, which is the single `*.qval.json` in the directory, or a single ticket file if you have not run an evaluation yet. A directory with several datasets and no eval file is refused with the list rather than guessed at. Re-opening an existing eval file is never ambiguous, however many datasets are lying around: it names its tickets by fingerprint, so the right ones are found without asking.

In the tab:

- **Settings (gear)** holds the schema and the rules, plus your evaluator name. These are the same `EVAL_SCHEMA.json` and `EVAL_RULES.md` the evaluation skill uses, seeded in when the session starts and written back when it ends, so both halves always score against the same criteria. **Preview compiled prompt** shows exactly what the model is sent.
- **Click any row** for the ticket's conversation and the human evaluation form. Fill in the same schema by hand. The LLM's values are shown for reference, clearly labeled, and they never pre-fill yours. Scoring is partial by design (any subset, in any order) and every change is written to the file as it happens. Use prev / next / next-unevaluated to sweep the queue.
- **MERGE** adds other people's eval files as read-only comparisons (below).
- **FINISH** ends the session. Ask Claude how it went and it will report the counts back.

> **Config lock.** Once an evaluation has any real score, its schema and rules **freeze**, so a file's data can never contradict the config it declares. Once it has an LLM score, its model is **pinned** too. Scoring under different criteria means a new eval file, which is exactly what merging gates on.

> **LLM values are never editable by hand.** To disagree with the model, fill in the human evaluation. The comparison is what shows the gap.

### 3. Merge and compare

**MERGE** offers the other `*.qval.json` files found next to your working file. To bring in one from somewhere else, name it when you start the review and Claude passes it along (`--compare ../alice/tickets.qval.json`). The browser is only ever shown the names, never the paths. A file is accepted only if it matches **both** the dataset and the schema and rules of your working file, otherwise it is refused on its own row with the specific reason.

All LLM evaluators pool into one group and all humans into another. They are never combined into a single number. Per ticket and per property you get each group's aggregate (score mean and standard deviation, boolean and enum majority and agreement, multi-select selection rates) and the **comparison** between them (score Δ, majority match, or set overlap), plus a dataset-level roll-up of how closely the model tracks human judgment. The results table has **Compare / LLM / Human** view modes, and any ticket opens to the full side-by-side.

**EXPORT REPORT**, which appears with the merged roster in the summary header, writes the flat per-ticket aggregates, the comparisons, and the dataset roll-up beside the working file (`tickets.qval.json` → `tickets.report.json`). Its destination is derived rather than chosen. Read-only, for analysis elsewhere, and not re-importable as a working file.

### 4. Housekeeping

Both commands keep their scratch in **`.qval-run/`** in the working directory: the compiled prompts and raw subagent output for an evaluation, and the session record, settings, and server log for a review. The eval file itself is deliberately kept out of it, because that is the durable artifact. Add `.qval-run/` to your `.gitignore` if you track the directory.

Nothing needs saving. Every change, human value or config edit, is written through as it happens.

---

## The eval file

A `*.qval.json` is a list of **evaluators**, each with a `kind` (`llm` or `human`), a display `name`, and an explicit `results[]` keyed by ticket id. A typical working file has one of each. Alongside them it carries a snapshot of `{schema, rules}` and two fingerprints:

- **`dataset.fingerprint`** is a SHA-256 over canonicalized ticket content. The file **references** its dataset rather than embedding it, so files stay small and the tickets stay canonical in Qbort's output.
- **`config.fingerprint`** is a SHA-256 over the normalized schema plus rules.

**Merging requires both to be equal.** Same tickets, same schema, same rules, or the merge is refused with the reason. Reformatting and re-exporting a ticket file does not change its fingerprint, because both hashes are over content rather than bytes.

A file the evaluation skill wrote and a file the browser wrote always merge, because both sides run the same code. That is checked by a test rather than assumed.

---

## Development

Requires **Node.js 20+** and **npm**.

```bash
git clone https://github.com/balevine/qval.git
cd qval
npm install
npm run build     # writes the single-file UI bundle to plugin/ui/index.html
```

The only thing in the repo that needs building is the UI. `vite` and `vite-plugin-singlefile` inline every byte of JS, CSS, and font into `plugin/ui/index.html`, which is **committed**, because that is what keeps the plugin installable with no build step. Everything else (the engine, the review server, the CLI, the logic under `plugin/lib/`) is dependency-free ESM that runs on bare `node`.

Scripts: `npm test` (unit + integration), `npm run typecheck`, `npm run check:ui` (rebuilds the bundle and fails if the committed copy has drifted), `npm run dev` (vite dev server for the UI, which has no API of its own, so point it at a running review server with `QVAL_DEV_SERVER=http://127.0.0.1:PORT`).

[`AGENTS.md`](AGENTS.md) is the orientation doc, and `.plans/PROJECT_SPEC.md` is the authoritative spec.

---

## The old desktop app

Qval used to be an unsigned Electron app distributed as a `.dmg`. That is over. The plugin is the whole product now, and it is a two-line install instead of a Gatekeeper argument.

The last desktop build stays on the [Releases](../../releases) page for anyone who needs to open a file it wrote. Eval files it produced (which record `provider: "ollama"` or `"anthropic"`) still open in the review UI, still accept a human evaluation, and still merge with new files of the same dataset and config. The one thing nothing here will do is *continue* their LLM run, because the file records the model that scored it and one model has to score every ticket in it.

---

## Contributing

Contributions are welcome, but please **open an Issue before opening a Pull Request.** Discuss the bug or feature in a GitHub Issue first so we can agree on the approach. **PRs without an associated Issue will be closed without review.**

Before submitting anything, make sure `npm run typecheck`, `npm test`, and `npm run check:ui` pass.

---

## License

[MIT](LICENSE)
