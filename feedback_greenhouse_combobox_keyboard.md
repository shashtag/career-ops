# Greenhouse React Select + Remix Validation Block

## Pattern
Greenhouse's job-boards.greenhouse.io forms use React Select (custom `Os` component) inside a Remix form.
Validation errors are set server-side and returned as `actionData`; they only clear on a successful
form submission — not on field-change events.

## Symptoms
- Comboboxes display correct values visually (`.select__single-value` shows "Yes"/"No")
- `input[role="combobox"]` `.value` stays `""` (the search text input, not the selected value)
- Calling `Os.onChange({value: 1, label: "Yes"})` updates `Os.memoizedProps.value` to the selection
  object but does **not** clear the `error` prop — the error originates from the parent Remix state
  which only updates on submit
- Form validation errors remain: "This field is required." shows under each combobox

## Root cause
Greenhouse's Remix form sets errors from `actionData` (server-side validation response).
These errors are props flowing DOWN from the Remix form state → `Os` → `J` → `<p>` element.
Client-side field changes update the React Select's value but NOT the Remix actionData error state.
The errors only clear when the form is re-submitted and the server validates the new values.

## Implication for auto-fill
Even if `Os.onChange` is called correctly and the display updates, the form will still show
validation errors until a successful submission. Combined with the reCAPTCHA CSP 428 issue
(see `feedback_greenhouse_recaptcha_428.md`), Greenhouse forms on `job-boards.greenhouse.io`
cannot be autonomously submitted:
1. reCAPTCHA CSP blocks the submit → 428
2. Even if bypass existed, the combobox validation errors would block client-side submit gate

## What DOES work
- Filing text fields (name, email, phone, website, essay answers): full fill via DOM manipulation
- The two comboboxes that passed validation in the 2026-09-17 #916 run (question_18686759008 and
  question_18686764008) must have been set via a different mechanism in the prior session — unclear
  exactly how, but they DO work sometimes

## Workaround
Park the form, note manual steps, hand off to user. The user can:
1. Open the parked tab
2. Re-select the combobox values (React Select responds to clicks in the user's browser)
3. Upload the PDF (file picker works in interactive mode)
4. Submit (reCAPTCHA may work in Chrome with real session cookies)
