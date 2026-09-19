# Qval — Project Spec

A local-first tool for **evaluating** customer-support tickets with an LLM and with humans, then **aggregating** many evaluators' scores. Qval is the companion to **Qbort**: Qbort *generates* a `tickets.json`; Qval *scores* it. The user imports a ticket set, writes free-text **rules** describing how to score, defines a typed **schema** of output properties, runs an **LLM evaluation**, optionally does a **human evaluation** by hand, and saves both into a single eval file. Multiple users' eval files of the same dataset can be **merged** to produce per-ticket **means and standard deviations** (LLMs disagree even on the same model; humans disagree too).

> Qval started as an Electron desktop app and **is** a **Claude Code plugin** now: `/qval:evaluate-tickets` for the LLM half (§18) and `/qval:review` for the parts a person does by hand (§19). `.plans/CLAUDE_SKILL_CONVERSION.md` has the staging, all of it landed. There is no Electron left in the tree. Sections that still say "the app" mean the same React UI, served to a browser tab by the review server.

> Prior art: Qval re-used Qbort's architecture wholesale — React + TS + Tailwind, a strict host/renderer split, tolerant parse-and-repair validation, an allow-listed typed host surface, atomic JSON writes, and the monochrome neo-brutalist design system. Where a decision matches Qbort, we note it with "as in Qbort" for context, but every detail Qval depends on is restated here so this repo stands entirely on its own — no need to consult the Qbort directory.

---

## 1. Goals & non-goals

### Goals
- A tool that **evaluates** a ticket set, installed as a Claude Code plugin and driven from the directory the tickets are in.
- Import a Qbort **`tickets.json`** as the dataset under evaluation.
- User-authored **rules** (free-text scoring guidance) + a user-defined **schema** of typed output properties.
- **LLM-backed evaluation**: score every ticket against the rules, emitting values that conform to the schema.
- **Human evaluation**: the user fills the same schema by hand, per ticket, at their own pace (partial allowed).
- Persist the **LLM eval and the human eval together** in a single eval file; export it.
- **Merge** other users' eval files of the same dataset, pooling **all LLM evals** into one group and **all human evals** into another (mean/sd for scores, proportions/majority for booleans, distributions for enums) — **kept separate, never combined**.
- **Compare human vs LLM** — the primary output: per property, per ticket, how the pooled LLM verdict differs from the pooled human verdict (Δ / agreement / overlap), plus a dataset-level roll-up of how closely the model tracks human judgment.
- **Side-by-side viewer**: LLM evaluators on one side, humans on the other, with the comparison between them; click through to a per-ticket detail showing the conversation + all evaluations + both aggregates + their difference.
- **No API key.** The LLM evaluation runs inside Claude Code on the ambient model (§5/§18), so the tool holds no credentials.
- **Local-only** operation. Nothing here makes a network call except the review server's own loopback socket.

### Non-goals (initial release)
- No cloud sync, accounts, telemetry, or a central results server (merge is manual file exchange).
- No editing of the *tickets* themselves (Qval never mutates the imported dataset).
- No LLM providers of our own — no Ollama, no bring-your-own-key, no OpenAI/Gemini. Claude Code does the LLM work (§5).
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

A `tickets.json` is `{ meta, tickets }` (Qbort's `TicketFile`). Qval keeps `meta` only for display (provider/model/counts that produced the data); it evaluates `tickets`. Qval validates the imported file **tolerantly** in `lib/tickets.mjs` (accepts any Qbort export; ignores unknown fields).

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
      "name": "LLM · Opus 5",                 // display label (NOT what identifies the stream — `kind` is)
      "provider": "claude-code",              // llm only; what ran it (§5). Older files carry 'ollama'/'anthropic'.
      "model": "Opus 5",                      // llm only; the ambient model that actually ran
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
- The file is written **atomically** (`fsUtil.atomicWriteJson`, as in Qbort) after human edits (debounced) and after each round of an LLM run.
- Every value is re-validated against the snapshot schema on write (per the §6 coerce-or-drop rules) so a compromised renderer can't persist off-schema data; human form inputs are structurally bounded, so this mainly guards LLM output and post-hoc schema changes.

### 2.5 Fingerprints — the merge-matching identity

Two identities gate whether files may be merged. **Both must be equal** (the user's choice: dataset + schema + rules must all match):

- `dataset.fingerprint` = `sha256` of the **canonicalized tickets array** — each ticket reduced to a stable, order-independent-of-formatting form `{id, subject, status, messages:[{from:{name,email}, body, isStaff, createdAt}]}`, serialized with sorted keys. Any change to the underlying tickets changes the fingerprint. (Qbort's `meta` is excluded so re-exports of the same tickets still match.)
- `config.fingerprint` = `sha256` of the **normalized `{schema, rules}`**: schema properties in declared order with their full definitions; rules as the trimmed free-form text. Reordering schema properties (which changes meaning) changes the fingerprint; whitespace-only differences in the rules text are normalized out.

Canonicalization + hashing live in a pure, tested `lib/fingerprint.mjs`, imported by the engine, the server, and the renderer alike, so all three compute identical values.

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

Pure, exhaustively-tested reducers live in `lib/aggregate.mjs`.

---

## 3. Settings & session model

### Persisted settings (`settings.json`, no secrets — there are none left to keep)

```ts
interface Settings {
  evaluatorName: string                    // your display name, stamped on the human evaluator (§2.4); default e.g. OS username
  schema: EvalSchema                       // persists across sessions; snapshotted into each eval file
  rules: string                            // free-form evaluation context (§2.3)
  lastDatasetPath: string | null           // the tickets.json behind the working file, for relinking it by fingerprint
}
```

There is **no provider config**. The LLM evaluation runs inside Claude Code on the ambient model (§5/§18), so there is no key, host, model, or parallelism for a user to set. There are **no path settings** either, beyond the dataset pointer: the CLI binds every file from argv before the browser exists (§19), so a default folder and a most-recent-file pointer have nothing left to serve. `withDefaults` simply drops the fields an older release wrote, so a stale `settings.json` still loads.

Settings persist automatically (no save button), as in Qbort. `schema`/`rules` here are the *working* config — the template for a **new** evaluation and the editor buffer.

**The loaded file is the authoritative config source (decided).** Opening a `*.qval.json` **hydrates** the working `schema`/`rules` from that file's `meta.config` snapshot, so the editors mirror the file. The host reads the schema/rules used for human-value validation straight from `workingFile.meta.config` (not from the loose settings), so the config that produced the data can never diverge from what the file declares. While the working file is still **unlocked** (no scored values yet), editing schema/rules re-stamps the working file's `meta.config` (re-fingerprint) so the snapshot tracks the edits during setup.

**Config lock — once a file has real scores, its config freezes** (so a file's fingerprint/snapshot can never contradict how its data was produced):
- **Schema + rules** freeze as soon as *any* evaluator (llm **or** human) has a result with non-empty `values` — the criteria must be identical across both streams and every ticket. Error-only / empty results don't lock (setup stays open).
- **The model** freezes once the **`llm`** evaluator has a scored result — every ticket in a file must be scored by the same one. `lockedLlmProvider` reports what produced it, and the skill's `plan` refuses a top-up under a different model (§18). The model is not a setting, so there is nothing in the UI to disable: it lives on the file's own evaluator.
- The **Evaluator** tab (your display name, and the working file's path read-only) stays editable always.
- The UI disables the frozen Settings sections with a "locked" notice. The escape hatch is a **new eval file over the same tickets** (§10), which is a fresh, fully-editable working file rather than an edit to a scored one.

The lock predicates (`configLocked`, `lockedLlmProvider`) live in `lib/evalFile.mjs` (pure, tested).

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

Editing schema/rules changes `config.fingerprint`. This is only permitted while the working file is **unlocked** (no scored values); each edit re-stamps the working file's `meta.config` so the snapshot stays honest. Once the file has any score, the **Schema** and **Rules** editors are disabled with a lock notice — the config that produced the data is frozen so a file can never claim a config different from the one it was scored under. To evaluate under different criteria or a different model, start a **new eval file** over the same tickets (§10), which leaves the old one intact.

---

## 5. Who runs the LLM: Claude Code, and nothing else

**Decided.** The evaluation runs inside Claude Code on the **ambient model** (§18), invoked as `/qval:evaluate-tickets`. There are no provider adapters, no API keys, and no in-app run.

- **No key, no keychain.** Nothing here ever holds a credential, which is what let the whole `safeStorage` / secrets / test-connection surface go.
- **The model is asked for, not defaulted** — resolved from `--model`, else `$ANTHROPIC_MODEL`, else the session model, and recorded on the evaluator as `provider: 'claude-code'` + the model that actually ran. It is not a setting (§3).
- **No cost accounting.** Ambient generation isn't a metered API call, so there is no token/dollar estimate and no pre-run confirmation gate. Nothing to price, nothing to show.
- **Ollama and bring-your-own-key are gone**, along with the live `/v1/models` fetch, the curated fallback list, and the pricing map. Files an older release wrote still carry `provider: 'ollama'`/`'anthropic'`; they open, accept a human eval, and merge normally. Nothing tries to continue their LLM run.

---

## 6. Evaluation pipeline (`plugin/skills/evaluate-tickets/engine.mjs`)

Batched. The unit of work is a **ticket**; the output is that ticket's `llm.values`. The engine owns everything structural and subagents supply only judgment (§18).

- **Compile** (`lib/promptCompiler.mjs`): system prompt + rules + a machine-readable description of the schema (each property's key, type, and constraints — score range, enum options, and whether it's `multiple` → an array of that type) + an explicit **output contract**: return a JSON object mapping each ticket id in the batch to a values object with exactly the schema keys and valid value types. Split into a static prefix (system + rules + schema, identical across batches) and a dynamic suffix (the batch's rendered tickets: subject + full conversation, author + role + body per message).
- **Batching**: `plan` splits the target list into batches (`--batch-size`, default 10) and writes one prompt file per batch. Subagents run them in parallel; the engine reads the answers back in node, so ticket content never enters the orchestrating agent's context.
- **Validation & repair** (`lib/evalValidate.mjs`) — **per value, never per ticket**. Validate each property independently against the schema and *coerce when the intent is unambiguous, drop that one value when it isn't*: `score` → clamp to `[min,max]` + snap to `step`, non-numeric drops; `boolean` → coerce `true/false/1/0/yes/no`, else drop; `enum` → exact or trim/case near-miss → canonical option, no match drops; `text` → stringify. For **`multiple` properties**: the value must be an array (a lone scalar is wrapped into a one-element array); each **element** is coerced/dropped by the same rules, then the array is **deduped**; invalid elements are removed while valid ones stay, and an empty result stays `[]` ("none apply", still a scored value) — the whole property is only *dropped* (→ unscored) if the value can't be read as an array at all. A **dropped value is just left unscored** (aggregation skips it, §8); one bad field never discards the ticket's other good values. Every coercion/drop (including per-element ones) is recorded in the result's `issues[]` (non-silent, §2.4). Two *tiers* of failure: **value-level** (above) vs **ticket-level** — a ticket the model omits or returns unparseably for gets `error` set with no values.
- **Validation retry (single)**: after `assemble`, any ticket with a ticket-level `error` **or** one or more dropped values is queued for **exactly one** automatic re-evaluation (`retry --round 1`, an isolated small re-batch), capped at one attempt to avoid useless loops. The cleaner of the two attempts is kept (per field: a value that validates on either attempt wins); genuinely unrecoverable fields stay dropped with their `issues` recorded, for the human to answer in their own eval (§9.2).
- **Progress** is the skill's own output: `plan` says how many tickets and batches, `assemble` reports what landed, `status` reads the file back. There is no progress stream and nothing to cancel — stopping the agent stops the run.
- **Incremental atomic writes**: `assemble` merges a round's validated evals into the eval file and writes atomically, so an interrupted run leaves a valid file.
- **Concurrent access**: the run and a `/qval:review` browser session are separate processes over one file. `plan` records the eval file's `meta.updatedAt` and `assemble` refuses if it changed on disk, so a human evaluation made mid-run is never overwritten (§18). That check replaces the in-app run's exclusive lock, which had a single process to enforce it.
- **Re-run modes**: evaluate **all** tickets, only **needs-attention** ones (unevaluated, errored, or with unresolved dropped values), or a **selection**. Re-running overwrites the `llm` result for the targeted tickets only (clearing their prior `issues`), and is pinned to the model already on the file (§3).

---

## 7. Human evaluation workflow (renderer)

- Human eval happens in the **ticket detail** view (§9): the conversation on one side, a **human eval form** on the other, generated from the schema — a score slider+number for `score`, a switch for `boolean`, a select for `enum`, a textarea for `text`, and for **`multiple` properties** a multi-select (chip/checkbox list for `enum`; add/remove rows for `text`/`score`). The rules are shown read-only above the form as scoring guidance, and the **LLM's values** for this ticket are shown for reference (clearly labeled as the model's, not pre-filling the human's).
- Human edits **upsert** into the working file's `human` evaluator (§2.4), whose `name` is the `evaluatorName` from settings (editable; defaults to the OS username). If the working file has no `human` evaluator yet, the first edit creates one.
- **Partial is fine** (the user's choice): the user evaluates any subset; each property saved independently. Edits persist automatically (debounced atomic write) to the working file — no save button.
- **Never blocked by an LLM run**: the run is a separate process now (§6), so the form is always live. `assemble` is the side that yields — it refuses to write over an eval file that changed on disk while it was running, so a human edit made mid-run wins.
- **Progress**: a header stat shows LLM- and human-eval completeness as a count of tickets scored (a ticket counts once it has ≥1 non-empty value — the same definition for both streams; errored or all-dropped tickets don't count). **Next unevaluated** / prev/next controls let the user sweep the queue quickly.
- Export is allowed at any completeness (partial permitted).

---

## 8. Merge & aggregate stats

- **MERGE** adds one or more `*.qval.json` **comparison** files. The host offers what it found — under the CLI, every other `*.qval.json` beside the working file plus anything named with `--compare` — and the browser merges one **by id**, never by path (§19). Each is validated: must parse as a Qval file and match **both** `dataset.fingerprint` **and** `config.fingerprint` of the working file. Mismatches are rejected individually with a specific reason ("different dataset" / "different rules or schema"), shown on the candidate's own row, never silently coerced.
- The evaluator set = **every `evaluator` from the working file plus every comparison file**. `lib/aggregate.mjs` pools them **into two independent groups by `kind`** — all `llm` evaluators together, all `human` evaluators together — and computes `TicketAggregate` (§2.6) per ticket for each group (means/sd, proportions, distributions/mode, multi-hot, collected text), skipping missing values, reporting the contributing `n`. It then computes the per-property **`comparison`** (LLM group vs human group). Two files that each carry an `llm` evaluator yield `n=2` for the LLM mean; that's the cross-evaluator disagreement we're after. **The groups are never merged into a single number** — the human↔LLM comparison is the goal (§2.6).
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

`plugin/lib/workspace.mjs` (Qbort-derived). **Every path is resolved before the browser exists**, by `qval serve` from argv and cwd (§19), so none of the actions below is a dialog and none of them takes a path from the UI.

- **Binding the session** — `serve` **auto-detects** what to open: an explicit argument, else the single `*.qval.json` in the directory, else the single ticket file. An ambiguous directory is refused with the list rather than guessed at. A tickets file starts a **new working eval** (fresh evals, dataset fingerprint computed, schema/rules seeded from `EVAL_SCHEMA.json` / `EVAL_RULES.md` when they exist, else from settings) and is bound to `<stem>.qval.json` straight away, so there is no unsaved state to lose. A `*.qval.json` **loads that working file**, **hydrating** the working schema/rules from its snapshot (§3). **Starting over under new criteria means a new eval file**, because the config fingerprint is exactly what merging gates on.
- **Where the dataset is looked for** — the working directory *and* `qbort-output/` below it, because Qbort writes there: one timestamped `tickets-YYYYMMDD-HHMMSS.json` per run, never overwriting an earlier one. Several datasets in a directory is therefore ordinary rather than a mistake. The **eval file still goes in the working directory**, not beside the dataset, because that is where §18's engine writes its own and where the merge-candidate scan looks. A dataset in a subdirectory that dragged the eval file down with it would give one dataset two eval files, each invisible to the other half of Qval.
- **Dataset provenance (decided: reference by fingerprint)**: an eval file references its dataset by fingerprint and does **not** embed the tickets (keeps files small and the tickets canonical in Qbort's file). Opening a `*.qval.json` relinks its dataset — already loaded, then `lastDatasetPath`, then the candidates the CLI found — and the fingerprint must match or the open is refused. That last step is what makes `/qval:evaluate-tickets` then `/qval:review` work in a fresh directory, where nothing has written a `lastDatasetPath` yet. The candidates are handed over as a **list**, tried in turn: the fingerprint is the disambiguator, so a directory holding several Qbort runs needs no question asked and cannot mislink. Only starting a *new* evaluation has nothing to disambiguate on, which is the one case that refuses and asks. Merge needs no such step: a comparison file's scores map by ticket id onto the already-loaded dataset, and the equal `dataset.fingerprint` guarantees they line up.
- **MERGE** — add read-only comparison eval files, by candidate id (§8).
- **Saving** — there is nothing to save. Every mutation (a human value, a config edit) is written through atomically as it happens, and the UI reports the path it is bound to rather than offering a Save-As.
- **EXPORT MERGED REPORT** — write a flat aggregate JSON: per ticket, per property, the **llm** and **human** `PropertyAggregate`s (kept separate) **and the `comparison`** between them, plus the dataset-level human-vs-LLM roll-up per property and the contributing evaluator names. This is the artifact for "how did the model do vs the humans." Read-only, not re-importable as a working file. Its destination is **derived**, not chosen: `<working stem>.report.json`, beside the working file.
- **Shared config with the skill** — `serve` seeds a new session from the engine's `EVAL_SCHEMA.json` / `EVAL_RULES.md` and writes back the config actually used when the session ends, so §18 and §19 always score against the same schema and rules and their files always merge.
- All writes via `fsUtil.atomicWriteJson`; all reads via `readJson`.

---

## 11. Security model

- **No secrets at all.** The evaluation runs on the ambient Claude Code model (§5), so there is no API key to store, decrypt, or withhold from the UI. The keychain (`safeStorage`) surface is gone rather than hardened.
- **No egress.** Neither the UI nor the host makes an external request. The only network traffic is the review server's own loopback socket (§19), and Claude Code's, which is not ours. The served page is one self-contained file with its fonts and icons inlined as data URIs, so there is nothing for it to fetch from anywhere even if it wanted to.
- **Renderer hardening**: the UI reaches its host through one typed surface and nothing else, `renderer/lib/apiClient.ts` over `fetch`, guarded by the token / `Host` / `Sec-Fetch-Site` stack in §19. A strict **CSP** is set on the served HTML by the review server: `default-src 'self'`, `connect-src 'self'` (same-origin only), plus `object-src/base-uri/frame-src/form-action` locked down. The bundle inlines its own JS, which `script-src 'self'` does not cover, so the server hashes each inline `<script>` of the page it is about to send and names the sha256 in the policy. `'unsafe-inline'` is never used for scripts.
- **Input validated host-side**: schema/rules re-validated; every persisted eval value re-validated against the **file's** schema before write; **no endpoint or handler takes a renderer-supplied path** (the host tracks the working file, and under the CLI it is bound before the browser exists).

---

## 12. Tech stack & project structure

React + TypeScript + Tailwind + shadcn/Radix primitives restyled neo-brutalist; client-side pagination (100/page); **Vitest** unit + integration. Path aliases `@shared/*` (types), `@lib/*` (the pure `.mjs` logic), and `@/*`, declared once in a single `tsconfig.json` (DOM and node libs together, since the tests drive the browser's client against a real `node:http` server). TypeScript strict, `noUnusedLocals`. The logic has **no runtime dependencies at all** — it has to run on bare `node` inside the plugin, so it validates with plain guards rather than a schema library.

**The build is one thing: the UI.** `vite` + `vite-plugin-singlefile` inline every byte of JS, CSS, and font into a committed `plugin/ui/index.html` (~430 KB), which is what lets the plugin install with no build step. `npm run check:ui` rebuilds and diffs it, and CI runs that. The logic ships as the `.mjs` files themselves, and the server and engine run on bare node, so nothing else needs building. `electron`, `electron-vite`, and `electron-builder` are all gone, along with the main process they built.

```
qval/
├─ package.json · vite.config.mts · vitest.config.ts · tsconfig.json
├─ tailwind.config.cjs · postcss.config.cjs
├─ scripts/checkUiBundle.mjs      # rebuilds the UI and fails on drift from the committed copy
├─ src/
│  ├─ shared/
│  │  ├─ types.ts                 # data model + host contract (source of truth)
│  │  └─ *.test.ts                # the suites covering plugin/lib/
│  └─ renderer/
│     ├─ index.html · main.tsx · App.tsx · index.css · fonts.css (self-hosted Inter + Plex Mono)
│     ├─ components/
│     │  ├─ ui/                   # restyled neo-brutalist primitives
│     │  ├─ TopBar.tsx            # title · MERGE · FINISH · gear
│     │  ├─ MergeModal.tsx        # the CLI-resolved merge candidates, by name
│     │  ├─ SettingsModal.tsx     # tabbed: schema · rules · evaluator
│     │  ├─ SchemaEditor.tsx      # typed property rows
│     │  ├─ RulesEditor.tsx       # free-form rules textarea + compiled-prompt preview
│     │  ├─ DatasetView.tsx       # paginated results table + summary, aggregate cells, stream toggle
│     │  ├─ Pagination.tsx
│     │  ├─ TicketDetailModal.tsx # conversation + human form + side-by-side + aggregate
│     │  └─ HumanEvalForm.tsx     # schema-driven inputs
│     ├─ state/                   # Settings/Dataset/WorkingFile/Comparison/Toast contexts
│     └─ lib/                     # apiClient.ts (the fetch data layer), utils, format, hooks
├─ plugin/                        # the shipped Claude Code plugin (§18)
│  ├─ bin/qval                    # the CLI: serve · status (§19)
│  ├─ skills/evaluate-tickets/
│  │  └─ SKILL.md · engine.mjs · templates/
│  ├─ skills/review/
│  │  └─ SKILL.md
│  ├─ ui/index.html               # the built UI, one committed self-contained file
│  ├─ server/server.mjs           # the localhost review server (§19)
│  └─ lib/                        # THE logic, imported by the app, the engine, and the server
│     ├─ types are in src/shared/types.ts; these files carry JSDoc pointing at it
│     ├─ schema · rules · fingerprint · promptCompiler · evalValidate · evalFile
│     ├─ tickets · aggregate · settings · evaluation
│     ├─ workspace · settingsStore   # session + persisted settings (were src/main/*.ts)
│     └─ fsUtil · args
└─ test/
   ├─ skillEngine.test.ts         # engine subcommands over child_process, in a temp dir
   ├─ cli.test.ts                 # bin/qval the same way, killing the detached child it leaves
   ├─ server.test.ts              # the review server over real HTTP on a loopback port
   └─ reviewRoundTrip.test.ts     # the renderer's own client against that server, and the merge
```

### The host surface (`IpcApi` in `shared/types.ts`) — allow-listed, typed

Named for the IPC bridge it started as, and there is exactly one implementation of it left: `renderer/lib/apiClient.ts`, over `fetch` against the review server. The members below map onto §19's endpoints. The provider, secret, and evaluation members are **gone** (the LLM run moved to §18 and took them with it), and so are the native file dialogs (`session.open`, Save-As, `addComparison`, `dialog.chooseDirectory`), because the CLI resolves every path before the browser exists and there is nothing left to pick.

- `app.getVersion()` — from `GET /api/session`
- `settings.get()` / `settings.set(partial)` — `GET /api/session` and `POST /api/config`, which accepts `schema`, `rules`, and `evaluatorName` and nothing else *(setting `schema`/`rules` re-stamps an unlocked working file's config, §3)*
- `session.loadLast()` — the session the host bound at launch, `GET /api/session`
- `session.save()` — reports the bound path. There is nothing to write, since every mutation is already persisted.
- `session.mergeComparison(id)` / `unmergeComparison(id)` — `POST /api/comparison`, by **candidate id**, never a path
- `session.exportReport()` — `POST /api/export`, empty body, destination derived from the working file
- `human.setValues(ticketId, values)` — `POST /api/result`, upsert into the working file's `human` evaluator
- `review.done()` — `POST /api/done`, ends the session (§19)

The **compiled-prompt preview** (§4) runs the pure `lib/promptCompiler.mjs` in the renderer, with no round-trip to the host at all. All heavy logic lives in the pure `lib/` modules, so the server's handlers stay thin.

---

## 13. UI layout & visual design

Neo-brutalist, strictly **monochrome** black/white/grays, minimal, high-contrast — identical token set to Qbort (`ink`, `paper`, `staff` slate for staff messages only), 2px black borders, square corners (`rounded-none`), solid offset `shadow-brutal`, flat fills, **UPPERCASE mono** buttons/labels; status by borders/weight/labels, not color. shadcn/Radix primitives restyled in `components/ui/`. **Inter and IBM Plex Mono are bundled** (latin, 400 and 700, inlined as woff2 data URIs) rather than assumed to be installed, which they never are on someone else's machine. The score slider is styled for both engines (`::-webkit-slider-thumb` and `::-moz-range-thumb`, as separate rules since an unrecognized pseudo-element invalidates the whole selector).

Single page:
- **Top bar**: title left; right: `MERGE` (only when the host offered candidates), `FINISH`, gear (settings). There is no `OPEN`, no `EXPORT`, and no `EVALUATE`. The CLI binds the files before the tab exists (§19), every edit is persisted as it happens, and the LLM run is `/qval:evaluate-tickets` (§18) — a different process and often a different sitting. `FINISH` ends the session and leaves the page on a terminal panel, because the server is gone by then.
- **Body**: the results table (§9.1) with filter/search + summary; the report export sits with the merged roster in the summary, where it belongs. The empty state explains that `/qval:review` opens whatever the command line points it at.
- **Settings modal** (gear): tabbed — Schema · Rules · Evaluator.
- **Ticket detail modal**: conversation + human form + side-by-side + aggregate (§9.2).

---

## 14. Implementation phases

1. **Scaffold + design system** — copy Qbort's electron-vite + React + TS + Tailwind + hardened BrowserWindow / preload / CSP; port the neo-brutalist `ui/` primitives; single-page shell (top bar, settings modal, evaluate modal, detail modal); hello-world IPC.
2. **Settings + secrets + providers** — settings.json (schema, rules, providers, storage); `safeStorage`; ProviderConfig with **Anthropic model fetch** + Ollama model list + test connection.
3. **Schema + rules** — `lib/schema.mjs` / `rules.mjs` (+ defaults), SchemaEditor, RulesEditor, promptCompiler + compiled preview; `fingerprint.mjs`.
4. **Dataset import + eval file** — tickets import + tolerant validation + dataset fingerprint; working-file create/open/save (atomic); `evalFile.ts`.
5. **Evaluation orchestrator** — batching, adaptive size, truncation split, concurrency, retry, progress streaming, cancel, incremental atomic writes, per-ticket error capture, re-run modes; estimate gate.
6. **Human eval** — schema-driven HumanEvalForm, detail modal, debounced autosave, completeness stats, next-unevaluated sweep.
7. **Merge + aggregate + viewer** — `aggregate.ts`, MERGE flow with fingerprint gating, `DatasetView` results-table aggregate cells + stream toggle, side-by-side in detail, summary roll-ups, merged-report export.
8. **Polish & tests** — full Vitest unit + integration suite (added incrementally per phase, not deferred), empty/error states, estimate confirmation.
9. **Packaging** — electron-builder unsigned universal `.dmg`/`.zip` via a tag-triggered GitHub Actions draft release; documented Gatekeeper bypass; manual updates. (Mirrors Qbort.) *Removed in stage 6 of phase 11: distribution is the plugin marketplace now, and the last DMG stays on Releases for anyone with old files.*
10. **Headless evaluation (Claude Code skill)** — `plugin/skills/evaluate-tickets/`: `engine.mjs` (`init`/`config`/`plan`/`assemble`/`retry`/`status`) over the shared `plugin/lib/`, engine tests, `SKILL.md`/`README.md` (§18).
11. **Conversion to a Claude Code plugin** (done) — the desktop app became two commands, `/qval:evaluate-tickets` and `/qval:review`. One copy of the logic in `plugin/lib/`, the review server (§19), a fetch data layer in place of the preload bridge, the in-app LLM path deleted (§5), a single-file UI bundle, the CLI, then Electron itself. Staged in `.plans/CLAUDE_SKILL_CONVERSION.md`.

Tests land alongside each phase.

---

## 15. Testing strategy

Every module in `plugin/lib/` ships a `*.test.ts` named after it in `src/shared/` (Vitest), since a `.test.ts` inside the shippable plugin folder would need vitest and TypeScript to run. Tests are **deterministic** (no real network; `now` injectable).

- **Unit (pure logic)**: `fingerprint` (identical hashes for reordered-formatting, different for content changes; dataset vs config independence), `aggregate` (mean/sd with n<2, proportions, enum distribution/mode, missing-value skipping, llm/human separation), `schema`/`rules` validation, `validate` (clamp/coerce/drop of LLM output), `promptCompiler` (schema+rules render, output contract), `evalFile` merge/normalize.
- **Integration (cross-module)**: the engine's subcommands driven over `child_process` in a temp dir with pre-written batch files standing in for subagents (`test/skillEngine.test.ts`); the review server over real HTTP on a loopback port (`test/server.test.ts`); the renderer's own `apiClient` against that server, and a file the engine wrote merging with a file the browser wrote (`test/reviewRoundTrip.test.ts`, which is what replaced the parity test when the logic collapsed to one copy); merge of matching files → correct aggregates; merge refusal on fingerprint mismatch; human edits persist field-by-field.
- **Build**: `npm run check:ui` rebuilds the single-file UI bundle and fails if the committed `plugin/ui/index.html` has drifted. It is a committed artifact, so this is the discipline that keeps it honest.
- **Practices**: side effects (fs, http) at the edges; writes via `fsUtil`; run `typecheck` + `test` before a change is done.

---

## 16. Decisions & build-time verifications

**Decided:** decoupled rules/schema; four base property types (score/boolean/enum/text), each optionally **multi-valued via a `multiple` flag** (array of that type; allowed for enum/score, not boolean/text, no nesting; `[]` = "none apply" ≠ missing; multi-select enum aggregates multi-hot with per-option selection rate + majority consensus); one LLM pass per ticket per file with averaging across merged files; **LLM and human streams are aggregated separately and never pooled — the primary output is the human-vs-LLM `comparison`** (per-property Δ/agreement/jaccard, plus a dataset-level roll-up of how closely the model tracks human judgment); merge requires **dataset + schema + rules** all match; **both fingerprints hash canonicalized content** (dataset = meaningful ticket fields sorted, ignoring meta/formatting; config = normalized schema + rules) so re-exports/reformatting still match while any content change doesn't; eval files **reference the dataset by fingerprint** (not embedded — §10); the **loaded eval file is the authoritative config source** — opening hydrates schema/rules from its snapshot, the host validates against `workingFile.meta.config`, and once the file has scored values its **schema/rules freeze** (any scored value, llm or human) and its **model is pinned** (any scored *llm* value), editable again only by re-opening the `tickets.json`, which starts a fresh working file (§3/§4); human eval **optional/partial**; **batched** evaluation; **validation is per-value** (coerce-or-drop, never discard a whole ticket; drops become unscored gaps) with a non-silent `issues` trail, **one automatic validation retry** per failed/dropped ticket (capped at one to avoid loops); **LLM output is never hand-editable** — a human cannot alter/clear the `llm` evaluator's values (to disagree with the model, fill the human eval; the human-vs-LLM comparison surfaces it); **evaluator-centric eval file** — a list of evaluators each with `kind` (`llm`/`human`), a display `name` (human name entered in run config), and an explicit `results[]` keyed by `ticketId`; identity/dedup on `(kind, name, sourceFile)`, stream math keyed on `kind`.

**Decided later, and it removed a lot:** **the LLM evaluation runs in Claude Code on the ambient model, and nowhere else** (§5/§18). Ollama, Anthropic-with-your-own-key, the provider adapters, `safeStorage`, the live model fetch, the pricing map, the cost estimate gate, and the in-app run (with its progress stream, cancel, and read-only-during-a-run lock) are all gone rather than deprecated. Files record `provider: 'claude-code'` plus the model that actually ran. Files an older release wrote keep their own `provider` string and are ordinary eval files in every respect that survives: they open, accept a human eval, and merge with new files of the same dataset + config. Nothing offers to continue their LLM run, because nothing here runs one.

**Verify at build time (knowledge-cutoff caveats):**
- κ / inter-rater-reliability stats are a **future** addition, not v0.

---

## 17. Final verification checklist (before release) ⚠️

- `npm run typecheck` + `npm test` green; deterministic tests (no real network).
- `npm run check:ui` green, so the committed bundle is the one the sources build.
- CSP verified on the served page; no egress from either side (§11).
- The UI opened in a browser that has neither Inter nor IBM Plex Mono installed, and in one that is not Chromium (the score slider and the fonts are the two things that fail quietly there).
- Score a real Qbort `tickets.json` end-to-end with `/qval:evaluate-tickets`; an interrupted run leaves a valid partial file.
- Human eval autosave (partial) survives reload; completeness stats correct.
- Merge two independently-produced files of the same dataset+config → mean/sd/proportion/distribution correct; refuse a mismatched file with a specific reason.
- Export the merged report; re-open the working file it was derived from.
- Round trip: score a dataset with `/qval:evaluate-tickets`, open it with `/qval:review`, add a human eval, merge a second file of the same dataset + config, export the report, click Finish, and confirm `qval status` reports `done`.
- A review session started where `$BROWSER=true` (Claude Code's agent view) reports `OPENED no` and still prints a working URL.
- A schema built in the browser is one `/qval:evaluate-tickets` can then run against, and vice versa (the shared `EVAL_SCHEMA.json` / `EVAL_RULES.md`, §10).
- A `*.qval.json` from the desktop release (carrying `provider: 'ollama'`/`'anthropic'`) still opens, accepts a human eval, and merges.

---

## 18. Headless evaluation (Claude Code skill)

The **LLM evaluation**, and the only one there is: `plugin/skills/evaluate-tickets/` runs it inside Claude Code using the **ambient model** (parallel subagents), so nobody needs an API key to produce a complete `*.qval.json`. §6 is its pipeline. Everything else in this spec is browser work, unchanged: viewing tickets and scores (§9), the human evaluation (§7), merge/aggregate/comparison (§8), and export (§10). It runs on bare `node` with no build step and no `npm install`; distribution is the plugin marketplace (§19), from GitHub or from a local clone.

**Boundary.** A dependency-free `engine.mjs` owns everything structural: tickets parsing, both fingerprints (§2.5), target selection (§6 re-run modes), batching, prompt compilation (§2.3), per-value validation and repair (§6), retry accounting, eval-file assembly (§2.4), and atomic writes. The subagents own only judgment: read a compiled prompt file, write a JSON object of schema-keyed values. Ticket `id`s come from the dataset and are never trusted from the model, exactly as in the app. The engine reads the batch files in Node, so ticket content and scores never enter the orchestrating agent's context.

- **Commands.** `init` (scaffold `EVAL_RULES.md` + `EVAL_SCHEMA.json`, then stop) · `config --check|--write|--preview` · `plan` · `assemble --round <r>` · `retry --round 1` · `status`. Exit codes are the skill's control flow: `0` ok, `1` usage/malformed flag, `2` unusable state, `3` scaffolded.
- **Shared logic.** `plugin/lib/*.mjs` is not a copy of the UI's logic, it *is* the UI's logic: `schema`, `rules`, `fingerprint`, `promptCompiler`, `evalValidate`, `evalFile`, `tickets`, `aggregate`, `settings`, `evaluation`, `workspace`, `settingsStore`, `fsUtil`. The renderer and the review server (§19) import the same files, the renderer through the `@lib/*` alias. Dependency-free ESM so it runs on bare `node`, with JSDoc types on the exported signatures so the TypeScript side still type-checks. There is one copy, so there is nothing for the fingerprints to drift against.
- **Recorded evaluator.** `provider: 'claude-code'`, `model` = the model that actually ran (resolved explicitly, from `$ANTHROPIC_MODEL`, or from the session model, and *asked for* rather than defaulted), `name` = `LLM · <model>` from the app's own convention. `plan` refuses when that model disagrees with the one already on the file's scored `llm` evaluator (`lockedLlmProvider`), which is the §3/§4 model pin.
- **Retry.** One round, matching §6's single automatic validation retry. `assemble` merges cleaner-wins against the first-pass snapshot, so a value that validated the first time survives a worse retry.
- **Concurrency with a review session.** `plan` records the eval file's `meta.updatedAt` and `assemble` refuses if it changed on disk, so a human evaluation made mid-run is never overwritten.
- **No cost accounting.** Ambient generation isn't a metered API call, so there is no estimate gate anywhere. The skill has no token or cost numbers to show.

---

## 19. The review server (browser handoff)

The counterpart to §18. Where `evaluate-tickets` runs the LLM half headlessly, `/qval:review` opens the parts a person has to do by hand — schema and rules setup (§3/§4), the human evaluation (§7), and the comparison view (§8/§9) — in an ordinary browser tab, served by a dependency-free node server in `plugin/server/server.mjs`.

**The server never sees a path.** Every path (the `tickets.json`, the `*.qval.json`, and each file on offer to merge) is resolved by the CLI from argv and cwd before the browser exists, and handed to a `Workspace` that is already bound. No endpoint accepts a path from the client, which removes the path-traversal problem outright rather than defending against it. This is the browser-side restatement of §11's "export/merge take no renderer-supplied source path". A merge names a **candidate id**; an export names nothing at all.

- **Surface.** `GET /` (the single-file UI bundle) · `GET /api/session` (version + settings + session snapshot, the snapshot carrying the merge candidates as `{id, name, merged}`) · `GET /api/events` (SSE) · `POST /api/config` (schema · rules · evaluatorName, and nothing else) · `POST /api/result` (one ticket's human values) · `POST /api/comparison` (`{id, merge}` — merge or un-merge a candidate) · `POST /api/export` (write the merged report, empty body) · `POST /api/done`. There is no other route, and no static directory. The page declares its own inline data-URI favicon, so `/favicon.ico` is never requested (it would be the one request the browser makes with no token on it).
- **Access control.** Bind `127.0.0.1` explicitly. A per-session 256-bit token on every request, compared in constant time, presented as `?t=` on the first page load and as `X-Qval-Token` thereafter. The `Host` header is pinned to the loopback literals on our own port, which is the DNS-rebinding defense specifically. Mutations require `Sec-Fetch-Site: same-origin` (absent counts as refused). No CORS headers are emitted and no preflight is answered. Bodies are capped at 1 MiB. §11's CSP carries over onto the served HTML, with `script-src` naming the sha256 of the bundle's inline script instead of allowing inline scripts wholesale.
- **Validation.** `POST /api/result` re-validates every value against the **file's** schema (§2.4), exactly as the IPC path did, so a hostile page cannot persist off-schema data. `POST /api/config` allow-lists three fields; the rest of `Settings` is unreachable from the browser. `POST /api/comparison` resolves its id against the candidate list the CLI supplied and 409s on anything else, so an unoffered id is a refusal rather than a read.
- **The client lease.** Scoring 200 tickets by hand takes an hour, which no Bash timeout survives, so the server runs detached. An SSE stream is the lease: while the tab holds it the session is live, and once it has been gone for a grace period (long enough to survive a reload) the session resolves as `abandoned`. The UI's **Finish** button posts `/api/done`, which resolves it as `done`. A session nobody ever opens gives up after five minutes rather than holding a port forever.

**The CLI (`plugin/bin/qval`).** Two subcommands, both dependency-free node.

- `serve [<file>] [--compare a,b] [--port N] [--no-open] [--out .qval-run]` resolves the files (§10), starts the server in a **detached child**, opens a browser, and returns immediately with `SERVING` + `URL` + `WORKING_FILE` + `CANDIDATES` + `OPENED`. The parent does the resolution itself so an ambiguous or empty directory fails fast with an exit code (0 ok, 1 bad flag, 2 unusable state) instead of in a detached process's log. A session already live in that directory answers `ALREADY_SERVING` with the same URL rather than starting a second one.
- **Opening the browser** honours `$BROWSER` when it is a real command, and treats the sentinel values (`true`, `none`, `echo`, `:`, empty) as "no browser here" — Claude Code's own agent view sets `BROWSER=true`, and shelling out naively would run `true <url>`, exit 0, and leave the session waiting for a tab that never arrives. The URL is printed either way, because it is the only way in and it carries the session token.
- `status [--eval-file <path>]` reads the session record the child leaves in `.qval-run/review-session.json` (`live` / `done` / `abandoned` / `stale` when the process died without recording an outcome / `none`) and prints the eval file's scored counts. It is how the answer gets back to Claude, since the session outlives the command that started it. The record is chmod 0600 while live, because it holds the URL and the URL holds the token; both are cleared when the session ends.
