import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Engine-level tests: the plugin loaded by the engine's own host, with the
// clock, store, env, model and UI operations answered beneath it.
// FINAL_COMMIT_SEED makes every game roll deterministic.

const START = { cwd: '/work', surface: 'terminal' as const, isInteractive: true }
const SEED = '42'

type World = { clock: ReturnType<typeof mock.clock>; commands: string[]; agents: string[]; toasts: string[]; status: (string | undefined)[]; prompts: string[]; opened: string[] }

function world(on: On, opts: { branch?: string; seed?: string; env?: Record<string, string> } = {}): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { TERM: 'xterm-256color', FINAL_COMMIT_SEED: opts.seed ?? SEED, ...opts.env })
  const w: World = { clock, commands: [], agents: [], toasts: [], status: [], prompts: [], opened: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('agent.register', (_$, e) => {
    w.agents.push(e.name)
    return { value: { agent: `final-commit:${e.name}` } } as never
  })
  on('command.register', (_$, e) => {
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${opts.branch ?? 'main'}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }) as never)
  on('model.complete', (_$, e) => {
    w.prompts.push(`${e.system ?? ''}\n${e.prompt}`)
    return { value: { isAnswered: false, reason: 'api-error', usage: {} } } as never
  })
  return w
}

async function run($: any, command: string, args = '') {
  return (await $.command.run({ command, args })) as { text?: string }
}

const PANE = (requestId: string, bodyColumns = 60) => ({
  plugin: 'final-commit', surface: 'terminal' as const, component: 'Pane' as const, requestId,
  props: { title: '', isFocused: true, bodyColumns, placement: 'inline' } as never,
})

/** /epic KEY, then the title and description typed into the form pane. */
async function chart($: any, w: World, key: string, title: string, description = '') {
  expect((await run($, 'epic', key)).text).toBe(`Opened the charting form for ${key}.`)
  const form = await $.ui.mount(PANE('fc-epic'))
  await form.input({ key: 'epic-title', text: title })
  await form.input({ key: 'epic-description', text: description })
  await form.unmount()
  await w.clock.settle()
}

async function containWith($: any, keys: (ui: any) => Promise<void>) {
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice'))
  await keys(ui)
  await ui.unmount()
}

test('session start registers the commands', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  for (const n of ['epic', 'mission', 'contain', 'calibrate', 'bay']) expect(w.commands).toContain(n)
  expect(w.commands).not.toContain('encounter')
})

test('a /clear draws the status line again from the save, without registering commands twice', async ($, on) => {
  const w = world(on)
  on('classic.SessionStart', () => ({}))
  await $.session.start(START)
  const commands = w.commands.length
  const drawn = w.status.length
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(w.status.length).toBe(drawn + 1)
  expect(w.commands.length).toBe(commands)
  await $.classic.SessionStart({ source: 'resume' } as never)
  expect(w.status.length).toBe(drawn + 1)
})

test('developer mode registers /encounter', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.commands).toContain('encounter')
})

test('epic text is typed into a pane, filtered, and never put in command output', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Rebuild export for Dr. Testperson', 'SSN 000-00-0000')
  expect(w.prompts.length).toBeGreaterThan(0)
  expect(w.prompts.join('\n')).not.toContain('Testperson')
  expect(w.prompts.join('\n')).not.toContain('000-00-0000')
  expect(w.prompts.join('\n')).not.toContain('NOVA-1')
  expect(w.toasts.some(t => t.startsWith('New system charted'))).toBe(true)
})

test('a full loop: epic, mission, encounter, contain opens', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'mission', 'NOVA-2')).text).toBe('Mission NOVA-2 started.')
  expect((await run($, 'mission', 'complete')).text).toBe('Mission NOVA-2 complete. Encounter waiting.')
  expect((await run($, 'contain')).text).toBe('Opened containment.')
  expect(w.status.at(-1)).toContain('/contain')
})

test('usage errors', async ($, on) => {
  world(on)
  await $.session.start(START)
  expect((await run($, 'epic', '')).text).toContain('Usage')
  expect((await run($, 'epic', 'NOVA-1 a title in the transcript')).text).toContain('Usage')
  expect((await run($, 'mission', 'NOVA-9')).text).toContain('No active epic')
  expect((await run($, 'contain')).text).toBe('Nothing to contain right now.')
})

test('a save from a newer build is left alone and every command says so', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.env(on, { FINAL_COMMIT_SEED: SEED })
  // The store by hand, to see every write.
  const data = new Map<string, unknown>([['fc:meta', { schemaVersion: 99, createdAt: 0, completedMissions: 3 }]])
  const writes: string[] = []
  on('store.get', (_$, e) => ({ value: data.get(e.key) }))
  on('store.set', (_$, e) => {
    writes.push(e.key)
    data.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    writes.push(e.key)
    data.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...data.keys()] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', () => ({ value: undefined }))
  await $.session.start(START)
  for (const [c, a] of [['epic', 'NOVA-1'], ['mission', 'NOVA-2'], ['contain', ''], ['calibrate', ''], ['bay', '']] as const) {
    expect((await run($, c, a)).text).toContain('could not load its save')
  }
  expect(writes).toEqual([])
})

test('the Lattice pane fits 40 columns and an abandoned run keeps the encounter', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice', 38))
  for (const el of await ui.findAll({ type: 'Text' })) expect([...el.text].length).toBeLessThanOrEqual(38)
  expect(await ui.find({ key: 'keys' })).toBeDefined()
  // The kit cannot raise a person's Escape (the live tmux spike showed ui.close
  // fires with origin 'person'); an abandoned run must leave the encounter pending.
  await ui.unmount()
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('Space presses seal locks through the Input', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await containWith($, async ui => {
    // Press, advance a frame, repeat: some presses land in the zone.
    let typed = ''
    for (let i = 0; i < 40; i += 1) {
      typed += ' '
      await ui.input({ key: 'keys', text: typed, kind: 'change' })
      await w.clock.advance(97)
      const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text ?? ''
      if (!locks.includes('-')) break
    }
    const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text
    expect(locks).toMatch(/#/)
  })
})

test('a burst of Spaces seals at most one lock', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await containWith($, async ui => {
    let best = 0
    for (let i = 0; i < 40; i += 1) {
      await ui.input({ key: 'keys', text: ' '.repeat((i + 1) * 5), kind: 'change' })
      const locks = (await ui.find({ type: 'Text', text: /^Locks/ }))?.text ?? ''
      best = Math.max(best, (locks.match(/#/g) ?? []).length)
      await w.clock.advance(97)
      if (best > 0) break
    }
    expect(best).toBeLessThanOrEqual(1)
  })
})

test('calibration saves an offset for this device', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect((await run($, 'calibrate')).text).toBe('Opened calibration.')
  const ui = await $.ui.mount(PANE('fc-calibrate'))
  await w.clock.advance(1_000)
  let typed = ''
  for (let i = 0; i < 8; i += 1) {
    await w.clock.advance(i === 0 ? 790 : 750) // each press lands 40 ms after its beat
    typed += ' '
    await ui.input({ key: 'keys', text: typed, kind: 'change' })
  }
  await w.clock.advance(2_000)
  expect(w.toasts.some(t => /Saved: your presses land \d+ ms late/.test(t))).toBe(true)
  await ui.unmount()
})

test('calibration with no presses saves nothing', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await run($, 'calibrate')
  await w.clock.advance(10_000)
  expect(w.toasts).toContain('Calibration: No presses heard; nothing was saved.')
})

test('the band shows the companion once one is contained, and steps aside during containment', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  // What the engine draws when the plugin steps aside.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  let contained = false
  for (let i = 0; i < 30 && !contained; i += 1) {
    await run($, 'encounter')
    // Enter throws the cell; a second Enter closes the result.
    await containWith($, async ui => {
      await ui.input({ key: 'keys', text: '', kind: 'submit' })
      await ui.input({ key: 'done', text: '', kind: 'submit' })
    })
    contained = (await run($, 'bay')).text !== 'Opened the specimen bay (0 specimens).'
  }
  expect(contained).toBe(true)
  const BAND = {
    plugin: 'final-commit', surface: 'terminal' as const, component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 40 } as never,
  }
  const band = await $.ui.mount(BAND)
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /idle|content|startled|asleep/.test(t))).toBe(true)
  // What draws beneath keeps the left; the facts sit beside the sprite, trimmed to its drawing.
  expect(texts[0]).toBe('engine band')
  expect(texts[1]).not.toMatch(/^ /)
  const art = texts.slice(-7).filter(t => /^[^A-Za-z·]*$/.test(t))
  expect(art.length).toBeGreaterThan(0)
  for (const t of texts.slice(1)) expect([...t].length).toBeLessThanOrEqual(40 - 2)
  await band.unmount()
  // Too few rows for the sprite: one line, cut to the width.
  const short = await $.ui.mount({ ...BAND, props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 40 } as never })
  const line = (await short.findAll({ type: 'Text' })).map(t => t.text)
  expect(line.length).toBe(2)
  expect(line[0]).toBe('engine band')
  expect([...line[1]!].length).toBeLessThanOrEqual(40)
  await short.unmount()
  await run($, 'encounter')
  await run($, 'contain')
  const hidden = await $.ui.mount(BAND)
  const shown = (await hidden.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown).toEqual(['engine band'])
  await hidden.unmount()
})

test('/bay companion N picks a companion by its list number', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  expect((await run($, 'bay', 'companion 1')).text).toBe('No such specimen. /bay lists them.')
})

test('a test run on a branch with a key starts and feeds the mission', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  on('tool.call', () => ({ result: { stdout: 'ok' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  const out = await run($, 'mission', 'complete')
  expect(out.text).toContain('NOVA-5')
  expect(out.text).toContain('Reinforced Cells +1')
})

test('a failed or backgrounded Bash call is not counted', async ($, on) => {
  const w = world(on)
  let next: { result: unknown; isError?: true } = { result: {} }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  next = { result: { backgroundTaskId: 'b1' } }
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  next = { result: {}, isError: true }
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  const out = await run($, 'mission', 'complete')
  expect(out.text).not.toContain('Reinforced')
})

test('the status line shows charting while the model works, and clears after', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { TERM: 'xterm-256color', FINAL_COMMIT_SEED: SEED })
  const status: (string | undefined)[] = []
  let release: () => void = () => {}
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  // The model holds its answer until the test releases it.
  on('model.complete', () =>
    new Promise(resolve => {
      release = () => resolve({ value: { isAnswered: false, reason: 'api-error', usage: {} } })
    }) as never,
  )
  await $.session.start(START)
  expect((await run($, 'epic', 'NOVA-1')).text).toBe('Opened the charting form for NOVA-1.')
  const form = await $.ui.mount(PANE('fc-epic'))
  await form.input({ key: 'epic-title', text: 'Billing export' })
  await form.input({ key: 'epic-description', text: '' })
  await form.unmount()
  expect(status.at(-1)).toBe('| charting NOVA-1 0s')
  expect((await run($, 'epic', 'NOVA-1')).text).toBe('Epic NOVA-1 is already being charted.')
  release()
  await clock.settle()
  expect(status.at(-1)).not.toContain('charting')
})

test('a result stays up until Enter, and late Spaces land in the pane, not the prompt', { options: { devMode: true } }, async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'encounter')
  await run($, 'contain')
  const ui = await $.ui.mount(PANE('fc-lattice'))
  await ui.input({ key: 'keys', text: '', kind: 'submit' })
  await w.clock.advance(10_000)
  // Still showing the result, with a focused input that swallows stray keys.
  expect(await ui.find({ key: 'done' })).toBeDefined()
  expect(await ui.find({ key: 'keys' })).toBe(undefined)
  await ui.input({ key: 'done', text: '   ', kind: 'change' })
  expect(await ui.find({ key: 'done' })).toBeDefined()
  await ui.input({ key: 'done', text: '', kind: 'submit' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing to contain.'])
  await ui.unmount()
})

test('the Bash observer reads a piped run\'s summary from the tool output', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: 'tests/a.test.ts:\n(pass) x\n\n 3 pass\n 0 fail\n', stderr: '' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -5' } as never)
  expect((await run($, 'mission', 'complete')).text).toContain('Reinforced Cells +1')
})

test('a finished mission shows a report that stays until dismissed, and Enter goes to containment', async ($, on) => {
  const w = world(on)
  const opened = w.opened
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete')
  expect(opened.at(-1)).toBe('fc-report')
  const ui = await $.ui.mount(PANE('fc-report'))
  await w.clock.advance(60_000)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission NOVA-2 complete')
  expect(texts).toContain('Encounter!')
  expect(texts.join(' ')).toContain('Enter: contain now')
  await ui.input({ key: 'report', text: '', kind: 'submit' })
  expect(opened.at(-1)).toBe('fc-lattice')
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['Nothing to report.'])
  await ui.unmount()
})

test('leaving the report keeps the encounter waiting', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete')
  const ui = await $.ui.mount(PANE('fc-report'))
  await ui.unmount()
  expect((await run($, 'contain')).text).toBe('Opened containment.')
})

test('a mission with no encounter says why in its report', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'mission', 'complete') // the first mission always has one
  await run($, 'mission', 'NOVA-3')
  await run($, 'mission', 'complete')
  const ui = await $.ui.mount(PANE('fc-report'))
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('An encounter is already waiting: /contain.')
  expect(texts).toContain('Enter or Esc: close')
  await ui.unmount()
})

test('typing r on the report contains with a Reinforced Cell', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: { stdout: ' 3 pass\n 0 fail\n' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await run($, 'mission', 'complete')
  const ui = await $.ui.mount(PANE('fc-report'))
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('Reinforced Cell (1)')
  await ui.input({ key: 'report', text: 'r', kind: 'submit' })
  await ui.unmount()
  const lattice = await $.ui.mount(PANE('fc-lattice'))
  expect((await lattice.findAll({ type: 'Text' })).map(t => t.text).join(' ')).toContain('throw Reinforced Cell')
  await lattice.unmount()
})

test('a failing test run during a mission raises a red alert that flashes, then clears', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  let next: { result: unknown; isError?: true } = { result: { stdout: '' } }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  next = { result: { stdout: ' 1 fail\n' }, isError: true }
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(w.toasts).toContain('Red alert! Tests failing on NOVA-5.')
  expect(w.status.at(-1)).toMatch(/^! RED ALERT/)
  // A grep with no match is a routine non-zero exit, not an alert.
  const toasts = w.toasts.length
  await $.tool.call({ tool: 'Bash', command: 'grep nothing file' } as never)
  expect(w.toasts.length).toBe(toasts)
  await w.clock.advance(10_000)
  expect(w.status.at(-1)).toBe('NOVA-5 · ' + w.status.at(-1)!.split(' · ')[1])
  expect(w.status.at(-1)).not.toMatch(/RED ALERT/)
})

test('a failed tool call with no mission raises nothing', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: {}, isError: true }) as never)
  await $.session.start(START)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  expect(w.toasts.some(t => t.startsWith('Red alert'))).toBe(false)
})

test('/captains-log writes a session summary from a fork and shows it in the report pane', async ($, on) => {
  const w = world(on)
  const forks: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: '- Added the export button\n\n- Next: tests', usage: {} } } as never
  })
  await $.session.start(START)
  expect((await run($, 'captains-log')).text).toBe("Writing a session summary to the captain's log.")
  await w.clock.settle()
  expect(forks.length).toBe(1)
  expect(w.opened).toContain('fc-report')
  const pane = await $.ui.mount(PANE('fc-report'))
  const texts = (await pane.findAll({ type: "Text" })).map(t => t.text)
  expect(texts.some(t => /^Captain's log, stardate \d{5}\.\d$/.test(t))).toBe(true)
  expect(texts).toContain('- Added the export button')
  expect(texts).toContain('- Next: tests')
  await pane.unmount()
})

test('/captains-log before any reply says there is nothing to log', async ($, on) => {
  const w = world(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  await $.session.start(START)
  await run($, 'captains-log')
  await w.clock.settle()
  expect(w.toasts).toContain('Nothing to log yet: the session has no replies.')
  expect(w.opened).not.toContain('fc-report')
})

test('an interrupted call raises no red alert', async ($, on) => {
  const w = world(on)
  let next: { result: unknown; isError?: true; text?: string } = { result: {} }
  on('tool.call', () => next as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  next = { result: 'Interrupted by user', isError: true, text: 'Interrupted by user' }
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  expect(w.toasts.some(t => t.startsWith('Red alert'))).toBe(false)
  next = { result: 'String not found', isError: true, text: 'String not found' }
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'x', new_string: 'y' } as never)
  expect(w.toasts).toContain('Red alert! Edit failed on NOVA-2.')
})

test('a captain\'s log finished while a report is open does not replace it', async ($, on) => {
  const w = world(on)
  let answer: (v: unknown) => void = () => {}
  on('model.fork', () => new Promise(resolve => { answer = resolve }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await run($, 'captains-log')
  await run($, 'mission', 'complete')
  const opened = w.opened.length
  answer({ value: { isAnswered: true, text: '- Did things', usage: {} } })
  await w.clock.settle()
  expect(w.opened.length).toBe(opened)
  expect(w.toasts.some(t => /^Captain's log, stardate .*, recorded\.$/.test(t))).toBe(true)
  const pane = await $.ui.mount(PANE('fc-report'))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission NOVA-2 complete')
  await pane.unmount()
})

test('/bridge opens a pane with the system, mission, hull, shields and fuel', async ($, on) => {
  const w = world(on)
  on('tool.call', (_$, e) => ({ result: { stdout: '' }, ...((e as { command?: string }).command === 'npm run lint' ? { isError: true } : {}) }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 50_000, percent: 25 }, rateLimits: {}, cost: { usd: 0 } } }) as never)
  await $.session.start(START)
  expect(w.commands).toContain('bridge')
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm run lint' } as never)
  expect((await run($, 'bridge')).text).toBe('Opened the bridge.')
  expect(w.opened).toContain('fc-bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 40))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Mission  NOVA-2 · 0 commits')
  expect(texts.some(t => /^Hull +\[#{10}\] 100%$/.test(t))).toBe(true)
  expect(texts).toContain('Shields  DOWN: lint failing')
  expect(texts.some(t => /^Fuel +\[#+-+\] 75%$/.test(t))).toBe(true)
  for (const t of texts) expect([...t].length).toBeLessThanOrEqual(40)
  await pane.unmount()
})

/** A crew officer spawned through the Agent tool, then its run finishing with `answer`. */
async function crewRun($: any, role: string, agentId: string, answer: string, isAborted = false) {
  await $.agent.spawn({ prompt: 'review', description: 'review', subagentType: `final-commit:${role}` })
  await $.turn.complete({ agentId, answer, durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' })
}

test('session start registers the three crew agent types', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.agents).toEqual(['engineering', 'science', 'tactical'])
})

test('a clean Tactical review after a commit raises mission quality; one with nothing committed does not', async ($, on) => {
  const w = world(on, { branch: 'feature/NOVA-5-x' })
  let nextId = 'a1'
  on('agent.spawn', () => ({ model: 'm', agentId: nextId }) as never)
  on('tool.call', () => ({ result: { stdout: '' } }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await $.tool.call({ tool: 'Bash', command: 'git switch feature/NOVA-5-x' } as never)
  await crewRun($, 'tactical', 'a1', 'Nothing to review.\nVERDICT: CLEAN')
  expect(w.toasts).toContain('Tactical: all clear.')

  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
  nextId = 'a2'
  await crewRun($, 'tactical', 'a2', 'Reviewed 1 commit.\n**VERDICT: CLEAN**')
  expect(w.toasts).toContain('Tactical: all clear. Mission quality up.')
  await run($, 'mission', 'complete')
  const report = await $.ui.mount(PANE('fc-report'))
  expect((await report.findAll({ type: 'Text' })).map(t => t.text)).toContain('Tactical review: all clear')
  await report.unmount()
})

test('a Tactical review with issues says so, and the bridge shows each officer', async ($, on) => {
  const w = world(on)
  on('agent.spawn', (_$, e) => ({ model: 'm', agentId: (e as { subagentType: string }).subagentType === 'final-commit:science' ? 's1' : 't1' }) as never)
  await $.session.start(START)
  await chart($, w, 'NOVA-1', 'Billing export')
  await run($, 'mission', 'NOVA-2')
  await crewRun($, 'tactical', 't1', 'src/a.ts:3 shell injection.\nVERDICT: ISSUES')
  expect(w.toasts).toContain('Tactical: security issues found. See the report.')
  // Science spawned and still running.
  await $.agent.spawn({ prompt: 'q', description: 'q', subagentType: 'final-commit:science' } as never)
  await run($, 'bridge')
  const pane = await $.ui.mount(PANE('fc-bridge', 40))
  const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('Crew')
  expect(texts.some(t => /^ +Engineering +idle$/.test(t))).toBe(true)
  expect(texts.some(t => /^ +Science +busy$/.test(t))).toBe(true)
  expect(texts.some(t => /^ +Tactical +ISSUES FOUND$/.test(t))).toBe(true)
  await pane.unmount()
})

test('agents that are not crew are left alone', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'x1' }) as never)
  await $.session.start(START)
  await $.agent.spawn({ prompt: 'p', description: 'd', subagentType: 'general-purpose' } as never)
  await $.turn.complete({ agentId: 'x1', answer: 'VERDICT: CLEAN', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as never)
  expect(w.toasts.some(t => t.startsWith('Tactical'))).toBe(false)
})
