import { expect, test } from 'claude-code/testing'
import { filterProse } from '../src/puzzle/privacy-filter'

// Every value below is synthetic: 000-00-0000 is never issued, 555-01xx
// numbers are reserved for fiction, example.com is reserved, and the names
// are placeholders. They exist only to exercise the filter's shapes.

const STANDARD: [string, string][] = [
  ['SSN 000-00-0000 on file', '[ssn]'],
  ['SSN 000 00 0000 on file', '[ssn]'],
  ['born 01/01/2000', '[date]'],
  ['born 2000-01-01', '[date]'],
  ['born 2000/01/01', '[date]'],
  ['born 1.1.00', '[date]'],
  ['DOB January 1, 2000', '[date]'],
  ['seen 1st March 2000', '[date]'],
  ['MRN: TEST0001 admitted', '[id]'],
  ['MR# 00001 updated', '[id]'],
  ['acct 00002 closed', '[id]'],
  ['member ID XX00001 flagged', '[id]'],
  ['ref 0XX0-XX0-XX00 sent', '[id]'],
  ['ZIP 00000 region', '[id]'],
  ['record 9999999 updated', '[number]'],
  ['age 99 cohort', '[age]'],
  ['pt is 99 yo', '[age]'],
  ['mail someone@example.com now', '[email]'],
  ['call (555) 555-0100 today', '[phone]'],
  ['call +1 555.555.0199 today', '[phone]'],
  ['see https://intranet.example.com/x?id=9', '[url]'],
  ['host db01.example.internal is down', '[host]'],
  ['node 10.0.0.1 is down', '[ip]'],
  ['Dr. Testperson reviewed it', '[name]'],
  ["Dr. O'Testperson reviewed it", '[name]'],
  ['patient Placeholder was moved', '[name]'],
  ['Patient: Placeholder was moved', '[name]'],
  ['blocked by NOVA-7 and NOVA-12', '[key]'],
  ['rename "Example Clinic" records', '[quoted]'],
  ["rename 'Example Clinic' records", '[quoted]'],
]

for (const [input, token] of STANDARD) {
  test(`standard mode redacts: ${input}`, async () => {
    const out = filterProse(input, 'standard')
    expect(out.text).toContain(token)
    expect(out.redactions).toBeGreaterThanOrEqual(1)
  })
}

test('standard mode keeps ordinary epic text and apostrophes', async () => {
  const text = "Rebuild the billing export to support CSV and retries; don't drop rows"
  expect(filterProse(text, 'standard')).toEqual({ text, redactions: 0 })
})

test('standard mode keeps short version numbers and common tech tokens', async () => {
  const text = 'Upgrade to v2 and use utf-8 everywhere'
  expect(filterProse(text, 'standard')).toEqual({ text, redactions: 0 })
})

const STRICT_NAMES = [
  'Testa Persona reported a reaction',
  'Follow up. Testa Persona called',
  'Escalation from Testperson about dosing',
  'Ronald McTestperson asked',
  'Mary-Kate Testperson asked',
]

for (const input of STRICT_NAMES) {
  test(`strict mode removes names: ${input}`, async () => {
    const out = filterProse(input, 'strict')
    expect(out.text).not.toMatch(/Test|Persona|Ronald|Mary/)
  })
}

test('strict mode keeps common title words and acronyms', async () => {
  const out = filterProse('Rebuild the Billing Portal API export for CSV', 'strict')
  expect(out.text).toBe('Rebuild the Billing Portal API export for CSV')
})

test('strict mode removes unknown all-caps names', async () => {
  expect(filterProse('Migrate XYZCORP data', 'strict').text).toBe('Migrate [name] data')
})

test('off mode returns the text unchanged', async () => {
  const text = 'SSN 000-00-0000'
  expect(filterProse(text, 'off')).toEqual({ text, redactions: 0 })
})

test('empty and whitespace input', async () => {
  expect(filterProse('', 'strict')).toEqual({ text: '', redactions: 0 })
  expect(filterProse('   ', 'standard').redactions).toBe(0)
})
