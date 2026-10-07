import { expect, test } from 'claude-code/testing'
import { classifyBash, issueKeyFromBranch, lintVerdict, splitCommand, testRunFailed, testRunPassed, testVerdictFromOutput } from '../src/detect/git'

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

test('a runner\'s exit status is exact when it runs last and surely ran; redirections do not matter', async () => {
  for (const c of ['npm test', 'cd app && npm test', 'npm test 2>&1', 'npm test > log 2>&1', 'npm test &> log', 'npm test 2>/dev/null', 'npm test >&2',
    'npm test >| log', 'npm test <&0', 'echo start; npm test', 'npm install\nnpm test', 'npm test;', 'npm test\n', 'npm test\n\n', 'npx vitest \\\n  --run']) {
    expect([c, classifyBash(c).testStatus]).toEqual([c, 'exact'])
  }
})

test('after an && (other than a cd) a runner may never have run: a failure is judged by its summary', async () => {
  for (const c of ['cat a | grep b && npm test', 'npm run build && npm test', 'cd app && npm ci && npm test']) {
    expect([c, classifyBash(c).testStatus]).toEqual([c, 'success-only'])
  }
  expect(testRunFailed(classifyBash('npm run build && npm test'), true, '')).toBe(false)
  expect(testRunFailed(classifyBash('npm run build && npm test'), true, ' 1 pass\n 2 fail\n')).toBe(true)
})

test('quoted text and escapes are never split: a separator inside them makes no command', async () => {
  for (const c of ['git commit -m "wip | npm test"', 'echo "x & npm test"', "echo 'a; npm test'", 'git commit -m "a && npm test"', 'echo a \\; npm test']) {
    expect([c, classifyBash(c).isTestRun]).toEqual([c, false])
  }
  expect(classifyBash('git commit -m "wip | npm test"').commits).toBe(1)
  expect(classifyBash('npm test -- -t "x;y" --grep "a|b"').testStatus).toBe('exact')
  expect(classifyBash('git commit -m "say \\"hi\\" | x" && npm test').testStatus).toBe('success-only')
})

test('after a runner, only && keeps its success meaningful; a ; or new line, a pipe on it, || or & loses its status', async () => {
  for (const c of ['npm test && echo ok', 'npm test && npm run lint', 'npm test && git add -A && git commit -m x', 'npm test && a | b']) {
    expect([c, classifyBash(c).testStatus]).toEqual([c, 'success-only'])
  }
  for (const c of ['npm test | tail -5', 'npm test || true', 'npm test &', 'npm test 2>&1 | tee log', 'npm test |& tail',
    'npm test; echo done', 'npm test > log 2>&1; echo "exit=$?"; tail -3 log', 'npm test\necho done', 'npm test && a; b', 'npm test && a || b',
    'false || npm test']) {
    expect([c, classifyBash(c).testStatus]).toEqual([c, 'unknown'])
  }
})

test('tests and lint are judged apart, each by the last of its kind', async () => {
  const s = classifyBash('npm test; npm run lint')
  expect([s.testStatus, s.lintStatus]).toEqual(['unknown', 'exact'])
  const t = classifyBash('npm run typecheck && npm test')
  expect([t.lintStatus, t.testStatus]).toEqual(['success-only', 'success-only'])
  expect(classifyBash('npm test; npm test').testStatus).toBe('exact')
})

test('a test run passes or fails by its status where that status is its own, else by its summary', async () => {
  const pass = ' 12 pass\n 0 fail\n'
  const fail = ' 11 pass\n 1 fail\n'
  const passed = (c: string, isError: boolean, out = '') => testRunPassed(classifyBash(c), isError, out)
  const failed = (c: string, isError: boolean, out = '') => testRunFailed(classifyBash(c), isError, out)
  // The bug this guards: a failing run followed by `; echo` exits 0, and used to count as green.
  expect(passed('npm test; echo done', false, fail)).toBe(false)
  expect(failed('npm test; echo done', false, fail)).toBe(true)
  expect(passed('npm test; echo done', false)).toBe(false)
  expect(failed('npm test; echo done', false)).toBe(false)
  // After &&: success means it passed; a failure may be a later command's, so the summary decides.
  expect(passed('npm test && npm run lint', false)).toBe(true)
  expect(passed('npm test && npm run lint', true, pass)).toBe(true)
  expect(failed('npm test && npm run lint', true, pass)).toBe(false)
  expect(failed('npm test && npm run lint', true, fail)).toBe(true)
  expect(failed('npm test && npm run lint', true)).toBe(false)
  expect(passed('npm test && npm run lint', true)).toBe(false)
  // Exact: by status alone.
  expect(passed('npm test', false)).toBe(true)
  expect(failed('npm test', true)).toBe(true)
  expect(passed('echo hi', false, pass)).toBe(false)
})

test('a lint verdict is its status where exact; after && only a success says pass; otherwise none', async () => {
  expect(lintVerdict(classifyBash('npm run typecheck'), false)).toBe('pass')
  expect(lintVerdict(classifyBash('npm run typecheck'), true)).toBe('fail')
  expect(lintVerdict(classifyBash('npm run typecheck && npm test'), false)).toBe('pass')
  expect(lintVerdict(classifyBash('npm run typecheck && npm test'), true)).toBe(undefined)
  expect(lintVerdict(classifyBash('npm run typecheck; echo done'), false)).toBe(undefined)
  expect(lintVerdict(classifyBash('npm run typecheck 2>&1 | grep error'), false)).toBe(undefined)
  expect(lintVerdict(classifyBash('npm test'), false)).toBe(undefined)
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
    expect(classifyBash(c).testStatus).toBe('exact')
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

test('a heredoc body is input, never commands: an apostrophe in it does not throw off quoting after it', async () => {
  const doc = "cat > f.ts <<'EOF'\n// don't do this\nnpm test\nEOF\ngit add f.ts && git commit -m 'wip | npm test'"
  expect(classifyBash(doc).isTestRun).toBe(false)
  expect(classifyBash(doc).commits).toBe(1)
  const after = 'git commit -m "$(cat <<\'EOF\'\nsay "hi\nEOF\n)" && npm test'
  expect(classifyBash(after).isTestRun).toBe(true)
  expect(classifyBash("cat <<-END\n\tit's\n\tEND\nnpm test").testStatus).toBe('exact')
  expect(classifyBash('cat << EOF\nx\nEOF').isTestRun).toBe(false)
})

test('an escaped backslash before a line end is not a continuation; a real one is, CRLF too', async () => {
  expect(classifyBash('echo \\\\\nnpm test').testStatus).toBe('exact')
  expect(classifyBash('npx vitest \\\r\n  --run').testStatus).toBe('exact')
  expect(splitCommand('echo a \\\nb').parts).toEqual(['echo a  b'])
})

test('an && or || before a runner counts only within its own list', async () => {
  expect(classifyBash('false && echo; npm test').testStatus).toBe('exact')
  expect(classifyBash('a || b; npm test').testStatus).toBe('exact')
  expect(classifyBash('a; b && npm test').testStatus).toBe('success-only')
})
