import { expect, test } from 'claude-code/testing'
import { classifyBash, issueKeyFromBranch } from '../src/detect/git'

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
  expect(classifyBash('npm test').isTestStatusReliable).toBe(true)
  expect(classifyBash('cd app && npm test').isTestStatusReliable).toBe(true)
  for (const c of ['npm test | tail -5', 'npm test || true', 'npm test &', 'npm test 2>&1 | tee log']) {
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
