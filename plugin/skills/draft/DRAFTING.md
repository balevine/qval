# Drafting a config from RULES.md

Read this only when drafting. It is how to turn the user's `RULES.md` into `EVAL_SCHEMA.json` and `EVAL_RULES.md` for the scorer they chose. You write a draft file, the engine checks it, the user approves it, and the engine writes the two config files. You never write `EVAL_SCHEMA.json` or `EVAL_RULES.md` yourself, and you never modify `RULES.md`.

Read the "Core" section for either scorer. Read the "Jev" section only when the scorer is `jev`. A `claude` draft uses only the core fields.

## Core (both scorers)

`RULES.md` is the user's scoring rules in plain language. Turn it into properties that every ticket is scored on. The same properties go to the scorer and to a person scoring by hand in the review UI, so each one has to be answerable by both.

There are four property types.

- `enum` asks for exactly one answer from a fixed list of `options`. Use it when the rules say to pick one of several values that have no order. Also use it for exactly one of a few named values even when they have an order (such as HIGH, MEDIUM, LOW), whenever the rules call them options, list exact values to return, or say the answer is not a scale. Keep the rules' exact spelling for each option.
- `enum` with `"multiple": true` asks for any number of the options, including none. Use it when the rules allow any number of labels from a list. When labels have two parts (such as a product area paired with an issue type), write one option per pair, named so it stands on its own. When the rules list the pairs, write exactly those pairs. Labels the rules say stand alone (such as spam or unclear) are options in the same list.
- `score` asks for one position on an ordered numeric scale. Use it when the values have a natural order and the rules describe a range.
- `boolean` asks one yes or no question.
- `text` asks for free text. Use it only when the rules want a written answer, such as a short reason.

There are no lists of objects, no follow-up questions that depend on an earlier answer, and no question asked of only some tickets. Every property is asked about every ticket. Translate whatever the rules ask into these types. Where the rules ask something the types cannot carry, say so in `warnings` instead of inventing a shape for it.

Every property needs these fields.

- `key` is camelCase, starts with a lowercase letter, uses only letters and digits, and is unique. It is stored and hashed, so keep it stable across redrafts of the same question.
- `label` is a short name a person recognizes, such as "Sync bug" or "Urgency".
- `type` is one of the types above.
- `description` says what the concept means, taken from the rules. Never leave it empty.
- `options` (enum only) is two or more unique, non-empty strings.
- `min`, `max`, `step` (claude score only) need `min < max` and `step > 0`.
- `multiple` is `true` only on an `enum` or a `score`, never on a `boolean` or a `text`.

Cover every question the rules ask and nothing they do not. Take definitions from the rules rather than inventing them, and keep the rules' own names for labels, options, and levels. Keep a `claude` schema small where the rules allow it, since a person fills in the same form by hand for every ticket.

### The rules text

The rules text becomes `EVAL_RULES.md`, which is sent to the scorer word for word next to the properties and shown next to the human form. Return it in `rules` with these parts taken out.

- Any list of the questions to answer, since the properties now ask them.
- Any output format, JSON, schema, or field list telling a model how to shape its answer, since Qval supplies its own.
- Any sentence that only points at a part you took out.

Leave everything else exactly as written, including headings and tables. In `removed`, name each part you took out in a short phrase. If nothing needed removing, return the rules unchanged and an empty list.

### Notes and warnings

`notes` maps a property key to one or two plain sentences for the user, saying why the property has this shape. Write for someone who has never heard of a classifier. Call the types "multiple choice", "multi-select", "range", "yes or no", and "free text".

`warnings` lists anything the properties cannot carry, each as one plain sentence. Examples are a rule that ties two properties together (such as "this label is used alone" or "at least one label applies"), an order the rules ask for, and a place where the rules were ambiguous and you had to choose. Those rules stay in the rules text, and the warning tells the user they are not enforced.

### The draft file

Write the draft to `.qval-run/draft.json` as one JSON object, with no markdown fences and nothing around it.

```json
{
  "scorer": "claude",
  "properties": [
    { "key": "resolved", "label": "Resolved", "type": "boolean", "description": "The customer's underlying problem was fixed, not deflected." }
  ],
  "rules": "The text for EVAL_RULES.md.",
  "notes": { "resolved": "One yes or no question, because the rules ask whether it was fixed." },
  "removed": ["the numbered list of questions"],
  "warnings": []
}
```

`scorer`, `properties`, and `rules` are required. `notes`, `removed`, and `warnings` are optional, and an empty one is fine. `scorer` is the one the user chose.

## Jev

Jev is a classifier. It is never shown the keys or the labels. It reads each question's instructions and description and nothing else about it, so those two fields are everything it knows about a question. For most properties that is the property's `instructions` and `description`. For one option of a multi-select it is that option's `optionInstructions` and `optionDescriptions` entries.

Jev answers three ways, and each Qval type maps onto one of them.

- `boolean` is one yes or no question. Add `trueDescription`, saying what yes means, and `falseDescription`, saying what no means.
- `enum` is one choice from the options. Add `optionDescriptions`, an object from each option, spelled exactly as in `options`, to what picking it means.
- `enum` with `"multiple": true` is asked as one yes or no question per option, and the options answered yes become the selected set. Write each option as its own question, in four objects from each option, spelled exactly as in `options`.
  - `optionInstructions`: the question for that option, as a full sentence that names the option, such as "Does the customer report a bug in tasks and lists (TASKS_LISTS_BUG)?".
  - `optionDescriptions`: what the option means, taken from the rules. When an option pairs two parts (such as a product area and an issue type), combine the definitions of both parts so it stands on its own. Jev reads it right after the option's question.
  - `optionTrueDescriptions`: what yes means for that option.
  - `optionFalseDescriptions`: what no means for that option.

  Give every option its own instructions, or none of them. The property's own `instructions` are then never sent to Jev, but still write them, since they are the question a person reads. Every option is a separate question to Jev, so a long list costs a long request.
- `score` is one position on an ordered scale. Add `levels`, a list of `{ "label", "description" }`, **lowest first**, between two and ten of them. Each description says what that position means. Leave out `min`, `max`, and `step`. They are set from the levels (`0` to `levels.length - 1`, step `1`), and an answer between two levels is rounded to the nearest one.

Jev refuses two shapes, and the engine rejects them.

- `text`. Jev has no free-text answer. Where the rules want a written reason, leave it out and say so in `warnings`.
- A `score` with `"multiple": true`. Jev returns one position per question.

Every Jev property also needs `instructions`, the question itself as a full sentence. Every property's instructions plus description must differ from every other property's, and the instructions must name the specific thing they ask about. The same holds for each option's instructions plus description in a multi-select. Two questions that read the same to Jev get the same answer.

A Jev property, for reference.

```json
{
  "key": "urgency",
  "label": "Urgency",
  "type": "score",
  "instructions": "How urgent is the customer's problem?",
  "description": "Urgency is how soon the customer needs a fix to keep working.",
  "levels": [
    { "label": "Low", "description": "Can wait days. Nothing is blocked." },
    { "label": "Medium", "description": "Slows the customer down but has a workaround." },
    { "label": "High", "description": "Blocks the customer's work right now." }
  ]
}
```

A Jev multi-select, for reference, cut to two options.

```json
{
  "key": "labels",
  "label": "Labels",
  "type": "enum",
  "multiple": true,
  "instructions": "Which labels apply to the problems or requests the customer raises?",
  "description": "Apply a label for every distinct problem or request the customer raises.",
  "options": ["SYNC_BUG", "NOT_SUPPORT"],
  "optionInstructions": {
    "SYNC_BUG": "Does the customer report a bug in syncing their own devices (SYNC_BUG)?",
    "NOT_SUPPORT": "Is the conversation something other than a support request (NOT_SUPPORT)?"
  },
  "optionDescriptions": {
    "SYNC_BUG": "SYNC_BUG: keeping one person's own devices in step doesn't work as it should, such as checkmarks or lists that differ between their devices.",
    "NOT_SUPPORT": "NOT_SUPPORT: a job application, sales pitch, spam, or a message meant for another company."
  },
  "optionTrueDescriptions": {
    "SYNC_BUG": "The customer raises a problem where their own devices fall out of sync.",
    "NOT_SUPPORT": "The conversation is not a support request."
  },
  "optionFalseDescriptions": {
    "SYNC_BUG": "The customer raises no sync bug.",
    "NOT_SUPPORT": "The conversation is a support request."
  }
}
```

## Checking and fixing

Run `node "$ENGINE" draft-check --scorer <scorer>`. Exit 2 lists the problems, either a `DRAFT_INVALID` block about the envelope or a per-row `ERRORS` block ending in `SCHEMA_INVALID`. Fix every one in the draft file and check again, at most twice. If problems remain after that, show them to the user rather than looping.

`WARNINGS` do not block. Fix the ones you can (a missing definition is usually in the rules), and show the user the rest.
