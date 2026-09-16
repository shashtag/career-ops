# Token budget — what actually costs money

career-ops is prompt-heavy by design. That makes it easy to optimise the wrong
thing: ranked by file size, `modes/` and `reports/` look like the cost. Ranked by
billed tokens they are a rounding error.

`node token-audit.mjs --summary` reads your own transcripts and reports the real
split. Everything below came from doing that over 696 local sessions; run it before
acting on any of it, because the shape of your own usage is what matters.

## The two facts

**1. Cost is `context_size x api_calls`, not `content_written`.**

Everything in context is re-sent on every later call in the session. A token added
early is billed once per remaining call — in the sample above, roughly a 43x
amplification on everything that entered context. This is why a 16KB report is
cheap and a 19KB screenshot taken at step 3 of a 200-step apply run is not.

**2. The base context is paid on every call.**

The system prompt, tool definitions, the skill listing, `AGENTS.md` and memory are
re-sent every single time. In the sample: a median base of 62,084 tokens, 199 calls
per session, and **55.5% of all billed input was base x calls**. Trimming the base
is the only lever that scales with session length instead of fighting it.

| Where the base went | tokens | share |
|---|---|---|
| System prompt, tool definitions, agent/skill listings | ~34,000 | 55% |
| `AGENTS.md` (inlined via `CLAUDE.md`'s `@AGENTS.md`) | 13,251 | 21% |
| Skill listing (106 installed skills) | 10,860 | 17.5% |
| `MEMORY.md` | 3,830 | 6% |

## What to do about it

### Hide skills you never use (biggest single win, no downside)

The skill *listing* — every installed skill's name and description — sits in the
base context on every call. In the sample, 104 of 106 installed skills were invoked
**zero** times across 696 sessions, costing ~10,860 tokens per call for nothing.

Claude Code's `skillOverrides` hides a skill from the model while keeping its slash
command working. Put it in `.claude/settings.local.json` — project-scoped, gitignored,
and therefore the correct home for user-specific config under the Data Contract:

```json
{
  "skillOverrides": {
    "some-unused-skill": "user-invocable-only"
  }
}
```

| Value | Model sees it | `/name` works |
|---|---|---|
| `on` (default) | name + description | yes |
| `name-only` | name only | yes |
| `user-invocable-only` | **no** | **yes** |
| `off` | no | no |

`user-invocable-only` is the one to use: you lose nothing you actually type, only
the model's ability to discover a skill on its own. Files stay on disk, so any hook
pointing into a skill directory keeps working. Two related settings —
`skillListingMaxDescChars` and `skillListingBudgetFraction` — cap the listing
without naming skills individually.

**Do not do this to the career-ops skill itself**, which lives in
`.claude/skills/career-ops/` and must stay model-visible.

### Read pages as text, not as pixels

The other half of the bill is conversation growth, and in a browser-driven apply run
that is dominated by images. Per call, measured:

| | avg tokens |
|---|---|
| `computer{action:"scroll"}` (returns a screenshot) | 25,428 |
| `computer{action:"screenshot"}` | 19,924 |
| `Read` on a saved `.png` | 80,896 |
| `read_page` (accessibility tree) | 371 |
| `left_click` / `type` | ~120 |

`modes/apply.md` → "Reading the page without burning context" carries the rules.
`token-audit.mjs` checks compliance with two findings — `unscaled-screenshots` and
`image-read-from-disk` — so the rule is measured rather than merely restated.

### Trim always-resident prose, but know what you are trading

`AGENTS.md` is inlined into every session, so reference material in it is paid for
on every call. Moving it into `docs/` and pointing at it conditionally is free when
the material is genuinely reference (a script's flags, a legacy file format, the
cold-start script) and **not** free when it is a rule that must fire unprompted.

Two cautions, both learned the hard way:

- **A conditionally-loaded safety rule is a safety rule that can be skipped.**
  `modes/oferta.md`'s Block G legitimacy signals are 40KB and fire rarely, but
  `test-all.mjs` pins them to that file on purpose (#2037, #2892, #2896) — the
  phrasing discipline that stops the mode making a legal accusation about a named
  employer has to be in front of the model whenever Block G runs. Splitting them
  out breaks nine guards, and correctly so. AGENTS.md says the same thing in
  general: rules belong in files the harness reads automatically.
- **Editing a system-layer file pins it.** `update-system.mjs` preserves locally
  modified system files by default (#2337), writes a `.bak`, and reports them — so
  that file stops receiving upstream changes until you take them with
  `apply --force --confirm`. Worth it for a large, stable win; a bad trade for a
  small one on a file that changes often.

## Measuring

```bash
node token-audit.mjs --summary        # the tables above, from your own transcripts
node token-audit.mjs --since 30       # last 30 days only
node token-audit.mjs --strict         # exit 1 on a high-severity finding (CI)
```

Transcripts are a Claude Code artifact. On another CLI the script reports that there
is nothing to read and exits 0 — the two facts at the top still hold, you just have
to measure them another way.
