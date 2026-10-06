import { expect, test } from 'claude-code/testing'
import { classifyBash, issueKeyFromBranch, testVerdictFromOutput } from '../src/detect/git'

test('issue keys from branch names', async () => {
  expect(issueKeyFromBranch('feature/NOVA-142-warp-free-name')).toBe('NOVA-142')
  expect(issueKeyFromBranch('bugfix/nova-7')).toBe('NOVA-7')
  expect(issueKeyFromBranch('NOVA-3-start')).toBe('NOVA-3')
  expect(issueKeyFromBranch('user/x/NOVA2-10-y')).toBe('NOVA2-10')
})

test('branches without a key', async () => {
  for (const b of ['main', 'feature/cleanup', 'release-2026-10', 'hotfix-3', 'feature/2-things', 'v1-0', 'feature/api-01-x', '']) {
    expect(issueKeyFromBranch(b)).toBe(undefined)
  }
})

test('checkout and switch may change the branch', async () => {
  for (const c of ['git checkout NOVA-1', 'git switch -c feature/NOVA-2-x', 'git -C repo checkout main', 'FOO=1 git switch main']) {
    expect(classifyBash(c).mayChangeBranch).toBe(true)
  }
  expect(classifyBash('git status').mayChangeBranch).toBe(false)
})

test('commits are counted per git commit in a compound command', async () => {
  expect(classifyBash('git add -A && git commit -m "x"').commits).toBe(1)
  expect(classifyBash('git commit -m a; git commit --amend --no-edit').commits).toBe(2)
  expect(classifyBash('echo "git commit"').commits).toBe(0)
})

test('piped, guarded or backgrounded test runs are not reliable', async () => {
  for (const c of ['npm test', 'cd app && npm test', 'npm test 2>&1', 'npm test > log 2>&1', 'npm test &> log', 'npm test 2>/dev/null']) {
    expect(classifyBash(c).isTestStatusReliable).toBe(true)
  }
  for (const c of ['npm test | tail -5', 'npm test || true', 'npm test &', 'npm test 2>&1 | tee log', 'npm test |& tail']) {
    expect(classifyBash(c).isTestStatusReliable).toBe(false)
  }
})

test('test runners are recognized', async () => {
  for (const c of [
    'php artisan test', 'vendor/bin/pest --filter X', 'vendor/bin/phpunit', 'npm test', 'npm run test -- --watch=false',
    'pnpm test', 'npx vitest run', 'pytest -q', 'go test ./...', 'cargo test', 'claude plugin test .', 'cd app && npm test',
  ]) {
    expect(classifyBash(c).isTestRun).toBe(true)
  }
  for (const c of ['npm install', 'echo test', 'cat tests/a.test.ts', 'git commit -m "add test"']) {
    expect(classifyBash(c).isTestRun).toBe(false)
  }
})

test('wrappers that pass the exit status through are seen past', async () => {
  for (const c of ['timeout 300 npm test', 'timeout --signal=KILL 5m npm test', 'time npm test', 'nice -n 10 pytest', 'env CI=1 npm test', 'command npm test']) {
    expect(classifyBash(c).isTestRun).toBe(true)
    expect(classifyBash(c).isTestStatusReliable).toBe(true)
  }
  expect(classifyBash('timeout 300 git commit -m x').commits).toBe(1)
})

// Summaries as the runners print them (abridged).
const PASSING: [string, string][] = [
  ['claude plugin test', ' 187 pass\n 0 fail\nRan 187 tests across 14 files. [6.14s]'],
  ['jest', 'Tests:       42 passed, 42 total\nSnapshots:   0 total'],
  ['vitest', ' Test Files  3 passed (3)\n      Tests  12 passed (12)'],
  ['pest', '  Tests:    18 passed (40 assertions)'],
  ['pytest', '============================== 7 passed in 0.12s ==============================='],
  ['phpunit', 'OK (12 tests, 30 assertions)'],
  ['go test', 'ok  \texample.com/pkg\t0.012s'],
  ['cargo test', 'test result: ok. 5 passed; 0 failed; 0 ignored'],
]
const FAILING: [string, string][] = [
  ['claude plugin test', ' 185 pass\n 2 fail\nRan 187 tests across 14 files.'],
  ['jest', 'Tests:       1 failed, 41 passed, 42 total'],
  ['vitest', '      Tests  1 failed | 11 passed (12)'],
  ['pest', '  Tests:    1 failed, 17 passed (40 assertions)'],
  ['pytest', '========================= 1 failed, 6 passed in 0.31s =========================='],
  ['phpunit', 'FAILURES!\nTests: 12, Assertions: 30, Failures: 1.'],
  ['go test', '--- FAIL: TestX (0.00s)\nFAIL\nFAIL\texample.com/pkg\t0.010s'],
  ['cargo test', 'test result: FAILED. 4 passed; 1 failed; 0 ignored'],
]

for (const [runner, output] of PASSING) {
  test(`a passing ${runner} summary reads as pass`, async () => {
    expect(testVerdictFromOutput(output)).toBe('pass')
  })
}

for (const [runner, output] of FAILING) {
  test(`a failing ${runner} summary reads as fail`, async () => {
    expect(testVerdictFromOutput(output)).toBe('fail')
  })
}

test('no visible summary is no verdict', async () => {
  for (const output of ['', 'Ran 187 tests across 14 files. [6.14s]', 'ok done', 'all good']) {
    expect(testVerdictFromOutput(output)).toBe(undefined)
  }
})
