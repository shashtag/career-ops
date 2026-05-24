@./AGENTS.md
<!-- Add anything Gemini specific that other agents don't need -->

## Session Learnings & Hardened Best Practices

### 1. Simplify Jobs Extension
- **Status:** Retired. Do not reference, prompt, or recommend any Simplify Jobs extensions or clicks in future application steps.

### 2. Browser Automation & Tab Re-use (CDP Port 9222)
- **Tab Re-use:** When attaching to standard browser sessions over CDP (`http://localhost:9222`), always scan for and attach to the existing tab for that URL instead of spinning up duplicate tabs, which can cause hydration and page loads to hang.
- **Playwright vs. Browser Selector Space:** Playwright's custom pseudo-selectors (e.g., `:has-text("...")`) are **not** valid standard CSS and will throw syntax errors when run inside browser contexts (such as `document.querySelector` inside `page.evaluate()` or `frame.evaluate()`). For browser-side actions, use pure native JS queries.

### 3. Robust Resume File Input Identification
- **Greenhouse & Generic Labels:** On boards like Greenhouse, the `<input type="file">` for resumes is often visually wrapped in parent/sibling containers labeled simply as `"Attach"`.
- **Attribute-Based Guard:** To identify the resume field robustly, check `id` and `name` attributes (e.g. matching `resume` or `cv` keywords) rather than just looking at the resolved text label.
- **Exclusion Filter:** Ensure cover-letter fields are explicitly filtered out (e.g., ignoring fields containing the keyword `cover`) to avoid mis-uploading the resume to the wrong slot.
