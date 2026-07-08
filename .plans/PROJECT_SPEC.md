# Qval — Project Spec

A local-first Electron desktop app for **evaluating** customer-support tickets with an LLM and with humans, then **aggregating** many evaluators' scores. Qval is the companion to **Qbort**: Qbort *generates* a `tickets.json`; Qval *scores* it. The user imports a ticket set, writes free-text **rules** describing how to score, defines a typed **schema** of output properties, runs an **LLM evaluation**, optionally does a **human evaluation** by hand, and saves both into a single eval file. Multiple users' eval files of the same dataset can be **merged** to produce per-ticket **means and standard deviations** (LLMs disagree even on the same model; humans disagree too).

> Prior art: Qval re-uses Qbort's whole architecture wholesale — `electron-vite` + React + TS + Tailwind, the strict `main` / `preload` / `shared` / `renderer` process split, `fetch`-only providers (no vendor SDKs), `safeStorage` keychain, zod validation, an allow-listed typed IPC surface, atomic JSON writes, and the monochrome neo-brutalist design system. Where a decision matches Qbort, we note it with "as in Qbort" for context, but every detail Qval depends on is restated here so this repo stands entirely on its own — no need to consult the Qbort directory.

---

## 1. Goals & non-goals

### Goals
- Desktop app (macOS first; Windows/Linux capable via Electron) that **evaluates** a ticket set.
- Import a Qbort **`tickets.json`** as the dataset under evaluation.
- User-authored **rules** (free-text scoring guidance) + a user-defined **schema** of typed output properties.
- **LLM-backed evaluation**: score every ticket against the rules, emitting values that conform to the schema.
- **Human evaluation**: the user fills the same schema by hand, per ticket, at their own pace (partial allowed).
- Persist the **LLM eval and the human eval together** in a single eval file; export it.
- **Merge** other users' eval files of the same dataset, pooling **all LLM evals** into one group and **all human evals** into another (mean/sd for scores, proportions/majority for booleans, distributions for enums) — **kept separate, never combined**.
- **Compare human vs LLM** — the primary output: per property, per ticket, how the pooled LLM verdict differs from the pooled human verdict (Δ / agreement / overlap), plus a dataset-level roll-up of how closely the model tracks human judgment.
- **Side-by-side viewer**: LLM evaluators on one side, humans on the other, with the comparison between them; click through to a per-ticket detail showing the conversation + all evaluations + both aggregates + their difference.
- Providers: **Ollama** (local, default) and **Anthropic** — those two only. Unlike Qbort, the user **picks the Anthropic model** (fetched live).
- **Local-only** operation except the LLM call; **API keys in the OS keychain**, never in the renderer.

### Non-goals (initial release)
- No cloud sync, accounts, telemetry, or a central results server (merge is manual file exchange).
- No editing of the *tickets* themselves (Qval never mutates the imported dataset).
- OpenAI / Gemini providers (deferred, as in Qbort).
- Inter-rater-reliability statistics beyond mean/sd/proportion/distribution (no Cohen's/Fleiss' κ in v0 — see §16).
- Multi-window / multi-project management.

---

## 2. Data model

Qval touches four kinds of data: the **imported tickets** (read-only, from Qbort), the **eval config** (rules + schema, authored in Qval), the **eval file** (the persisted result), and the **aggregate** (derived at merge time). The single source of truth for all of these types and the IPC contract is `src/shared/types.ts`, as in Qbort. **camelCase everywhere.**

### 2.1 Imported tickets (from Qbort) — read-only reference

Qval consumes Qbort's exact output shape and never rewrites it. Only the fields Qval needs are relied upon:

```ts
interface Ticket {
  id: number
  subject: string
  status: TicketStatus            // 'new'|'open'|'pending'|'on-hold'|'solved'|'closed'
  messages: TicketMessage[]       // messages[0] is the customer's opening message
}
interface TicketMessage {
  from: { name: string; email: string }
  body: string
  isStaff: boolean
  createdAt: string               // ISO 8601
}
```

A `tickets.json` is `{ meta, tickets }` (Qbort's `TicketFile`). Qval keeps `meta` only for display (provider/model/counts that produced the data); it evaluates `tickets`. Qval validates the imported file with a **tolerant** zod schema (accepts any Qbort export; ignores unknown fields).

### 2.2 Eval schema — the user-defined output properties

The **schema** is an ordered list of typed properties the evaluator (LLM or human) fills in for each ticket. Four base types, each optionally **multi-valued** (an array of that type via the `multiple` flag):

```ts
type PropertyType = 'score' | 'boolean' | 'enum' | 'text'

interface EvalProperty {
  key: string            // stable camelCase id used as the values-map key (e.g. "empathy")
  label: string          // display name (e.g. "Empathy")
  type: PropertyType
  multiple?: boolean      // when true, the value is an ARRAY of `type` (e.g. multi-select). Default false.
  description?: string    // guidance shown to the human AND injected into the LLM prompt
  // type === 'score':
  min?: number           // default 1
  max?: number           // default 5
  step?: number          // default 1 (integer scores by default)
  // type === 'enum':
  options?: string[]     // the allowed labels, ≥2
}

type EvalSchema = EvalProperty[]
```

- **score** → a number in `[min,max]`. Aggregated with **mean + standard deviation** (and n).
- **boolean** → true/false. Aggregated as **most-common value + agreement** (and counts, n).
- **enum** → one of `options`. Aggregated as a **distribution** over options + **mode** + **agreement** (and n).
- **text** → free-form note/justification. **Not** aggregated; collected and shown **side-by-side**.
- **`multiple: true`** → the value becomes an **array** of the base type (e.g. `type:'enum', multiple:true` = a multi-select yielding `string[]`, like `category: ["bug","billing"]`). Allowed for `enum` (primary) and `score`; **not** for `boolean` (an array of bools is meaningless) or `text` (free text is kept single-value), and arrays don't nest. An empty array `[]` is a valid "evaluated, none apply" value — distinct from a missing key ("not evaluated"). No min/max on array length. Aggregation is per-element (multi-hot) — see §2.6.

`key` is unique, immutable once data exists (renaming a key = a new property; see merge, §2.5). The schema editor (§4) enforces validity (unique keys, ≥2 enum options, `min<max`, `multiple` only on the allowed base types).

### 2.3 Rules — free-form evaluation context

Rules are a single **free-form text block** that tells the evaluator *how* to score, decoupled from the schema. It exists to give the model whatever context it needs **before** scoring: prose explanations, definitions of terms, scoring philosophy, edge-case guidance — and, if the user wants, an explicit list of criteria. No structure is imposed; the user writes free text (Markdown-ish) in a large editor, the same way Qbort's editable prompt works.

```ts
type Rules = string   // free-form; may contain prose, definitions, and/or a list of criteria
```

Rules are **guidance**, not enforced constraints — the schema (types/ranges/enums) is what's structurally validated. At evaluation time the compiled prompt includes the rules text **verbatim**, followed by each schema property's own `description`, so the model gets both the overall context and per-field instructions. The same rules text is shown read-only next to the human eval form so both evaluators score against identical guidance.

### 2.4 The eval file (`*.qval.json`)

A file holds a list of **evaluators**, each an independent scorer of the dataset. A typical working file has two: one `llm` evaluator (produced by a run) and one `human` evaluator (you, named in the run config). The array shape is uniform for both and generalizes to more (extra humans, repeated LLM runs) without a format change. Each evaluator carries its own explicit `results[]` keyed by `ticketId` — no ticket-id-as-object-key. Plus a snapshot of the config used. This file is the unit that gets exported and later merged.

```jsonc
{
  "meta": {
    "app": "qval",
    "appVersion": "0.1.0",
    "createdAt": "2026-07-02T18:00:00.000Z",
    "updatedAt": "2026-07-02T18:42:00.000Z",
    "dataset": {
      "fingerprint": "sha256-…",     // over canonicalized tickets (§2.5); identity for merge
      "ticketCount": 100,
      "source": { "provider": "anthropic", "model": "claude-…" }  // from imported tickets meta, display-only
    },
    "config": {
      "fingerprint": "sha256-…",     // over normalized {schema, rules}; identity for merge
      "schema": [ /* EvalProperty[] snapshot */ ],
      "rules":  "…free-form rules text snapshot…"   // §2.3
    }
  },
  "evaluators": [
    {
      "id": "llm",                            // stable id, unique within the file
      "kind": "llm",                          // 'llm' | 'human' — drives stream separation & aggregation
      "name": "LLM · claude-sonnet-4-6",      // display label (NOT what identifies the stream — `kind` is)
      "provider": "anthropic",                // llm only
      "model": "claude-sonnet-4-6",           // llm only
      "results": [
        { "ticketId": 1, "values": { "empathy": 4, "resolved": true, "category": "billing", "notes": "Polite, fixed it." }, "evaluatedAt": "2026-07-02T18:05:00.000Z", "error": null },
        // a value auto-repaired on validation (score clamped) + a value the model couldn't produce (dropped → unscored):
        { "ticketId": 2, "values": { "empathy": 5, "resolved": false },
          "issues": [ { "key": "empathy", "action": "clamped", "original": 7 },
                      { "key": "category", "action": "dropped", "original": "n/a" } ],
          "evaluatedAt": "2026-07-02T18:05:03.000Z", "error": null }
        // a whole-ticket failure: { "ticketId": 3, "values": {}, "evaluatedAt": "…", "error": "truncated/invalid JSON after 1 retry" }
      ]
    },
    {
      "id": "human",
      "kind": "human",
      "name": "Brian L.",                     // entered in the run config; free display label
      "results": [
        { "ticketId": 1, "values": { "empathy": 5 }, "evaluatedAt": "2026-07-02T18:40:00.000Z" }
        // PARTIAL by nature: only evaluated tickets appear; missing keys within `values` = not scored
      ]
    }
  ]
}
```

Notes:
- `kind` (`'llm'|'human'`), not the `name`, decides which stream a result feeds — so a human named "LLM" or a model labeled "Claude" can't corrupt the split. `name` is a free display label (see identity/conflict handling in §8).
- `results` is **sparse**: an entry exists only for a ticket the evaluator has scored. Within an entry, `values` is a `Partial<Record<propertyKey, number|boolean|string|number[]|string[]>>` (the array forms for `multiple` properties, §2.2); a missing key means "that property not scored," whereas `[]` on a `multiple` property means "scored, none apply." Averages skip missing entries and missing keys (§8).
- `ticketId` must be unique within an evaluator's `results` and must exist in the dataset; both are validated on read (a `Map<ticketId, result>` index is built on load for O(1) access).
- An LLM run **replaces** the `llm` evaluator's `results` for the targeted tickets; human edits to the `human` evaluator **upsert** and merge field-by-field (editing one property never clears others).
- `issues[]` (optional, per result) is the **non-silent repair trail**: for each value auto-`clamped`/`coerced`/`dropped` on validation, `{ key, action, original }`. It's advisory (the viewer badges it, §9.2) and never blocks; a `dropped` field is simply absent from `values`. See the value-repair rules in §6.
- **LLM output is never hand-edited.** A human cannot alter or clear the `llm` evaluator's values; the model owns its scores. To disagree with the model, fill in the **human** evaluation — the human-vs-LLM `comparison` (§2.6) surfaces the disagreement. (Human writes only ever touch the `human` evaluator; `applyLlmResults` is the sole writer of `llm` values.)
- The file is written **atomically** (`fsUtil.atomicWriteJson`, as in Qbort) after human edits (debounced) and after an LLM run.
- Every value is re-validated against the snapshot schema on write (per the §6 coerce-or-drop rules) so a compromised renderer can't persist off-schema data; human form inputs are structurally bounded, so this mainly guards LLM output and post-hoc schema changes.

### 2.5 Fingerprints — the merge-matching identity

Two identities gate whether files may be merged. **Both must be equal** (the user's choice: dataset + schema + rules must all match):

- `dataset.fingerprint` = `sha256` of the **canonicalized tickets array** — each ticket reduced to a stable, order-independent-of-formatting form `{id, subject, status, messages:[{from:{name,email}, body, isStaff, createdAt}]}`, serialized with sorted keys. Any change to the underlying tickets changes the fingerprint. (Qbort's `meta` is excluded so re-exports of the same tickets still match.)
- `config.fingerprint` = `sha256` of the **normalized `{schema, rules}`**: schema properties in declared order with their full definitions; rules as the trimmed free-form text. Reordering schema properties (which changes meaning) changes the fingerprint; whitespace-only differences in the rules text are normalized out.

Canonicalization + hashing live in a pure, tested `shared/fingerprint.ts` so main and renderer compute identical values.

### 2.6 Aggregate model (derived at merge time)

Qval computes, **per ticket, per property, per stream**, an aggregate from every evaluator that has a value — pooling evaluators *within* the working file and *across* all merged comparison files. Streams are split by each evaluator's `kind` (`llm` vs `human`), never by name:

```ts
type PropertyAggregate =
  // numeric: central tendency + spread
  | { type: 'score';   n: number; mean: number; sd: number; min: number; max: number; values: number[] }
  // categorical (2-way): most-common value + how strongly evaluators agreed
  | { type: 'boolean'; n: number; trueCount: number; falseCount: number; proportionTrue: number;
      majority: boolean | null;  agreement: number }
  // categorical (N-way): full tally + most-common option + agreement
  | { type: 'enum';    n: number; distribution: Record<string, number>; mode: string | null; agreement: number }
  // multi-select (enum + multiple): multi-hot — each option's selection frequency across evaluators
  | { type: 'enum[]';  n: number;                       // n = evaluators who scored this property (each gave a set)
      distribution: Record<string, number>;             // # of evaluators whose set INCLUDED each option
      selectionRate: Record<string, number>;            // distribution[opt] / n  (0–1)
      consensus: string[] }                             // options a strict majority selected (rate > 0.5); [] if none
  // free text: not reduced — collected verbatim, side-by-side
  | { type: 'text';    n: number; values: { source: string; value: string }[] }   // source = evaluator name (§8)
  // score[] (multi-valued score): collected verbatim per evaluator, not reduced in v1
  | { type: 'list';    n: number; values: { source: string; value: (string|number)[] }[] }

interface TicketAggregate {
  ticketId: number
  llm:        Record<propertyKey, PropertyAggregate>   // all LLM evaluators pooled
  human:      Record<propertyKey, PropertyAggregate>   // all human evaluators pooled
  comparison: Record<propertyKey, StreamComparison | null>  // LLM-aggregate vs human-aggregate; null if either side is empty
}

// The headline output: how the pooled LLM verdict differs from the pooled human verdict.
type StreamComparison =
  | { kind: 'score';   llmMean: number;   humanMean: number;   delta: number }     // delta = human − llm
  | { kind: 'boolean'; llm: boolean|null; human: boolean|null; agree: boolean|null } // majority vs majority
  | { kind: 'enum';    llm: string|null;  human: string|null;  agree: boolean|null } // mode vs mode
  | { kind: 'enumSet'; llm: string[];     human: string[];     jaccard: number }    // consensus-set overlap 0–1
  // text / list: no scalar comparison — shown side-by-side only
```

- **Score** — `mean` + sample `sd` (n−1; `0` when n<2), plus `min`/`max`/`values`. All stats ignore missing values; `n` is the count that actually contributed.
- **Categorical (enum, boolean) — the "most common value" + a consensus measure.** Enum reports the full `distribution` and the `mode` (most frequent option); boolean reports `trueCount`/`falseCount`/`proportionTrue` and the `majority` (`true`/`false`). Both also report **`agreement`** = modal count ÷ `n` (0–1) — the share of evaluators who picked the winning value, i.e. the categorical analog of low variance (`1.0` = unanimous; near `0.5` for boolean = maximal split). This is what surfaces "the evaluators mostly said `billing` (4 of 5)" or "they split on `resolved`."
- **Ties** yield `mode`/`majority` = `null` (there is no single most-common value); the `distribution`/counts still carry the split, so the UI renders it explicitly (e.g. "tie: billing / how-to"). Reducers are deterministic — no arbitrary tie-break.
- **Multi-select (`enum` + `multiple`) → per-option frequency.** Each evaluator contributes a *set* of options, so we aggregate **multi-hot**: `distribution[opt]` counts how many evaluators included `opt`, `selectionRate[opt]` is that ÷ `n`, and `consensus` is the options a strict majority selected. E.g. across 3 evaluators `{bug,billing} / {billing} / {bug,billing,how-to}` → `billing 3/3, bug 2/3, how-to 1/3`, consensus `{billing, bug}`. An evaluator's `[]` ("none apply") counts toward `n` but adds to no option. This is the natural extension of "most common value + agreement" to sets. **`score` arrays** aren't reduced — they're collected per evaluator (the `list` aggregate) and shown side-by-side.
- **Text** is deliberately **not** reduced to a single value (free-text answers rarely repeat meaningfully); it's collected verbatim and shown side-by-side. (Exact-duplicate detection could be a later nicety, but there's no "mode" for prose in v1.)
- **The two streams are never pooled into one number.** LLM evaluators aggregate among themselves; human evaluators aggregate among themselves; there is deliberately no combined "human+LLM" score. The **primary output is the `comparison`** — the pooled-LLM verdict *versus* the pooled-human verdict per property: a signed `delta` (human − LLM mean) for scores, a majority-`agree` match for boolean/enum, and consensus-set `jaccard` overlap for multi-select. A `comparison` is computed only where **both** streams have ≥1 contributing value; otherwise it's `null` (e.g. a ticket not yet human-evaluated shows "no human eval yet," not a fake delta).
- **Dataset-level roll-up** (per property, over tickets where both streams have data): scores → **mean |delta|** and a signed mean delta (does the LLM run hot or cold vs humans?) + count compared; boolean/enum → **% of tickets where LLM and human majority agree**; multi-select → **mean jaccard**. This is the app's headline — "how closely does the model track human judgment on each property" — surfaced in the summary (§9.1).
- Aggregates are **derived, never persisted in the working file**; they're recomputed from the in-memory set of loaded files. A merged **report** can be exported separately (§10) as a flat JSON for downstream analysis.

Pure, exhaustively-tested reducers live in `shared/aggregate.ts`.

---

## 3. Settings & session model

### Persisted settings (`settings.json` under Electron `userData`, no secrets — as in Qbort)

```ts
interface Settings {
  providerId: 'ollama' | 'anthropic'      // default 'ollama'
  ollama: { host: string; model: string }
  anthropic: { model: string | null }     // user-selected (NEW vs Qbort); null until chosen
  evaluatorName: string                    // your display name, stamped on the human evaluator (§2.4); default e.g. OS username
  schema: EvalSchema                       // persists across sessions; snapshotted into each eval file
  rules: string                            // free-form evaluation context (§2.3)
  concurrency: number                      // eval parallelism (default 4)
  batchSize: number                        // tickets per LLM call (default ~20, adaptive)
  defaultDir: string | null                // where eval files are saved/opened; null → userData
  lastWorkingPath: string | null           // most recent eval file
}
```

Settings persist automatically (no save button), as in Qbort. `schema`/`rules` here are the *working* config — the template for a **new** evaluation and the editor buffer.

**The loaded file is the authoritative config source (decided).** Opening a `*.qval.json` **hydrates** the working `schema`/`rules` from that file's `meta.config` snapshot (and the `providerId`/model from its scored `llm` evaluator), so the editors mirror the file. Main reads the schema/rules used for a run / estimate / human-value validation straight from `workingFile.meta.config` (not from the loose settings), so the config that produced the data can never diverge from what the file declares. While the working file is still **unlocked** (no scored values yet), editing schema/rules re-stamps the working file's `meta.config` (re-fingerprint) so the snapshot tracks the edits during setup.

**Config lock — once a file has real scores, its config freezes** (so a file's fingerprint/snapshot can never contradict how its data was produced):
- **Schema + rules** freeze as soon as *any* evaluator (llm **or** human) has a result with non-empty `values` — the criteria must be identical across both streams and every ticket. Error-only / empty results don't lock (setup stays open).
- **Provider + model** freeze once the **`llm`** evaluator has a scored result — every ticket in a run must use the same model (no finishing an Ollama run with Anthropic). A locked re-run pins provider/model to the producing evaluator, in main, regardless of the UI. `providerLocked` ⟹ `configLocked`.
- **Storage** settings (evaluator name, default folder) stay editable always.
- The UI disables the frozen Settings sections with a "locked — open its tickets.json to start fresh" notice. The escape hatch is **re-opening the tickets.json** (§10 OPEN), which discards the file for a fresh, fully-editable working file.

The lock predicates (`configLocked`, `providerLocked`, `lockedLlmProvider`) live in `shared/evalFile.ts` (pure, tested).

### In-memory session (not persisted as settings)

- **Dataset** — the imported `tickets` + their fingerprint. Required before evaluating.
- **Working file** — the editable eval file (your LLM + human evals). Created fresh when you import a `tickets.json`, or loaded when you open a `*.qval.json`.
- **Comparison files** — zero or more read-only `*.qval.json` added via MERGE; each must match both fingerprints or is refused with a clear reason. Their evaluators are pooled into the aggregate; identity = each evaluator's `(kind, name)` (see §8 for conflict handling).

The working file is the only editable one; comparison files only feed aggregates and the side-by-side columns.

---

## 4. Rules & schema editor (renderer)

Two sections inside the Settings modal (tabbed, as in Qbort):

- **Schema editor** — an ordered, editable list of properties. Each row: `label`, `key` (auto-derived from label as camelCase, editable, uniqueness-validated), `type` (select), an **"Allow multiple" toggle** (sets `multiple`; disabled/hidden for `boolean`, which can't be an array), `description`, and type-specific controls (score `min`/`max`/`step`; enum `options` as add/remove chips). Add/remove/reorder rows. Live validation with inline neo-brutalist error labels. Ships with a small **default schema** (e.g. `empathy` score 1–5, `resolved` boolean, `category` enum, `tags` multi-select enum, `notes` text) so the app is usable out of the box and demonstrates the multi-select case.
- **Rules editor** — a single large **free-form textarea** for the evaluation context (§2.3), mirroring Qbort's editable-prompt editor: prose, definitions, and/or a criteria list, no imposed structure. Ships with a minimal starter text the user expands on. A **"Preview compiled prompt"** control shows exactly what will be sent to the LLM for a sample batch (system + rules text + schema instructions + rendered tickets + output-format block), mirroring Qbort's compiled-prompt preview.

Editing schema/rules changes `config.fingerprint`. This is only permitted while the working file is **unlocked** (no scored values); each edit re-stamps the working file's `meta.config` so the snapshot stays honest. Once the file has any score, the **Schema** and **Rules** editors are disabled (and, after an LLM score, the **Provider** picker too) with a lock notice — the config that produced the data is frozen so a file can never claim a config different from the one it was scored under. To evaluate under different criteria or a different model, **re-open the tickets.json** (§10 OPEN) to start a fresh file (saved under a new name so the old one isn't overwritten).

---

## 5. LLM providers (`src/main/generation/providers/` → reused as `src/main/evaluation/providers/`)

Same `fetch`-only, main-process-only pattern as Qbort. Two providers:

- **Ollama** (local, default) — `POST /api/chat` (or `/api/generate`) with `format: json`; `listModels()` via `GET /api/tags`; NDJSON parsed tolerantly; `done_reason: "length"` surfaced as a retryable truncation error. Host configurable (default `http://localhost:11434`). User picks the model (as in Qbort).
- **Anthropic** — Messages API via `fetch`; JSON enforced via the prompt; prompt caching on the static prefix (system + rules + schema, identical across batches) to cut cost; `stop_reason: "max_tokens"` → retryable truncation error.

### Model selection — Anthropic is now user-chosen (differs from Qbort)

- **Fetch live**: `GET https://api.anthropic.com/v1/models` (requires the stored key; called in main) populates the Anthropic model dropdown. Cached in-memory for the session; a "Refresh models" control re-fetches. If the call fails (no key / offline), fall back to a small **curated** list constant so the picker is never empty (verify IDs at build time — see §16).
- **Ollama** model list via `listModels()`, exactly as in Qbort.
- **Pricing is not returned by the models API.** Qval keeps an optional, best-effort `pricing` map keyed by model id for known models; unknown models show cost as "—". The pre-run gate therefore shows a **token/request estimate always** and a **dollar estimate only when the chosen model's price is known** (Ollama shows "$0 · local"). Cost is advisory, never blocking.

### Provider config UI

Provider picker (default Ollama). For Anthropic: API-key entry (stored via `safeStorage`; UI shows only "is set"), **Test connection**, and the model dropdown (fetched). For Ollama: host + fetch-models + model dropdown. Same component shape as Qbort's `ProviderConfig`.

---

## 6. Evaluation orchestration (`src/main/evaluation/orchestrator.ts`)

Batched, Qbort-style. The unit of work is a **ticket**; the output is that ticket's `llm.values`.

- **Compile** (`shared/promptCompiler.ts`): system prompt + rules + a machine-readable description of the schema (each property's key, type, and constraints — score range, enum options, and whether it's `multiple` → an array of that type) + an explicit **output contract**: return a JSON object mapping each ticket id in the batch to a values object with exactly the schema keys and valid value types. The static prefix (system + rules + schema) is cache-controlled for Anthropic; the dynamic suffix is the batch's rendered tickets (subject + full conversation, author + role + body per message).
- **Batching**: split the ticket list into batches (default `batchSize` ~20), **adaptively reduced** when tickets are large (long threads) or the schema is big, so expected output fits the model's token budget without truncation. `max_tokens` sized per batch from the schema shape × ticket count.
- **Truncation handling**: providers raise a distinct retryable truncation error; the orchestrator grows `max_tokens` on retry and, at the ceiling, **splits the batch** recursively — so a big batch degrades to smaller ones rather than dropping tickets. (Same strategy as Qbort.)
- **Concurrency**: `p-limit` (default 4). **Retry/backoff** on `429`/transient/malformed output. Per-batch failures isolated; partial success kept.
- **Hang guard**: every provider request carries a timeout combined with the run's cancel signal, so a wedged socket can't stall the run indefinitely — a **total** cap on the non-streaming Anthropic call and an **idle** cap on the Ollama stream (reset on each chunk, so a progressing stream never trips it, only a stalled/dead one). A timeout aborts that request and is surfaced as a retryable error (the orchestrator retries it like any transient failure); the user's Cancel still stops the run immediately.
- **Validation & repair** (`shared/validate.ts`) — **per value, never per ticket**. zod-validate each property independently against the schema and *coerce when the intent is unambiguous, drop that one value when it isn't*: `score` → clamp to `[min,max]` + snap to `step`, non-numeric drops; `boolean` → coerce `true/false/1/0/yes/no`, else drop; `enum` → exact or trim/case near-miss → canonical option, no match drops; `text` → stringify. For **`multiple` properties**: the value must be an array (a lone scalar is wrapped into a one-element array); each **element** is coerced/dropped by the same rules, then the array is **deduped**; invalid elements are removed while valid ones stay, and an empty result stays `[]` ("none apply", still a scored value) — the whole property is only *dropped* (→ unscored) if the value can't be read as an array at all. A **dropped value is just left unscored** (aggregation skips it, §8); one bad field never discards the ticket's other good values. Every coercion/drop (including per-element ones) is recorded in the result's `issues[]` (non-silent, §2.4). Two *tiers* of failure: **value-level** (above) vs **ticket-level** — a ticket the model omits or returns unparseably for (or that truncates) gets `error` set with no values.
- **Validation retry (single)**: after a batch validates, any ticket with a ticket-level `error` **or** one or more dropped values is queued for **exactly one** automatic re-evaluation (isolated, small re-batch) — distinct from the transport/truncation retries above, and capped at one attempt to avoid useless loops. The cleaner of the two attempts is kept (per field: a value that validates on either attempt wins); genuinely unrecoverable fields stay dropped with their `issues` recorded, for the human to resolve (§9.2).
- **Progress**: main streams `evaluation:progress` events to the renderer (tickets done, batches done, retries, dropped/errored, streaming tokens, fraction) exactly like Qbort's generation progress.
- **Cancellation**: `AbortController`; Cancel aborts in-flight requests and stops scheduling; results so far are written.
- **Incremental atomic writes**: after each batch, validated evals are merged into the working file and written atomically, so a crash mid-run leaves a valid file.
- **Exclusive access — the working file is read-only during a run (sequential only)**: while an LLM run is in flight, every other mutation is blocked in **main** (the authoritative guard) and disabled in the UI — human edits (`human.setValues`), schema/rules/provider changes (`settings.set`), and `OPEN`/`MERGE` (which would swap the file out from under the run). This eliminates any run-vs-user write race by construction (no merging concurrent edits, no stale snapshots); the user edits again once the run finishes or is cancelled. One run at a time is already enforced (a second `start` is refused).
- **Re-run modes**: evaluate **all** tickets, only **needs-attention** ones (unevaluated, errored, or with unresolved dropped values), or a **selection**. Re-running overwrites the `llm` result for the targeted tickets only (clearing their prior `issues`).
- **Pre-run gate**: before a run, show a token/request estimate (+ dollars when known) and require confirmation, mirroring Qbort's cost gate. Ollama shows "$0 · local".

---

## 7. Human evaluation workflow (renderer)

- Human eval happens in the **ticket detail** view (§9): the conversation on one side, a **human eval form** on the other, generated from the schema — a score slider+number for `score`, a switch for `boolean`, a select for `enum`, a textarea for `text`, and for **`multiple` properties** a multi-select (chip/checkbox list for `enum`; add/remove rows for `text`/`score`). The rules are shown read-only above the form as scoring guidance, and the **LLM's values** for this ticket are shown for reference (clearly labeled as the model's, not pre-filling the human's).
- Human edits **upsert** into the working file's `human` evaluator (§2.4), whose `name` is the `evaluatorName` from settings (editable; defaults to the OS username). If the working file has no `human` evaluator yet, the first edit creates one.
- **Partial is fine** (the user's choice): the user evaluates any subset; each property saved independently. Edits persist automatically (debounced atomic write) to the working file — no save button.
- **Paused during an LLM run**: while a run is in flight the working file is read-only, so the human eval form is disabled (with a notice); scoring resumes when the run finishes or is cancelled (§6). Human eval and LLM runs are never concurrent — everything is sequential.
- **Progress**: a header stat shows LLM- and human-eval completeness as a count of tickets scored (a ticket counts once it has ≥1 non-empty value — the same definition for both streams; errored or all-dropped tickets don't count). **Next unevaluated** / prev/next controls let the user sweep the queue quickly.
- Export is allowed at any completeness (partial permitted).

---

## 8. Merge & aggregate stats

- **MERGE** opens a file picker to add one or more `*.qval.json` **comparison** files. Each is validated: must parse as a Qval file and match **both** `dataset.fingerprint` **and** `config.fingerprint` of the working file. Mismatches are rejected individually with a specific reason ("different dataset" / "different rules or schema"), never silently coerced.
- The evaluator set = **every `evaluator` from the working file plus every comparison file**. `shared/aggregate.ts` pools them **into two independent groups by `kind`** — all `llm` evaluators together, all `human` evaluators together — and computes `TicketAggregate` (§2.6) per ticket for each group (means/sd, proportions, distributions/mode, multi-hot, collected text), skipping missing values, reporting the contributing `n`. It then computes the per-property **`comparison`** (LLM group vs human group). Two files that each carry an `llm` evaluator yield `n=2` for the LLM mean; that's the cross-evaluator disagreement we're after. **The groups are never merged into a single number** — the human↔LLM comparison is the goal (§2.6).
- **Evaluator identity & conflicts.** An evaluator's display label is its `name`; the working file's own evaluators are marked distinctly (e.g. "(this file)"). Dedup/identity is the tuple **`(kind, name, sourceFile)`** so the *same* file added twice collapses, while two different people who both typed "Brian L." stay distinct — on a display-name collision Qval appends a disambiguating suffix (e.g. `Brian L. (2)` or the source filename). `name` is only a label; all stream math keys off `kind`.
- **Repaired values still count** — an auto-`clamped`/`coerced` value feeds its stream at face value (a `dropped` value contributes nothing, as an unscored gap). LLM values are never hand-edited (§2.4), so an `llm` number is always model-produced (modulo automatic repair). Provenance travels with the data: the merged report (§10) carries each contributing value's `issues` markers so a downstream reader can see which numbers were auto-repaired.
- Aggregates are recomputed reactively as files are added/removed; nothing about comparisons is written into the working file.

---

## 9. Results viewer (renderer) — the main surface

Single page, no routing (as in Qbort). Two coordinated views:

### 9.1 Overview table (paginated, 100/page)
Columns: `#id`, `subject`, `status`, and per **schema property** a compact cell. The cell's **default mode is the LLM-vs-human comparison** (§2.6) — the two pooled verdicts and how they differ: score → `L4.2 / H4.6 (Δ+0.4)`; boolean/enum → the two majorities with a match/mismatch mark (e.g. `L:YES H:YES ✓`, `L:billing H:how-to ✗`); multi-select → the two consensus sets + overlap. A property with no human eval yet shows the LLM verdict and a muted "no human eval." Two other cell **modes** (a view toggle) focus a single stream and show its full aggregate — score → `mean±sd (n)`; boolean → `YES 80% (n5)` / `TIE (n4)`; enum → `billing 3/5` / `TIE`; multi-select → top options by selection rate with the consensus set emphasized; text/lists → count. Cells with low intra-stream `agreement` **or** a large human↔LLM gap are weighted/marked (per the neo-brutalist "convey by weight, not color" rule) so disagreement is scannable. Filter by status + free-text search over subject/messages (as in Qbort). A **summary** header shows dataset info (source provider/model, ticket count), the evaluator roster (each evaluator's `name`, grouped by `kind`, working file marked distinctly), LLM-eval and human-eval completeness, and the **dataset-level human-vs-LLM roll-up per property** (mean |Δ| and signed bias for scores; % majority agreement for categorical; mean jaccard for multi-select) — the headline "how closely the model tracks human judgment."

### 9.2 Ticket detail (modal over the page)
Clicking a row opens the conversation modal (Qbort's thread rendering: customer = black-on-white, staff = black-on-slate-grey, the one permitted non-monochrome surface) **plus** an evaluation panel:
- **Human eval form** for the working file (§7) — editable.
- **Side-by-side** table: one row per property; columns grouped into an **LLM block** and a **human block** (one column per evaluator `name` within each), each block ending in its pooled aggregate; then a final **LLM-vs-human** column showing the `comparison` (Δ for scores, ✓/✗ majority match for categorical, jaccard for multi-select). This makes the two-group structure and their difference the visual spine — humans on one side, models on the other.
- **Validation/repair review**: cells for the working file's `llm` result flag their `issues` — a ⚠ badge on a `clamped`/`coerced` value (hover shows the `original`) and a "— (dropped)" marker on a value the model couldn't produce. These markers are **read-only provenance** — LLM values are not editable (§2.4). Where the model got a ticket wrong or dropped a value, the user records their own judgment in the **human eval form** above; the human-vs-LLM comparison then shows the gap. (Single auto-retry has already run at eval time, §6, so this is only the residue.)
- Prev / next / **next-unevaluated** navigation; keyboard-friendly.

Pagination (not virtualization) keeps the DOM light for 5000-ticket sets, as in Qbort.

---

## 10. Storage, import, export

`src/main/storage.ts` (Qbort-derived):
- **OPEN** — one native open dialog that **auto-detects** the file: a Qbort `tickets.json` starts a **new working eval** (fresh evals, dataset fingerprint computed, schema/rules from current settings, `workingPath` reset so the first save prompts for a name); a `*.qval.json` **loads that working file** (and its dataset must be re-importable or the tickets travel with it — see below), **hydrating** the working schema/rules and provider/model from the file's snapshot (§3). Defaults the dialog to `defaultDir`. **Re-opening the `tickets.json` is also how you start over under new criteria**: it discards the current (possibly locked) working file for a fresh, fully-editable one, so there is no separate "new evaluation" action.
- **Dataset provenance (decided: reference by fingerprint)**: an eval file references its dataset by fingerprint and does **not** embed the tickets (keeps files small and the tickets canonical in Qbort's file). Opening a `*.qval.json` prompts for its matching `tickets.json` if the tickets aren't already loaded; the fingerprint must match or the open is refused. Merge needs no prompt — a comparison file's scores map by ticket id onto the already-loaded dataset, and the equal `dataset.fingerprint` guarantees they line up.
- **MERGE** — add read-only comparison eval files (§8).
- **EXPORT** — native save dialog writing the working file (`*.qval.json`); main exports the file **it** tracks (no renderer-supplied path), as in Qbort.
- **EXPORT MERGED REPORT** — write a flat aggregate JSON: per ticket, per property, the **llm** and **human** `PropertyAggregate`s (kept separate) **and the `comparison`** between them, plus the dataset-level human-vs-LLM roll-up per property and the contributing evaluator names. This is the artifact for "how did the model do vs the humans." Read-only, not re-importable as a working file.
- On launch, auto-load `lastWorkingPath` if present (and, if it needs tickets, prompt), mirroring Qbort's auto-load.
- All writes via `fsUtil.atomicWriteJson`; all reads via `readJson`.

---

## 11. Security model

Identical posture to Qbort:
- **Keys in OS keychain via `safeStorage`**; decrypted only in main at call time; never returned to the renderer (renderer learns only "is a key set"). Encrypted blobs under `userData`.
- **Renderer hardening**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; minimal typed `window.api` via `contextBridge`; strict **CSP** applied via `session.webRequest.onHeadersReceived` in `main/index.ts` — production `default-src 'self'`, no external `connect-src` (all network in main), plus `object-src/base-uri/frame-src/form-action` locked down.
- **All network egress from main only** (Anthropic + Ollama fetches). Renderer makes no external requests.
- **IPC input validated in main**: provider ids checked against the allow-list; numeric settings re-clamped; schema/rules re-validated; every persisted eval value re-validated against the schema before write; **export/merge take no renderer-supplied source path** for the working file (main tracks it).

---

## 12. Tech stack & project structure

Same stack as Qbort: `electron-vite` (Electron + Vite, TS); React + TypeScript + Tailwind + shadcn/Radix primitives restyled neo-brutalist; **zod**; **p-limit**; client-side pagination (100/page); plain `fetch` providers (no SDKs); **Vitest** unit + integration; `electron-builder` packaging. Path aliases `@shared/*` and `@/*`. TypeScript strict, `noUnusedLocals`.

```
qval/
├─ package.json · electron.vite.config.ts · tsconfig*.json
├─ tailwind.config.cjs · postcss.config.cjs
├─ src/
│  ├─ main/
│  │  ├─ index.ts                 # lifecycle, BrowserWindow, CSP
│  │  ├─ ipc.ts                   # typed IPC handlers
│  │  ├─ secrets.ts               # safeStorage/keychain
│  │  ├─ settings.ts              # persisted non-secret config (schema, rules, providers)
│  │  ├─ storage.ts               # tickets import + eval file open/save/export/merge
│  │  ├─ fsUtil.ts                # atomicWriteJson / readJson
│  │  ├─ connection.ts            # provider test-connection
│  │  └─ evaluation/
│  │     ├─ orchestrator.ts       # batching, concurrency, retry, progress, cancel, atomic writes
│  │     ├─ service.ts · estimate.ts
│  │     └─ providers/
│  │        ├─ types.ts · models.ts        # curated fallback list + optional pricing map
│  │        ├─ anthropic.ts · ollama.ts    # openai/gemini deferred
│  ├─ preload/
│  │  └─ index.ts                 # contextBridge → window.api
│  ├─ shared/
│  │  ├─ types.ts                 # data model + IPC contract (source of truth)
│  │  ├─ schema.ts                # EvalProperty helpers, defaults, validation
│  │  ├─ rules.ts                 # free-form rules default + normalize (for fingerprint)
│  │  ├─ fingerprint.ts           # dataset + config canonical hashing
│  │  ├─ promptCompiler.ts        # rules + schema + tickets → compiled eval prompt
│  │  ├─ validate.ts              # zod: imported tickets + LLM eval output
│  │  ├─ aggregate.ts             # mean/sd/proportion/distribution reducers
│  │  └─ evalFile.ts              # eval-file read/normalize/merge helpers
│  └─ renderer/
│     ├─ index.html · main.tsx · App.tsx
│     ├─ components/
│     │  ├─ ui/                   # restyled neo-brutalist primitives
│     │  ├─ TopBar.tsx            # title · OPEN · EVALUATE · MERGE · EXPORT · gear (file actions disabled during a run)
│     │  ├─ SettingsModal.tsx     # tabbed: provider · schema · rules · storage
│     │  ├─ SchemaEditor.tsx      # typed property rows
│     │  ├─ RulesEditor.tsx       # free-form rules textarea + compiled-prompt preview
│     │  ├─ ProviderConfig.tsx    # provider picker, key entry, model fetch, test
│     │  ├─ EvaluateModal.tsx     # run flow: estimate gate → progress → cancel
│     │  ├─ DatasetView.tsx       # paginated results table + summary, aggregate cells, stream toggle
│     │  ├─ Pagination.tsx
│     │  ├─ TicketDetailModal.tsx # conversation + human form + side-by-side + aggregate
│     │  └─ HumanEvalForm.tsx     # schema-driven inputs
│     ├─ state/                   # Settings/Dataset/WorkingFile/Comparison/Toast contexts
│     └─ lib/                     # utils, format, hooks (createSafeContext, useSecretStatus)
```

### IPC surface (preload `window.api`) — allow-listed, typed
- `settings.get()` / `settings.set(partial)`  *(setting `schema`/`rules` re-stamps an unlocked working file's config, §3)*
- `secrets.setKey(provider,key)` / `hasKey(provider)` / `clearKey(provider)` / `status()`
- `provider.testConnection(provider)`
- `ollama.listModels(host)` · `anthropic.listModels()`  *(main fetches `/v1/models` with the stored key)*
- `session.open()` (auto-detects `tickets.json` vs `*.qval.json`; a `tickets.json` starts a fresh eval) / `loadLast()` / `save()`
- `session.addComparison()` / `removeComparison(id)` / `exportReport()`
- `evaluation.estimate(mode)` / `start(mode)` / `cancel()` + `onProgress(cb)`
- `human.setValues(ticketId, values)` (upsert into the working file's `human` evaluator)
- `dialog.chooseDirectory()`

The **compiled-prompt preview** (§4) runs the pure `shared/promptCompiler` in the renderer — no IPC round-trip. All heavy logic lives in `shared/` pure modules; IPC handlers are thin.

---

## 13. UI layout & visual design

Neo-brutalist, strictly **monochrome** black/white/grays, minimal, high-contrast — identical token set to Qbort (`ink`, `paper`, `staff` slate for staff messages only), 2px black borders, square corners (`rounded-none`), solid offset `shadow-brutal`, flat fills, **UPPERCASE mono** buttons/labels; status by borders/weight/labels, not color. shadcn/Radix primitives restyled in `components/ui/`.

Single page:
- **Top bar**: title left; right: `OPEN`, `EVALUATE`, `MERGE`, `EXPORT`, gear (settings). `OPEN` a `tickets.json` starts a fresh evaluation (and is how you start over under new criteria, §10); `EVALUATE` is the primary (solid) action.
- **Body**: the results table (§9.1) with filter/search + summary; empty state prompts `OPEN` a `tickets.json` to start.
- **Settings modal** (gear): tabbed — Provider · Schema · Rules · Storage.
- **Evaluate modal** (`EVALUATE`): estimate gate → live progress + Cancel; run state persists if closed mid-run (as in Qbort).
- **Ticket detail modal**: conversation + human form + side-by-side + aggregate (§9.2).

---

## 14. Implementation phases

1. **Scaffold + design system** — copy Qbort's electron-vite + React + TS + Tailwind + hardened BrowserWindow / preload / CSP; port the neo-brutalist `ui/` primitives; single-page shell (top bar, settings modal, evaluate modal, detail modal); hello-world IPC.
2. **Settings + secrets + providers** — settings.json (schema, rules, providers, storage); `safeStorage`; ProviderConfig with **Anthropic model fetch** + Ollama model list + test connection.
3. **Schema + rules** — `shared/schema.ts` / `rules.ts` (+ defaults), SchemaEditor, RulesEditor, promptCompiler + compiled preview; `fingerprint.ts`.
4. **Dataset import + eval file** — tickets import + tolerant validation + dataset fingerprint; working-file create/open/save (atomic); `evalFile.ts`.
5. **Evaluation orchestrator** — batching, adaptive size, truncation split, concurrency, retry, progress streaming, cancel, incremental atomic writes, per-ticket error capture, re-run modes; estimate gate.
6. **Human eval** — schema-driven HumanEvalForm, detail modal, debounced autosave, completeness stats, next-unevaluated sweep.
7. **Merge + aggregate + viewer** — `aggregate.ts`, MERGE flow with fingerprint gating, `DatasetView` results-table aggregate cells + stream toggle, side-by-side in detail, summary roll-ups, merged-report export.
8. **Polish & tests** — full Vitest unit + integration suite (added incrementally per phase, not deferred), empty/error states, estimate confirmation.
9. **Packaging** — electron-builder unsigned universal `.dmg`/`.zip` via a tag-triggered GitHub Actions draft release; documented Gatekeeper bypass; manual updates. (Mirrors Qbort.)

Tests land alongside each phase.

---

## 15. Testing strategy

Same discipline as Qbort — every module in `shared/` and `main/` ships a colocated `*.test.ts` (Vitest); tests are **deterministic** (no real network — providers mocked; `safeStorage` faked; `rng`/`now`/`sleep` injectable).

- **Unit (pure logic)**: `fingerprint` (identical hashes for reordered-formatting, different for content changes; dataset vs config independence), `aggregate` (mean/sd with n<2, proportions, enum distribution/mode, missing-value skipping, llm/human separation), `schema`/`rules` validation, `validate` (clamp/coerce/drop of LLM output), `promptCompiler` (schema+rules render, output contract), `evalFile` merge/normalize.
- **Integration (cross-module)**: import tickets → compile → mocked provider batch → validate → write working file → reopen; run + cancel keeps partial; adaptive-split on injected truncation preserves ticket count; merge of matching files → correct aggregates; merge refusal on fingerprint mismatch; human edits persist field-by-field.
- **Practices**: side effects (fs/fetch/Electron) at the edges; writes via `fsUtil`; run `typecheck` + `test` before a change is done.

---

## 16. Decisions & build-time verifications

**Decided:** decoupled rules/schema; four base property types (score/boolean/enum/text), each optionally **multi-valued via a `multiple` flag** (array of that type; allowed for enum/score, not boolean/text, no nesting; `[]` = "none apply" ≠ missing; multi-select enum aggregates multi-hot with per-option selection rate + majority consensus); one LLM pass per ticket per file with averaging across merged files; **LLM and human streams are aggregated separately and never pooled — the primary output is the human-vs-LLM `comparison`** (per-property Δ/agreement/jaccard, plus a dataset-level roll-up of how closely the model tracks human judgment); Anthropic model **fetched** from `/v1/models` (pricing best-effort); merge requires **dataset + schema + rules** all match; **both fingerprints hash canonicalized content** (dataset = meaningful ticket fields sorted, ignoring meta/formatting; config = normalized schema + rules) so re-exports/reformatting still match while any content change doesn't; eval files **reference the dataset by fingerprint** (not embedded — §10); the **loaded eval file is the authoritative config source** — opening hydrates schema/rules (and provider/model) from its snapshot, main reads run/validate config from `workingFile.meta.config`, and once the file has scored values its **schema/rules freeze** (any scored value, llm or human) and its **provider/model freeze** (any scored *llm* value), editable again only by re-opening the `tickets.json`, which starts a fresh working file (§3/§4); human eval **optional/partial**; **batched** evaluation; **validation is per-value** (coerce-or-drop, never discard a whole ticket; drops become unscored gaps) with a non-silent `issues` trail, **one automatic validation retry** per failed/dropped ticket (capped at one to avoid loops); **LLM output is never hand-editable** — a human cannot alter/clear the `llm` evaluator's values (to disagree with the model, fill the human eval; the human-vs-LLM comparison surfaces it); **the working file is read-only during an LLM run** — human edits, config/provider changes, and open/merge are all blocked (in main + UI) so access is strictly sequential and nothing races the run's writes (§6); **evaluator-centric eval file** — a list of evaluators each with `kind` (`llm`/`human`), a display `name` (human name entered in run config), and an explicit `results[]` keyed by `ticketId`; identity/dedup on `(kind, name, sourceFile)`, stream math keyed on `kind`; providers Ollama + Anthropic only.

**Verify at build time (knowledge-cutoff caveats):**
- Anthropic `GET /v1/models` response shape + the curated fallback model IDs (Opus/Sonnet/Haiku 4.x current ids).
- Best-effort Anthropic pricing map (per model id) for the advisory cost estimate; unknown → "—".
- Ollama chat/JSON endpoint + `done_reason` truncation field names.
- κ / inter-rater-reliability stats are a **future** addition, not v0.

---

## 17. Final verification checklist (before release) ⚠️

- `npm run typecheck` + `npm test` green; deterministic tests (no real network/keychain).
- Renderer never receives an API key; CSP verified in a production build; egress only from main.
- Import a real Qbort `tickets.json`, run an Ollama eval end-to-end (no key needed), then an Anthropic eval; cancel mid-run leaves a valid partial file.
- Human eval autosave (partial) survives reload; completeness stats correct.
- Merge two independently-produced files of the same dataset+config → mean/sd/proportion/distribution correct; refuse a mismatched file with a specific reason.
- Export working file + merged report; re-open exported working file.
- Anthropic model list fetches live; falls back to curated list offline; cost estimate shows dollars only when price known, "$0 · local" for Ollama.
- Unsigned `.dmg`/`.zip` built; Gatekeeper bypass documented in README.
