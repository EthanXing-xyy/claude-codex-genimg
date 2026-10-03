import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  apply,
  configured,
  efforts,
  models,
  parse,
  repair,
  report,
  toCatalog,
  toSettings,
  toState,
  verdict,
} from './settings'
import type { Ask, Settings } from './settings'
import type { Model } from '../types'

// where genimg.ps1 is when GENIMG_HOME names no other folder: the genimg skill's own
const SKILL = '.claude\\skills\\genimg'
const SETTINGS = 'genimg.json'
const STATE = 'genimg.state.json'
const SCRIPT = 'genimg.ps1'
// a self-test draws one picture; the engine allows a child ten minutes at most
const TEST_MS = 600_000
// The digit that picks a row: the one key a band Button answers to from the
// prompt. Rows past them are reached with the arrows, once the band has the keys.
const HOTKEYS = '123456789'
const CANCEL = '0'
// free on the second step, where a model's efforts take the first few digits
const BACK = '9'
const TOAST_MS = 8000
const HANDOVER_MS = 500

/**
 * What codex offers and what the settings hold, read once per command.
 */
type Known = { catalog: Model[]; preset: string; settings: Settings; home: string }

const picker = atom({ plugin: 'genimg-set', key: 'picker' } as const, null)

const text = async ($: EngineInterface, path: string): Promise<string> => {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const codexHome = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('CODEX_HOME')) ?? `${(await $.env.get('USERPROFILE')) ?? ''}\\.codex`

const genimgHome = async ($: EngineInterface): Promise<string> =>
  (await $.env.get('GENIMG_HOME')) ?? `${(await $.env.get('USERPROFILE')) ?? ''}\\${SKILL}`

const version = async ($: EngineInterface): Promise<string> => {
  try {
    const { stdout } = await $.process.run(['codex', '--version'])

    return stdout.trim().replace(/^\S+\s+/, '')
  } catch {
    return ''
  }
}

/**
 * Starts a turn in which Claude repairs genimg, by the genimg skill.
 */
const handOver = async ($: EngineInterface, said: string): Promise<void> => {
  try {
    await $.prompt.submit({ text: repair(said) })
  } catch (error) {
    $.ui.log(`genimg-set: the repair was not handed over: ${String(error)}`, { to: 'debug' })
  }
}

const selfTest = async ($: EngineInterface): Promise<string> => {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        `${await genimgHome($)}\\${SCRIPT}`,
        '-SelfTest',
      ],
      { timeoutMs: TEST_MS },
    )
    const { isBroken, text: said } = verdict(exitCode, stdout.trim() === '' ? stderr : stdout)

    if (isBroken) {
      // the engine refuses a prompt submitted while this command's hook runs
      $.clock.after(HANDOVER_MS, () => void handOver($, said))
    }

    return said
  } catch (error) {
    return `Self-test could not start: ${String(error)}`
  }
}

const look = async ($: EngineInterface): Promise<Known> => {
  const codex = await codexHome($)
  const home = await genimgHome($)

  return {
    catalog: toCatalog(await text($, `${codex}\\models_cache.json`)),
    preset: configured(await text($, `${codex}\\config.toml`)),
    settings: toSettings(await text($, `${home}\\${SETTINGS}`)),
    home,
  }
}

/**
 * Applies an ask to the settings file; answers the settings after it and what
 * to tell the person.
 */
const set = async (
  $: EngineInterface,
  ask: Ask,
  known: Known,
): Promise<{ settings: Settings; note: string }> => {
  const applied = apply(known.settings, ask, known.catalog, known.preset)

  if (applied.settings !== known.settings) {
    await $.fs.write(
      `${known.home}\\${SETTINGS}`,
      `${JSON.stringify(applied.settings, null, 2)}\n`,
    )
  }

  return applied
}

const answer = async ($: EngineInterface, ask: Ask, known: Known): Promise<string> => {
  const { settings, note } = await set($, ask, known)

  return report(
    {
      settings,
      state: toState(await text($, `${known.home}\\${STATE}`)),
      catalog: known.catalog,
      preset: known.preset,
      version: await version($),
    },
    note,
  )
}

/**
 * Opens the picker on its first step. It is drawn in the band above the
 * prompt, where a bare digit typed into an empty prompt presses its row.
 */
const offer = async ($: EngineInterface, known: Known): Promise<void> => {
  const { catalog, preset, settings } = known

  // the folder is not kept: a pick asks for it again
  await update($, picker, () => ({
    catalog,
    preset,
    model: settings.model,
    effort: settings.effort,
    picked: null,
  }))
}

const dismiss = async ($: EngineInterface): Promise<void> => {
  if ((await read($, picker)) !== null) {
    await update($, picker, () => null)
  }
}

const pickModel = async ($: EngineInterface, picked: string | null): Promise<void> => {
  await update($, picker, held => (held === null ? held : { ...held, picked }))
}

const pickEffort = async ($: EngineInterface, effort: string): Promise<void> => {
  const held = await read($, picker)

  if (held === null || held.picked === null) {
    return
  }

  const home = await genimgHome($)
  const known = { ...held, home, settings: toSettings(await text($, `${home}\\${SETTINGS}`)) }
  const { note } = await set($, { kind: 'set', model: held.picked, effort }, known)

  await dismiss($)
  $.ui.toast(note, { timeoutMs: TOAST_MS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'genimg-set',
      description: 'Pick the codex model and effort genimg draws with',
      argumentHint: '[<model|default>] [<effort>] | test',
    })

    return next(e)
  })

  on('command.run', { command: 'genimg-set' }, async ($, e) => {
    const ask = parse(e.args)

    if (ask.kind === 'test') {
      return { text: await selfTest($) }
    }

    const known = await look($)
    const said = await answer($, ask, known)

    if (ask.kind === 'show') {
      await offer($, known)
    }

    return { text: said }
  })

  // a prompt sent while the picker is up takes it down, as it does a dialog
  on('prompt.submit', async ($, e, next) => {
    await dismiss($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const held = await read($, picker)

    if (held === null || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const picked = held.picked
    const rows = picked === null ? models(held) : efforts(held)
    // once the band has the keys, the ring starts on what the settings hold
    const start = rows.find(one => one.isCurrent) ?? rows[0]

    return (
      <Box flexDirection="column">
        <Text bold>
          {picked === null
            ? 'genimg-set, step 1 of 2: model'
            : `genimg-set, step 2 of 2: effort for ${picked}`}
        </Text>
        {rows.map((one, i) => (
          <Button
            key={`${picked === null ? 'model' : 'effort'}:${one.value}`}
            label={one.isCurrent ? `${one.label}  (current)` : one.label}
            plain
            {...(HOTKEYS[i] === undefined ? {} : { hotkey: HOTKEYS[i] })}
            {...(one === start ? { autoFocus: true as const } : {})}
            onPress={() =>
              picked === null ? pickModel($, one.value) : pickEffort($, one.value)
            }
          />
        ))}
        <Box columnGap={3}>
          <Button key="cancel" label="cancel" plain hotkey={CANCEL} onPress={() => dismiss($)} />
          {picked === null || rows.length >= HOTKEYS.length
            ? []
            : [
                <Button
                  key="back"
                  label="back to the models"
                  plain
                  hotkey={BACK}
                  onPress={() => pickModel($, null)}
                />,
              ]}
          <Text dimColor>Type the number. For the arrows and Enter, ctrl+x tab first.</Text>
        </Box>
      </Box>
    )
  })
}
