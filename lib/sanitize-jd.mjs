/**
 * sanitize-jd.mjs — Shared JD text sanitization helper
 *
 * Strips standard EEO/compliance boilerplates, cookie notices, and normalises
 * whitespace.  Truncates JDs beyond 16 000 characters to conserve input tokens.
 *
 * Extracted from per-evaluator inline copies so there is a single place to
 * maintain the cleaning logic.
 */

/**
 * @param {string} text  Raw JD text
 * @param {number} [maxLen=16000]  Maximum character length before truncation
 * @returns {string}  Cleaned JD text
 */
export function sanitizeJdText(text, maxLen = 16_000) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  // Remove standard EEO and compliance boilerplates
  cleaned = cleaned.replace(
    /(?:equal opportunity employer|affirmative action|eeo\b|we celebrate diversity|all qualified applicants will receive consideration for employment without regard)[\s\S]*?(?=\n\n|\n[A-Z#]|$)/gi,
    '',
  );
  // Remove cookie banner notices and privacy policy blurbs
  cleaned = cleaned.replace(
    /(?:we use cookies|cookie policy|manage preferences|applicant privacy notice)[\s\S]*?(?=\n\n|$)/gi,
    '',
  );
  // Normalize whitespace: collapse horizontal whitespace and excessive newlines
  cleaned = cleaned.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + '\n\n[...JD truncated for length...]';
  }
  return cleaned;
}
