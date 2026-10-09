// SPEC 5.3: prompts receive structure, not data. Rules run in order, so
// specific shapes come before generic ones. Known limit: a name written in
// lowercase in plain prose ("ask jane about it") cannot be told from an
// ordinary word without a dictionary; strict mode catches capitalized words.

export type PrivacyMode = 'standard' | 'strict' | 'off'

type Rule = { pattern: RegExp; token: string }

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'

const STANDARD: Rule[] = [
  { pattern: /\bhttps?:\/\/\S+/gi, token: '[url]' },
  { pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, token: '[email]' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, token: '[ip]' },
  { pattern: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|lan|corp|intra|com|net|org|io|dev|cloud|health)\b/gi, token: '[host]' },
  // String literals (SPEC 5.3). A single quote opens a literal only where no letter precedes it, so "don't" survives.
  { pattern: /"[^"\n]*"|“[^”\n]*”|`[^`\n]*`|(?<![\w])'[^'\n]{1,80}'(?![\w])/g, token: '[quoted]' },
  { pattern: /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, token: '[key]' },
  { pattern: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g, token: '[ssn]' },
  { pattern: /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, token: '[date]' },
  { pattern: /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, token: '[date]' },
  { pattern: new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?\\b`, 'gi'), token: '[date]' },
  { pattern: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+\\d{2,4})?\\b`, 'gi'), token: '[date]' },
  { pattern: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, token: '[phone]' },
  // A label followed by a value with at least one digit: MRN, MR#, account, member ID, ...
  { pattern: /\b(?:MRN|MR#?|acct|account|member(?:\s+id)?|patient\s+id|policy|claim|dob|ssn|zip)\b[\s:#.-]*(?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}/gi, token: '[id]' },
  // ID-shaped tokens: letters and at least three digits, six characters or more (XJ48213, 1EG4-TE5-MK73).
  { pattern: /\b(?=[A-Za-z0-9-]{6,}\b)(?=(?:[A-Za-z-]*\d){3})(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g, token: '[id]' },
  { pattern: /\b(?:age[d]?\s*:?\s*\d{1,3}|\d{1,3}\s*(?:yo|y\/o|years?\s+old))\b/gi, token: '[age]' },
  { pattern: /\b(?:Mr|Mrs|Ms|Mx|Dr|Prof)\.?\s+[A-Z][\w'’-]+(?:\s+[A-Z][\w'’-]+)?/g, token: '[name]' },
  { pattern: /\b(?:[Pp]atient|[Pp]t|[Cc]lient|[Mm]ember|[Rr]esident)\b[\s:.,]*[A-Z][\w'’-]+/g, token: '[name]' },
  { pattern: /\b\d{5,}\b/g, token: '[number]' },
]

/** Capitalized words strict mode keeps: common words in work titles, and technical acronyms. */
const STRICT_ALLOW = new Set(
  (
    'A An And Or But For To Of In On At By With From Into Over Under When If Then The This That These Those It Its ' +
    'Add Adds Fix Fixes Build Rebuild Migrate Migration Refactor Update Upgrade Remove Delete Create Implement Support ' +
    'Improve Replace Move Rename Clean Cleanup Split Merge Enable Disable Allow Prevent Handle Investigate Spike Document ' +
    'Docs Test Tests Deploy Release Bump Use Make Set Show Hide Export Import Sync Send Store Load Save Read Write Check ' +
    'Validate Track Log Logs Report Reports Retry Retries Cache Queue Job Jobs Page Pages Form Forms Field Fields Error ' +
    'Errors Phase Part New Old All Each Every Some No Not Only First Second Final Initial Basic Better Faster ' +
    'API APIs UI UX CSV JSON SQL HTTP HTTPS URL URLs PDF ID IDs OK CI CD DB PHP JS TS CSS HTML XML REST CLI SDK ' +
    'EHR PHI PII HIPAA MFA SSO OAuth SAML JWT AWS GCP iOS Android Web Mobile Admin Backend Frontend Billing Portal'
  ).split(' '),
)

const STRICT_EXTRA: Rule[] = [
  { pattern: /\b[A-Za-z]+[A-Z][\w'’-]*|\b[A-Z][\w'’-]*/g, token: '[name]' },
]

export function filterProse(text: string, mode: PrivacyMode): { text: string; redactions: number } {
  if (mode === 'off') return { text, redactions: 0 }
  let redactions = 0
  let out = text
  for (const { pattern, token } of STANDARD) {
    out = out.replace(pattern, () => {
      redactions += 1
      return token
    })
  }
  if (mode === 'strict') {
    for (const { pattern, token } of STRICT_EXTRA) {
      out = out.replace(pattern, word => {
        if (STRICT_ALLOW.has(word)) return word
        redactions += 1
        return token
      })
    }
  }
  return { text: out, redactions }
}

/**
 * The value shapes of `filterProse` (URLs, emails, IPs, hosts, keys, IDs,
 * dates, phones, names after a title or role word, long numbers), for code
 * whose literals and comments are already gone (SPEC 8.3 rule 1). Quoted
 * text and strict mode's capitalized words are left to the code's own
 * grammar: in code those are literals and type names.
 */
export function filterValues(text: string): { text: string; redactions: number } {
  let redactions = 0
  let out = text
  for (const { pattern, token } of STANDARD) {
    if (token === '[quoted]') continue
    out = out.replace(pattern, () => {
      redactions += 1
      return token
    })
  }
  return { text: out, redactions }
}
