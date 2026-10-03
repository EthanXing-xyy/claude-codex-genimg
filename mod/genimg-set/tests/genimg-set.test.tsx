import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  apply,
  configured,
  offered,
  parse,
  toCatalog,
  toSettings,
  toState,
  verdict,
} from '../hooks/settings'

const CACHE = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-sol',
      visibility: 'list',
      supported_reasoning_levels: [
        { effort: 'low' },
        { effort: 'medium' },
        { effort: 'high' },
        { effort: 'ultra' },
      ],
    },
    {
      slug: 'gpt-5.5',
      visibility: 'list',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
    },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [] },
  ],
})
const TOML = 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n\n[tui]\nmodel = "other"\n'
const DRIFT = {
  verified: '0.159.2',
  drift: {
    since: '2026-10-03T23:28:41',
    codex: '0.160.0',
    reasons: ['limits', 'pictures:record=0/store=1'],
    log: 'C:\\tmp\\genimg\\x',
  },
}
const SETTINGS = 'C:\\genimg\\genimg.json'
const STATE = 'C:\\genimg\\genimg.state.json'
const ENV: Record<string, string> = { CODEX_HOME: 'C:\\codex', GENIMG_HOME: 'C:\\genimg' }

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const run = (args: string) =>
  ({
    command: 'genimg-set',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 80 },
  }) as const

/**
 * A machine with codex 0.159.2 on it and the given files; answers what was
 * written and which commands ran.
 */
const world = (
  on: On,
  files: Record<string, string>,
  child: { exitCode: number; stdout: string } = { exitCode: 0, stdout: '' },
  env: Record<string, string> = ENV,
): {
  written: Record<string, string>
  ran: string[][]
  shown: { toasts: string[]; prompts: string[] }
} => {
  const written: Record<string, string> = {}
  const ran: string[][] = []
  const shown = { toasts: [] as string[], prompts: [] as string[] }

  // the band with nothing of a plugin's in it
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>(nothing drawn)</Text>
  })
  on('ui.toast', (_, e) => {
    shown.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    shown.prompts.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.read', (_, e) => {
    const found = written[e.path] ?? files[e.path]

    if (found === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: found }
  })
  on('fs.write', (_, e) => {
    written[e.path] = e.text

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    ran.push([...e.argv])

    return {
      value: {
        exitCode: e.argv[0] === 'codex' ? 0 : child.exitCode,
        stdout: e.argv[0] === 'codex' ? 'codex-cli 0.159.2\n' : child.stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return { written, ran, shown }
}

const BAND = {
  plugin: 'genimg-set',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const FILES = {
  'C:\\codex\\models_cache.json': CACHE,
  'C:\\codex\\config.toml': TOML,
  [SETTINGS]: '{ "model": "", "effort": "low" }',
  [STATE]: '{ "verified": "0.159.2", "drift": null }',
}

test('shows the settings, the model codex follows and a healthy state', async ($, on) => {
  const { written } = world(on, FILES)
  await $.session.start(START)

  const { text = '' } = await $.command.run(run(''))

  expect(text).toMatch(/model\s+follows codex \(gpt-6-sol\)/)
  expect(text).toMatch(/effort\s+low/)
  expect(text).toMatch(/status\s+ok/)
  expect(text).toContain('Efforts: low medium high')
  expect(text).toContain('Models: default gpt-6-sol gpt-5.5')
  expect(text).not.toContain('ultra')
  // what the command prints is plain ASCII
  expect(text).toMatch(/^[\x20-\x7E\n]*$/)
  expect(Object.keys(written)).toEqual([])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`alone, lists codex models above the prompt, then the efforts of the one picked (${surface})`, async ($, on) => {
    const { written, shown } = world(on, FILES)
    await $.session.start(START)
    const ui = await $.ui.mount({ ...BAND, surface })
    const buttons = async (): Promise<string[]> =>
      (await ui.findAll({ type: 'Button' })).map(one => `${one.props.hotkey ?? '-'} ${one.text}`)

    // the band is left to whatever else draws it until the command is typed
    expect(await buttons()).toEqual([])
    expect(await ui.find({ type: 'Text', text: '(nothing drawn)' })).toBeDefined()

    await $.command.run(run(''))

    // every model codex lists and none it hides, a digit each; what is set now is marked
    expect(await buttons()).toEqual([
      '1 default (follows codex: gpt-6-sol)  (current)',
      '2 gpt-6-sol',
      '3 gpt-5.5',
      '0 cancel',
    ])

    await ui.press({ key: 'model:gpt-5.5' })

    // that model's own efforts, and the way back
    expect(await ui.find({ type: 'Text', text: 'effort for gpt-5.5' })).toBeDefined()
    expect(await buttons()).toEqual([
      '1 low  (current)',
      '2 medium',
      '0 cancel',
      '9 back to the models',
    ])

    await ui.press({ key: 'back' })
    await ui.press({ key: 'model:gpt-6-sol' })
    expect(await ui.find({ key: 'effort:ultra' })).toBeUndefined()
    await ui.press({ key: 'effort:high' })

    // set, said, and the band handed back
    expect(toSettings(written[SETTINGS] ?? '')).toEqual({ model: 'gpt-6-sol', effort: 'high' })
    expect(shown.toasts).toEqual(['Model set to gpt-6-sol, effort set to high.'])
    expect(await buttons()).toEqual([])
    expect(await ui.find({ type: 'Text', text: '(nothing drawn)' })).toBeDefined()

    // opened again, the list marks what was just set; default goes back to following
    await $.command.run(run(''))
    expect((await ui.find({ key: 'model:gpt-6-sol' }))?.text).toBe('gpt-6-sol  (current)')
    await ui.press({ key: 'model:default' })
    await ui.press({ key: 'effort:low' })
    expect(toSettings(written[SETTINGS] ?? '')).toEqual({ model: '', effort: 'low' })

    await ui.unmount()
  })
}

test('the list goes away on cancel, on a prompt, and never opens for a typed setting', async ($, on) => {
  const { written } = world(on, FILES)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })

  await $.command.run(run('medium'))
  await $.command.run(run('a b'))
  expect(await ui.findAll({ type: 'Button' })).toEqual([])

  await $.command.run(run(''))
  await ui.press({ key: 'model:gpt-5.5' })
  await ui.press({ key: 'cancel' })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  // cancelled at the second step: the model picked at the first is not set
  expect(toSettings(written[SETTINGS] ?? '')).toEqual({ model: '', effort: 'medium' })

  await $.command.run(run(''))
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await $.prompt.submit({ text: 'draw a fox', origin: { kind: 'composer' }, wait: false })
  expect(await ui.findAll({ type: 'Button' })).toEqual([])

  await ui.unmount()
})

test('sets the model and the effort in one command, either order, either alone', async ($, on) => {
  const { written } = world(on, FILES)
  const kept = (): unknown => toSettings(written[SETTINGS] ?? '')
  await $.session.start(START)

  const both = (await $.command.run(run('gpt-5.5 medium'))).text ?? ''
  expect(both).toContain('Model set to gpt-5.5, effort set to medium.')
  expect(kept()).toEqual({ model: 'gpt-5.5', effort: 'medium' })

  expect((await $.command.run(run('high gpt-6-sol'))).text).toContain(
    'Model set to gpt-6-sol, effort set to high.',
  )
  expect(kept()).toEqual({ model: 'gpt-6-sol', effort: 'high' })

  expect((await $.command.run(run('low'))).text).toContain('Effort set to low.')
  expect(kept()).toEqual({ model: 'gpt-6-sol', effort: 'low' })

  expect((await $.command.run(run('default'))).text).toContain('Model follows codex.')
  expect(kept()).toEqual({ model: '', effort: 'low' })

  // the older spelling still reads
  expect((await $.command.run(run('effort high'))).text).toContain('Effort set to high.')
  expect(kept()).toEqual({ model: '', effort: 'high' })
})

test('changes nothing when codex does not offer what was named', async ($, on) => {
  const { written } = world(on, FILES)
  await $.session.start(START)

  // gpt-5.5 has no high, so neither half is taken
  const refused = (await $.command.run(run('gpt-5.5 high'))).text ?? ''
  expect(refused).toContain('Nothing changed: gpt-5.5 has no effort high. Efforts: low medium')
  expect((await $.command.run(run('gpt-9 low'))).text).toContain(
    'Nothing changed: codex lists no model gpt-9.',
  )
  expect((await $.command.run(run('ultra'))).text).toContain('Nothing changed: ultra')
  expect((await $.command.run(run('low high'))).text).toContain('Could not read "low high"')
  expect((await $.command.run(run('a b'))).text).toContain('Could not read "a b"')
  expect(Object.keys(written)).toEqual([])

  // a model alone is taken, and an effort it lacks is pointed out
  await $.command.run(run('high'))
  const moved = (await $.command.run(run('gpt-5.5'))).text ?? ''
  expect(moved).toContain('Model set to gpt-5.5. Note: it has no effort high.')
})

test('says so when a codex update is unverified, and when the script has drifted', async ($, on) => {
  const files = { ...FILES }
  world(on, files)
  await $.session.start(START)

  files[STATE] = '{ "verified": "0.158.0", "drift": null }'
  expect((await $.command.run(run(''))).text).toContain(
    'codex was updated from 0.158.0; not verified yet',
  )

  files[STATE] = JSON.stringify(DRIFT)
  const text = (await $.command.run(run(''))).text ?? ''
  expect(text).toContain(
    'BROKEN since 2026-10-03T23:28:41 (codex 0.160.0): limits, pictures:record=0/store=1',
  )
  expect(text).toContain('repair genimg')
})

test('works with no files at all', async ($, on) => {
  const { written } = world(on, {})
  await $.session.start(START)

  const text = (await $.command.run(run(''))).text ?? ''
  expect(text).toMatch(/model\s+follows codex\n/)
  expect(text).toContain('not verified yet')
  expect(text).toContain('Efforts: low medium high')

  await $.command.run(run('medium'))
  expect(toSettings(written[SETTINGS] ?? '').effort).toBe('medium')
})

test('with no GENIMG_HOME, the files are the ones in the genimg skill folder', async ($, on) => {
  const skill = 'C:\\Users\\me\\.claude\\skills\\genimg'
  const { written, ran } = world(on, {}, undefined, { USERPROFILE: 'C:\\Users\\me' })
  await $.session.start(START)

  await $.command.run(run('medium'))
  expect(Object.keys(written)).toEqual([`${skill}\\genimg.json`])

  await $.command.run(run('test'))
  expect(ran.at(-1)?.slice(-2)).toEqual([`${skill}\\genimg.ps1`, '-SelfTest'])
})

test('test runs the script once and reads what it printed', async ($, on) => {
  const child = { exitCode: 0, stdout: 'OK x.png 1536x1024 942KB\nDONE 1/1 drawn=1 29s tokens=3973\n' }
  const clock = mock.clock(on)
  const { ran, shown } = world(on, FILES, child)
  await $.session.start(START)

  expect((await $.command.run(run('test'))).text).toContain('Self-test passed')
  expect(ran.at(-1)?.slice(-2)).toEqual(['C:\\genimg\\genimg.ps1', '-SelfTest'])
  // one that passed asks nothing of Claude
  expect(shown.prompts).toEqual([])

  child.exitCode = 2
  child.stdout = 'OK x.png 1536x1024 942KB\nDONE 1/1 drawn=1 30s\nDRIFT limits codex=0.159.2->0.160.0 log=x\n'
  expect((await $.command.run(run('test'))).text).toContain('no longer behaves as verified')
  await clock.advance(500)
  // one that did not is handed to Claude with what the script printed
  expect(shown.prompts).toHaveLength(1)
  expect(shown.prompts[0]).toContain('Repair genimg')
  expect(shown.prompts[0]).toContain('DRIFT limits codex=0.159.2->0.160.0 log=x')

  // so is a failure on a codex version the script was not verified with
  child.exitCode = 1
  child.stdout = 'FAIL codex drew nothing (exit 2) | codex: error: unexpected argument codex=0.159.2->0.160.0 log=x\n'
  expect((await $.command.run(run('test'))).text).toContain('failed after a codex update')
  await clock.advance(500)
  expect(shown.prompts).toHaveLength(2)
  expect(shown.prompts[1]).toContain('unexpected argument codex=0.159.2->0.160.0')

  // a failure on the verified version is codex's own trouble: nothing is handed over
  child.stdout = 'FAIL codex drew nothing (exit 1) | codex: error: stream disconnected log=x\n'
  expect((await $.command.run(run('test'))).text).toContain('more likely codex itself')
  await clock.advance(500)
  expect(shown.prompts).toHaveLength(2)
})

test('reads the asks, the files and the script output', () => {
  expect(parse('')).toEqual({ kind: 'show' })
  expect(parse('  test ')).toEqual({ kind: 'test' })
  expect(parse('gpt-6-sol HIGH')).toEqual({ kind: 'set', model: 'gpt-6-sol', effort: 'high' })
  expect(parse('high  gpt-6-sol')).toEqual({ kind: 'set', model: 'gpt-6-sol', effort: 'high' })
  expect(parse('xhigh')).toEqual({ kind: 'set', effort: 'xhigh' })
  expect(parse('default')).toEqual({ kind: 'set', model: 'default' })
  expect(parse('model gpt-6-sol')).toEqual({ kind: 'set', model: 'gpt-6-sol' })
  expect(parse('effort')).toEqual({ kind: 'unknown', said: 'effort' })
  expect(parse('a b')).toEqual({ kind: 'unknown', said: 'a b' })

  expect(configured(TOML)).toBe('gpt-6-sol')
  expect(configured('[tui]\nmodel = "x"')).toBe('')
  expect(toCatalog(CACHE).map(one => one.slug)).toEqual(['gpt-6-sol', 'gpt-5.5'])
  expect(toCatalog('not json')).toEqual([])
  expect(offered('gpt-6-sol', toCatalog(CACHE))).toEqual(['low', 'medium', 'high'])
  expect(offered('unknown', [])).toEqual(['low', 'medium', 'high'])
  expect(toSettings('')).toEqual({ model: '', effort: 'low' })
  expect(toState(JSON.stringify(DRIFT)).drift?.reasons).toEqual([
    'limits',
    'pictures:record=0/store=1',
  ])
  expect(toState('').drift).toBe(null)
  expect(apply({ model: '', effort: 'low' }, parse('a b'), [], '').note).toContain('Could not read')
  expect(verdict(0, '').text).toContain('Self-test failed')
  expect(verdict(0, 'DONE 1/1 drawn=1 29s')).toEqual({
    isBroken: false,
    text: 'Self-test passed: one picture drawn, every check held.\nDONE 1/1 drawn=1 29s',
  })
  expect(verdict(2, 'DONE 1/1\nDRIFT limits codex=a->b log=x').isBroken).toBe(true)
  expect(verdict(1, 'FAIL x codex=->0.160.0 log=x').isBroken).toBe(true)
  expect(verdict(1, 'FAIL x log=x').isBroken).toBe(false)
})
