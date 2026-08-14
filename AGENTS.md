# AGENTS.md

Guidance for agentic coding tools working in this repo. Keep changes consistent with what's here. The authoritative spec is `.plans/PROJECT_SPEC.md` — read it for detail and **keep it in sync when behavior changes**.

## What this is

A local-first **Electron desktop app** for **evaluating** customer-support tickets. It's the companion to **Qbort** (which *generates* a `tickets.json`); Qval *scores* it. The user imports a ticket set, writes free-text **rules** (how to score), defines a typed **schema** of output properties, runs an **LLM evaluation**, optionally does a **human evaluation** by hand, and saves both into a single `*.qval.json` file. Multiple users' eval files of the same dataset can be **merged** for per-ticket **means/standard deviations** (LLMs and humans disagree even on the same model/criteria). Runs entirely locally; only network egress is the LLM call. Providers: **Ollama** (local, default) and **Anthropic** — those two only (OpenAI/Gemini deferred). Unlike Qbort, the user **picks the Anthropic model** (fetched live from `/v1/models`).

## Structure & process boundary

- `src/main/` — Electron **main process**. The only place with Node/OS/network/key access. Key files: `index.ts` (BrowserWindow + CSP), `ipc.ts` (typed handlers), `secrets.ts` (safeStorage), `settings.ts`, `storage.ts` (tickets import + eval-file open/save/export/merge), `fsUtil.ts` (`atomicWriteJson`/`readJson`), `connection.ts`, `evaluation/` (orchestrator, service, estimate) + `evaluation/providers/` (adapters).
- `src/preload/index.ts` — `contextBridge` exposing the typed `window.api`. Nothing else reaches the renderer.
- `src/shared/` — cross-process pure logic + the **IPC contract**: `types.ts` (single source of truth for the data model + `IpcApi`/`IpcChannels`), `schema.ts`, `rules.ts`, `fingerprint.ts`, `promptCompiler.ts`, `validate.ts`, `aggregate.ts`, `evalFile.ts`.
- `src/renderer/` — React UI: `App.tsx` shell, `components/` (`ui/` primitives + feature components), `state/` (contexts via `createSafeContext`), `lib/` (utils, format, hooks).
- `.claude/skills/evaluate-tickets/` — a **Claude Code skill** that runs the LLM evaluation headlessly with the ambient model (no API key): `SKILL.md` (what Claude follows), `engine.mjs` (`init`/`config`/`plan`/`assemble`/`retry`/`status`), `lib/` (dependency-free ESM **ports** of the pure logic in `shared/`, so the folder is copyable to `~/.claude/skills/` and runs on bare `node`), `templates/`. The engine owns everything structural; subagents only supply judgment. **Any change to `shared/schema.ts`, `rules.ts`, `fingerprint.ts`, `promptCompiler.ts`, `evalValidate.ts`, or `evalFile.ts` must be mirrored in `lib/`**. `test/skillParity.test.ts` runs both over one case table, because silent fingerprint drift means CLI and app files quietly stop merging. Files it writes carry `provider: 'claude-code'` and are blocked from in-app LLM re-runs (spec §18).

**Hard rule:** the renderer never touches Node, the network, or API keys. Everything crosses the boundary through the allow-listed IPC surface (declared in `shared/types.ts`, implemented in `main/ipc.ts`, bridged in `preload`). API keys are decrypted in main only and **never** returned to the renderer (renderer learns only "is a key set").

## Core domain model

- **Imported tickets** — Qbort's `tickets.json` shape `{ id, subject, status, messages: [{ from, body, isStaff, createdAt }] }`, read-only. Qval never mutates the dataset.
- **Schema** — ordered `EvalProperty[]`; four base types: `score` (numeric min/max/step), `boolean`, `enum` (options), `text`. Each optionally **multi-valued** via `multiple: true` (array of that type; allowed for enum/score, not boolean/text, no nesting). `[]` on a multiple property = "none apply" (≠ missing key). Determines what can be aggregated.
- **Rules** — a single free-form text block (`string`) of evaluation context (prose, definitions, and/or a criteria list), decoupled from the schema; injected verbatim into the LLM prompt and shown next to the human form.
- **Eval file (`*.qval.json`)** — a list of **evaluators**, each with `kind` (`'llm'|'human'`), a display `name` (the human name comes from the run config), optional `provider`/`model` (llm), and an explicit `results[]` keyed by `ticketId` (sparse; partial `values` allowed). A typical working file has one `llm` + one `human` evaluator. Plus a snapshot of `{schema, rules}` and two fingerprints. It **references** the dataset by fingerprint (does not embed tickets).
- **Fingerprints** — `dataset.fingerprint` (SHA256 over canonicalized ticket content) and `config.fingerprint` (SHA256 over normalized schema + rules). **Merge requires both to be equal** — same tickets AND same schema AND same rules — else it's refused with a specific reason.
- **Aggregates** — derived at merge time, never persisted: score → mean/sd/n; boolean → counts/proportion + `majority` + `agreement`; enum → distribution + `mode` + `agreement`; multi-select (enum+multiple) → multi-hot per-option `distribution`/`selectionRate` + majority `consensus`; text (and score[] lists) → collected side-by-side (no mode). `agreement` = modal count ÷ n (the categorical analog of low variance); **ties → `mode`/`majority` = null** (distribution still shows the split). **LLM and human evaluators are pooled into two separate groups by `kind` and never combined into one number** — the headline output is the per-property **`comparison`** (LLM group vs human group: score Δ, majority match, or set jaccard), plus a dataset-level roll-up of how closely the model tracks human judgment. `comparison` is null where either side has no value. Evaluators are pooled across the working file + all comparison files; streams split by `kind` (llm vs human); missing values skipped. Side-by-side columns are evaluator `name`s; identity/dedup on `(kind, name, sourceFile)` with suffix disambiguation on name collisions.

## Evaluation pipeline

Batched, per-ticket output. `EvaluationService.start` → orchestrator splits tickets into adaptive batches → per batch: `compilePrompt` (rules + schema + rendered tickets + JSON output contract; static prefix cached for Anthropic) → `provider.evaluateBatch` (raw `fetch`, no SDKs) → `validate` → merge into the working file → coalesced atomic write. Truncation (Anthropic `stop_reason: "max_tokens"`, Ollama `done_reason: "length"`) is a retryable error → grow `max_tokens`, then split the batch.

**Validation is per-value, never per-ticket:** each property is coerced when unambiguous (clamp score to range + snap step; coerce boolean; trim/case-match enum to a canonical option; stringify text) or **dropped** (left unscored) when not — one bad field never discards the ticket's other values. Coercions/drops are recorded in the result's `issues[]` (non-silent). Any ticket with a drop or a ticket-level `error` gets **exactly one** automatic validation retry (capped to avoid loops); residual failures stay as `issues`/`error`. Humans may edit/clear an LLM value in the detail view — recorded in `edits` with the model's original retained (+ "reset to model"); edited values still count in the LLM stream for v1. Re-run modes: all / only-failed-or-unevaluated / a selection.

**The app owns structure; the LLM owns judgment.** Ticket `id` comes from the dataset and is never trusted from the model; the model returns only the schema-keyed values, re-validated against the schema before persistence.

## Code style

- TypeScript strict; `noUnusedLocals` is on — no dead vars/imports. Path aliases `@shared/*` and `@/*`.
- **camelCase** everywhere (data model + code). Property `key`s are camelCase and stable.
- Every module in `shared/` and `main/` ships a colocated `*.test.ts` (**Vitest**). Tests are deterministic: no real network (providers mocked), `safeStorage` faked, and `rng`/`now`/`sleep` are injectable — keep them that way. Fingerprint and aggregate reducers are pure and exhaustively tested.
- The skill's suites live in `test/` rather than beside it, since they cross the repo/skill boundary: `skillParity.test.ts` (port vs original) and `skillEngine.test.ts` (subcommands driven over `child_process` in a temp dir, with pre-written batch files standing in for subagents).
- Prefer pure, testable helpers; keep side effects (fs, fetch, Electron) at the edges. Writes go through `fsUtil.atomicWriteJson`.
- Comments explain **why**, not what; match the surrounding density.
- When writing comments and markdown files, prefer periods and parenthesis over semi-colons and em-dashes.

## Visual design

Neo-brutalist, strictly **monochrome** black/white/grays, minimal, high-contrast. Tokens in `tailwind.config.cjs`: `ink` (black), `paper` (white); the only permitted non-monochrome surface is `staff` (slate) for staff messages in the conversation view. Hard **2px black borders**, **square corners** (`rounded-none`), solid offset shadows (`shadow-brutal`), flat fills (no gradients), **UPPERCASE mono** buttons/labels. shadcn/Radix primitives are restyled to this language in `components/ui/`. Status/aggregates are conveyed by borders/weight/labels, not color.

## Commands

`npm run dev` · `npm run typecheck` · `npm test` · `npm run build` · `npm run pack:dir` (unpacked smoke) · `npm run dist:mac` (universal `.dmg`/`.zip`). Run `typecheck` + `test` before considering a change done.

## Notes

- Packaging is **unsigned**, manual-update, via GitHub Releases (`electron-builder.yml`, `.github/workflows/release.yml`).
- Anthropic models are fetched live from `/v1/models`; a small curated fallback list + a best-effort pricing map live in `evaluation/providers/models.ts` (verify current IDs/prices at build time — see §16 of the spec). Cost estimates are advisory (dollars only when the model's price is known; `$0 · local` for Ollama).
- `README.md` is user-facing; paragraphs are single-line (soft-wrap) — match that. `.notes/` is gitignored scratch.
- Contribution rule: open an Issue before a PR.
