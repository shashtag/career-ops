# Tracker TSV — the long form

`AGENTS.md` carries the contract you actually write against: **emit the header
form**. This file holds the rest — the headerless legacy layout, the transposition
it creates, and the disambiguation rules `merge-tracker.mjs` applies (#3601).

`merge-tracker.mjs` validates all of it and fails loudly rather than merging a
shifted row, so this is reference, not a checklist to hold in mind.

### TSV Format for Tracker Additions

One TSV file per evaluation at `batch/tracker-additions/{num}-{company-slug}.tsv`: a **header row of column labels**, then exactly one data row.

```
num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}\t{url}
```

**Always write the header (#3517).** With it, `merge-tracker.mjs` resolves every field by NAME through the same alias table as the tracker itself (`tracker-aliases.json`), so **column order carries no meaning** — write the fields in whatever order you like, as long as the labels sit above the values. Field meanings: `num` (integer) · `date` (YYYY-MM-DD) · `company` · `role` · `status` (canonical) · `score` (`X.X/5`) · `pdf` (`✅`/`❌`) · `report` (markdown link, always **root-relative**: `[num](reports/...)`) · `notes` (one line) · optional `via`, `location`, `url`.

**Header rules** — each violation skips that file loudly rather than merging a shifted row:

- Required labels: `num`, `date`, `company`, `role`, `score`, `status`, `pdf`, `report`. Optional: `notes`, `via`, `location`, `url`. Unrecognized labels are ignored with a warning.
- Exactly one data row per file (one addition per file is what the merge loop assumes).
- No label twice.
- The value under `score` must still read as a score (`X.X/5`, or a sentinel `N/A` / `—` / `-`). This is corroboration, not disambiguation: values written in one order under labels written in another is the transposition bug wearing a header, so it is refused.

**Headerless (legacy, still accepted):** 9 positional fields in the order `num date company role status score pdf report notes`, plus optional trailing fields. Note the transposition: `applications.md` shows **score before status**, the headerless TSV writes **status before score**, and `merge-tracker.mjs` reconciles them by identifying the score cell by content (`looksLikeScoreCell`, #1427). That has an undecidable case — `—` is both a score sentinel (#1799) and a status meaning Discarded (`normalize-statuses.mjs`), so a discarded, never-scored row carries `—` in both cells and is refused rather than guessed at. The header form has no such case, which is why it is the form to emit.

**Backfilled entries with no evaluation (#1799):** a row added retroactively without an evaluation must carry one of the recognized score sentinels — `N/A`, `—` (em dash), or `-` (hyphen) — never blank, never another placeholder. This holds for headed rows too: the sentinel is the tracker's own "no score" convention, not merely an aid to the headerless column-swap guard (`looksLikeScoreCell` in `tracker-parse.mjs`, #1427). In a headerless row an unrecognized placeholder makes score-vs-status ambiguous and the row is skipped with a warning.

**Optional Via field (#1596):** with a header, `via` is an ordinary column carrying the agency name (`Hays`). Headerless, applications through an agency/recruiter append a **tagged** extra field `via={Agency}` (e.g. `via=Hays`) after notes — never positional; the tag is mandatory. A single untagged extra keeps its legacy meaning (location). Unknown end employer → `?` as company (locale-invariant marker, never "Confidential") + a descriptor in notes. `merge-tracker.mjs` rejects ambiguous extras loudly; `--migrate-via` adds the column to an existing tracker.

**Optional posting URL — the deterministic dedup key:** label it `url` in the header, or (headerless) append it as a trailing field. `merge-tracker.mjs` matches on it FIRST (normalized: tracking params stripped, host lowercased, fragment and trailing slash dropped), and only falls back to the report-number / entry-number / fuzzy company+role tiers for rows that have no URL. A confirmed URL mismatch on both sides is proof the rows are NOT duplicates, the same way a req-number mismatch is (#1524). Detected by its `http(s)://` prefix, so it is order-independent with the optional location field. Additive and backward-compatible: 9-column headerless TSVs and trackers with no `URL` header column behave exactly as before. Backfill existing rows from their reports with `node merge-tracker.mjs --backfill-urls`.

**Report link normalization:** the TSV always carries a root-relative `[num](reports/...)` link; `merge-tracker.mjs` rewrites it relative to the tracker's own directory (`../reports/...` at `data/applications.md`, `reports/...` at root) so links stay clickable. Idempotent; fix an existing tracker with `node merge-tracker.mjs --migrate` (#760).

**Row order (#3515):** `merge-tracker.mjs` writes the table sorted by `#` **ascending** — matching how rows are referred to ("row 42") and how `reports/` is numbered on disk. The sort runs over the whole table on every write, so a tracker left in merge-batch order by an older version is repaired in place on the next merge; no migration flag is needed. Rows whose `#` is a backfill sentinel (`N/A` / `—` / `-`) sort to the end of the table in their existing relative order.

**Req/posting ID in notes disambiguates same-title postings (#1524, #2009):** when a company posts two genuinely different requisitions whose titles fuzzy-match (e.g. a leveled variant and its bare title, or two sibling team roles), put the req/job/posting ID in the **notes** column on both rows. `merge-tracker.mjs` reads it (`REQ_NUMBER_RE`) and treats rows carrying *different* recognizable IDs as distinct openings, overriding fuzzy title matching. Recognized forms are a `job id` / `posting id` / `requisition` / `req` / `jr` / `job` / `posting` / `ref` / `r_` label followed by an alphanumeric ID containing at least one digit — e.g. `req JR-10423`, `job id 88214`, `ref R_2291`. Prefer this whenever the JD exposes an ID; it is the only signal that survives near-identical titles.

