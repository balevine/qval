# Qval

A local-first desktop app for **evaluating** customer support tickets with an LLM, with humans, and then comparing the two. Qval is the companion to [Qbort](https://github.com/balevine/qbort). Qbort *generates* a `tickets.json`; Qval *scores* it. You import a ticket set, write free-text **rules** describing how to score, define a typed **schema** of output properties, run an **LLM evaluation**, optionally add your own **human evaluation** by hand, and save both into a single `*.qval.json` file.

Multiple people's eval files of the same dataset can be **merged** to produce per-ticket means, distributions, and a **human-vs-LLM comparison** showing how closely the model tracks human judgment. Everything runs on your machine; the only network egress is the LLM call itself.

**Highlights**

- Two providers: **Ollama** (local, default) and **Anthropic**.
- API keys are stored in your **OS keychain** (via Electron `safeStorage`), never in plaintext and never exposed to the UI.
- Typed schema (score / boolean / enum / text, each optionally multi-valued) and free-form rules, both snapshotted into every eval file.
- LLM and human scores are pooled **separately** and compared per property; low agreement and large human-LLM gaps are flagged.

---

## Installation

### Option A - download the released binary (macOS)

1. Go to the [**Releases**](../../releases) page and download the latest `.dmg`.
2. Open the `.dmg` and drag **Qval** into your **Applications** folder.
3. **First launch (unsigned app):** the app is currently **unsigned**, so macOS blocks it the first time you open it ("Apple cannot check it for malicious software"). The exact steps depend on your macOS version. On **macOS 14 and earlier**, right-click (or Control-click) the app → **Open**, then click **Open** in the confirmation dialog. On **macOS 15 (Sequoia) and later**, double-click the app once (it will be blocked), then open **System Settings → Privacy & Security**, find the "Qval was blocked" message near the bottom, and click **Open Anyway**. You only need to do this once. Either way, this Terminal command clears the quarantine flag and skips the dialogs entirely:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Qval.app"
   ```

### Option B - build and run from source

Requires **Node.js 20+** and **npm**.

```bash
git clone https://github.com/balevine/qval.git
cd qval
npm install

# Run the app in development (hot reload):
npm run dev

# or... build a distributable (.dmg + .zip land in release/):
npm run dist:mac
```

Handy scripts: `npm test` (unit + integration suite), `npm run typecheck`.

---

## Usage

The app is a single screen: a results table in the middle, and a top bar with **OPEN**, **EVALUATE**, **MERGE**, **EXPORT**, and settings (gear icon). All configuration lives behind the gear.

### 1. Load a ticket set

Click **OPEN** and choose a file:

- A Qbort **`tickets.json`** starts a fresh working evaluation.
- An existing **`*.qval.json`** re-opens that evaluation (it references its dataset by fingerprint, so you'll be prompted for the matching `tickets.json` if it isn't already loaded).

Qval never modifies the tickets themselves. On launch it also auto-reloads your most recent working file.

### 2. Configure a provider

Open **Settings → Provider**. The default is **Ollama**, so the app works out of the box with no API key.

- **Ollama (local):** make sure your Ollama server is running (default `http://localhost:11434`), click **Fetch models**, and pick an installed model. Local evaluation is free and never leaves your machine.
- **Anthropic:** select Anthropic, paste your API key, and click **Save** (it's encrypted into your OS keychain; the app only shows whether a key is *set*). Use **Test connection** to verify, then **Fetch models** and choose one. Unlike Qbort, **you pick the model**.

### 3. Define rules and schema

Under the gear:

- **Rules** - a free-form text block telling the evaluator *how* to score (prose, definitions, scoring philosophy, edge cases). Injected verbatim into the LLM prompt and shown next to the human form. **Preview compiled prompt** shows exactly what gets sent to the model.
- **Schema** - the ordered, typed properties every ticket is scored on. Each property has a `label`, a `key`, a `type` (**score**, **boolean**, **enum**, or **text**), an optional **Allow multiple** toggle (multi-select, for enum/score), and a `description` shown to both the human and the LLM. Ships with a small default schema so you can start immediately.

> **Config lock:** once an evaluation has any real score, its schema, rules, and (after an LLM run) provider/model **freeze** so a file's data can never contradict the config it declares. To score under different criteria or a different model, **OPEN** its `tickets.json` again to start a fresh evaluation.

### 4. Run an LLM evaluation

Click **EVALUATE**. You'll see a **token/cost estimate** first (Ollama shows `$0 · local`); nothing runs until you confirm. Choose to score **All tickets** or only the ones that **need attention** (unevaluated, errored, or with an unresolved dropped value). Progress streams live and you can **Cancel** at any time with existing results saved. Each value is validated against the schema and auto-repaired where unambiguous; anything the model can't produce is left unscored and not silently faked.

### 5. Record a human evaluation

Click any row to open the ticket's **conversation + evaluation** modal. Fill in the same schema by hand in the form on the right; the LLM's values are shown for reference (clearly labeled, they never pre-fill yours, and LLM scores aren't hand-editable). Scoring is **partial by design** (do any subset, in any order) and every change **autosaves** to the working file. Use **prev / next / next-unevaluated** to sweep the queue. The header tracks LLM- and human-eval completeness.

### 6. Merge and compare evaluations

Click **MERGE** to add one or more other people's `*.qval.json` files as read-only comparisons. A file is accepted only if it matches **both** the dataset and the schema/rules of your working file (otherwise it's rejected with a specific reason). All LLM evaluators are pooled into one group and all humans into another and Qval computes, per ticket and per property:

- each group's aggregate (score mean and standard deviation, boolean and enum majority and agreement, multi-select selection rates), and
- the **comparison** between them (score Δ, majority match, or set overlap), plus a dataset-level roll-up of how closely the model tracks human judgment.

The results table has **Compare / LLM / Human** view modes Open any ticket for the full side-by-side wtih each evaluator's values, both group aggregates, and their difference.

### 7. Export and share

- **EXPORT** writes your working `*.qval.json` (choose a location the first time). Hand it to a teammate and they can **MERGE** it into their own evaluation of the same dataset.
- When files are merged, **Export report** (in the summary header) writes a flat aggregate JSON per ticket, the LLM and human aggregates and the comparison between them, plus the dataset-level roll-up for further analysis.

---

## Contributing

Contributions are welcome, but please **open an Issue before opening a Pull Request.** Discuss the bug or feature in a GitHub Issue first so we can agree on the approach. **PRs without an associated Issue will be closed without review.**

To work on the project locally, see [Build and run from source](#option-b--build-and-run-from-source). Before submitting any contributions, please make sure `npm run typecheck` and `npm test` pass.

---

## License

[MIT](LICENSE)
