import type { Model, Picker } from '../types'

export type Settings = { model: string; effort: string }

/**
 * One row of the picker: what a pick of it sets, the text drawn, and
 * whether it is what the settings hold now.
 */
export type Choice = { value: string; label: string; isCurrent: boolean }

/**
 * What genimg.ps1 left in its state file when codex stopped behaving the way
 * the script was verified with.
 */
export type Drift = { since: string; codex: string; reasons: string[]; log: string }

export type State = { verified: string; drift: Drift | null }

/**
 * What the person typed after the command: nothing, `test`, or a model and an
 * effort in either order, either one alone.
 */
export type Ask =
  | { kind: 'show' }
  | { kind: 'test' }
  | { kind: 'set'; model?: string; effort?: string }
  | { kind: 'unknown'; said: string }

export type Facts = {
  settings: Settings
  state: State
  catalog: readonly Model[]
  preset: string
  version: string
}

const BASIC = ['low', 'medium', 'high']
// every effort codex has a name for: how a word is told from a model's name
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
// hands the work to sub-agents, whose pictures the script cannot follow
const DELEGATING = 'ultra'
// the model setting that leaves the choice to codex's own config
const FOLLOWING = 'default'
const USAGE = [
  'Usage: /genimg-set alone opens a list to pick from; or /genimg-set <model> <effort>',
  '(either one alone, in either order; `default` follows codex); /genimg-set test draws one test picture',
].join('\n')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const read = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const word = (value: unknown): string => (typeof value === 'string' ? value : '')

export const toSettings = (text: string): Settings => {
  const found = read(text)

  return isRecord(found)
    ? { model: word(found.model), effort: word(found.effort) || 'low' }
    : { model: '', effort: 'low' }
}

export const toState = (text: string): State => {
  const found = read(text)

  if (!isRecord(found)) {
    return { verified: '', drift: null }
  }

  const drift = found.drift

  return {
    verified: word(found.verified),
    drift: isRecord(drift)
      ? {
          since: word(drift.since),
          codex: word(drift.codex),
          reasons: Array.isArray(drift.reasons) ? drift.reasons.map(String) : [],
          log: word(drift.log),
        }
      : null,
  }
}

/**
 * The models codex offers in its picker, from its own models cache.
 */
export const toCatalog = (text: string): Model[] => {
  const found = read(text)
  const rows = isRecord(found) ? found.models : undefined

  if (!Array.isArray(rows)) {
    return []
  }

  return rows.flatMap((row: unknown): Model[] => {
    if (!isRecord(row) || row.visibility !== 'list' || word(row.slug) === '') {
      return []
    }

    const levels = Array.isArray(row.supported_reasoning_levels)
      ? row.supported_reasoning_levels
      : []

    return [
      {
        slug: word(row.slug),
        efforts: levels.flatMap((one: unknown) =>
          isRecord(one) && word(one.effort) !== '' ? [word(one.effort)] : [],
        ),
      },
    ]
  })
}

/**
 * The model codex's own config.toml names: the one a blank setting follows.
 */
export const configured = (toml: string): string => {
  const top = toml.split(/^\s*\[/m)[0] ?? ''

  return /^\s*model\s*=\s*"([^"]*)"/m.exec(top)?.[1] ?? ''
}

export const parse = (args: string): Ask => {
  // `model` and `effort` may be written before their value; they add nothing
  const words = args
    .trim()
    .split(/\s+/)
    .filter(one => one !== '' && one !== 'model' && one !== 'effort')

  if (words.length === 0) {
    return args.trim() === '' ? { kind: 'show' } : { kind: 'unknown', said: args.trim() }
  }

  if (words.length === 1 && words[0] === 'test') {
    return { kind: 'test' }
  }

  const efforts = words.filter(one => EFFORTS.includes(one.toLowerCase()))
  const models = words.filter(one => !EFFORTS.includes(one.toLowerCase()))

  if (efforts.length > 1 || models.length > 1) {
    return { kind: 'unknown', said: args.trim() }
  }

  return {
    kind: 'set',
    ...(models[0] === undefined ? {} : { model: models[0] }),
    ...(efforts[0] === undefined ? {} : { effort: efforts[0].toLowerCase() }),
  }
}

/**
 * The efforts a model may be set to here.
 */
export const offered = (slug: string, catalog: readonly Model[]): string[] => {
  const efforts = catalog.find(one => one.slug === slug)?.efforts ?? []

  return (efforts.length > 0 ? efforts : BASIC).filter(one => one !== DELEGATING)
}

/**
 * The picker's first step: following codex, then each model codex lists.
 */
export const models = (picker: Picker): Choice[] => [
  {
    value: FOLLOWING,
    label: picker.preset === '' ? 'default (follows codex)' : `default (follows codex: ${picker.preset})`,
    isCurrent: picker.model === '',
  },
  ...picker.catalog.map(one => ({
    value: one.slug,
    label: one.slug,
    isCurrent: one.slug === picker.model,
  })),
]

/**
 * The picker's second step: the efforts the picked model may be set to here.
 */
export const efforts = (picker: Picker): Choice[] =>
  offered(
    picker.picked === null || picker.picked === FOLLOWING ? picker.preset : picker.picked,
    picker.catalog,
  ).map(one => ({ value: one, label: one, isCurrent: one === picker.effort }))

/**
 * The settings after an ask, and what to tell the person about it. An ask
 * that names anything codex does not offer changes nothing, and the settings
 * come back as they were.
 */
export const apply = (
  settings: Settings,
  ask: Ask,
  catalog: readonly Model[],
  preset: string,
): { settings: Settings; note: string } => {
  if (ask.kind === 'unknown') {
    return { settings, note: `Could not read "${ask.said}"; nothing changed.` }
  }

  if (ask.kind !== 'set') {
    return { settings, note: '' }
  }

  const model =
    ask.model === undefined ? settings.model : ask.model === FOLLOWING ? '' : ask.model
  const choices = offered(model || preset, catalog)

  if (model !== '' && catalog.length > 0 && !catalog.some(one => one.slug === model)) {
    return {
      settings,
      note: `Nothing changed: codex lists no model ${model}. Models: ${catalog.map(one => one.slug).join(' ')}`,
    }
  }

  if (ask.effort === DELEGATING) {
    return {
      settings,
      note: 'Nothing changed: ultra hands the work to sub-agents, whose pictures the script cannot follow.',
    }
  }

  if (ask.effort !== undefined && !choices.includes(ask.effort)) {
    return {
      settings,
      note: `Nothing changed: ${model || preset || 'this model'} has no effort ${ask.effort}. Efforts: ${choices.join(' ')}`,
    }
  }

  const effort = ask.effort ?? settings.effort
  const said = [
    ...(ask.model === undefined ? [] : [model === '' ? 'model follows codex' : `model set to ${model}`]),
    ...(ask.effort === undefined ? [] : [`effort set to ${effort}`]),
  ].join(', ')
  const done = `${said.charAt(0).toUpperCase()}${said.slice(1)}.`

  return {
    settings: { model, effort },
    note: choices.includes(effort)
      ? done
      : `${done} Note: it has no effort ${effort}. Efforts: ${choices.join(' ')}`,
  }
}

const health = (state: State, version: string): string => {
  if (state.drift !== null) {
    const { since, codex, reasons, log } = state.drift

    return [
      `BROKEN since ${since} (codex ${codex}): ${reasons.join(', ')}`,
      `           log ${log}`,
      '           Tell Claude "repair genimg"; the genimg skill holds the procedure.',
    ].join('\n')
  }

  if (version === '') {
    return 'codex not found'
  }

  if (state.verified === '') {
    return 'not verified yet; checked on the next picture'
  }

  return state.verified === version
    ? 'ok'
    : `codex was updated from ${state.verified}; not verified yet, checked on the next picture`
}

export const report = (facts: Facts, note: string): string => {
  const { settings, state, catalog, preset, version } = facts
  const follows = preset === '' ? 'follows codex' : `follows codex (${preset})`

  return [
    ...(note === '' ? [] : [note, '']),
    `  model    ${settings.model === '' ? follows : settings.model}`,
    `  effort   ${settings.effort}`,
    `  codex    ${version === '' ? '?' : version}`,
    `  status   ${health(state, version)}`,
    '',
    ...(catalog.length === 0
      ? []
      : [`Models: ${FOLLOWING} ${catalog.map(one => one.slug).join(' ')}`]),
    `Efforts: ${offered(settings.model || preset, catalog).join(' ')}`,
    USAGE,
  ].join('\n')
}

/**
 * What a self-test of genimg.ps1 came to, from what it printed: what to tell
 * the person, and whether the script is broken, which is Claude's to repair.
 *
 * Broken is a DRIFT, or a FAIL on a codex version other than the one the
 * script was verified with (the script says `codex=<verified>-><now>`). A
 * FAIL on the verified version is codex's own trouble (network, login,
 * quota), which no repair of the script mends.
 */
export const verdict = (exitCode: number, printed: string): { isBroken: boolean; text: string } => {
  const lines = printed
    .split(/\r?\n/)
    .map(one => one.trim())
    .filter(one => /^(DONE|DRIFT|FAIL|MISS)\b/.test(one))
  const shown = lines.length > 0 ? lines.join('\n') : printed.trim()

  if (lines.some(one => one.startsWith('DRIFT'))) {
    return {
      isBroken: true,
      text: `Self-test: codex no longer behaves as verified; the picture was taken by the fallback. Claude is asked to repair genimg.\n${shown}`,
    }
  }

  if (exitCode === 0 && lines.some(one => one.startsWith('DONE'))) {
    return { isBroken: false, text: `Self-test passed: one picture drawn, every check held.\n${shown}` }
  }

  return lines.some(one => /\bcodex=\S*->\S+/.test(one))
    ? {
        isBroken: true,
        text: `Self-test failed after a codex update. Claude is asked to repair genimg.\n${shown}`,
      }
    : {
        isBroken: false,
        text: `Self-test failed on the codex version it was verified with: more likely codex itself (network, login, quota) than the script. Tell Claude "repair genimg" to have it looked at anyway.\n${shown}`,
      }
}

/**
 * The prompt that hands a broken script to Claude; the genimg skill answers
 * to "repair genimg".
 */
export const repair = (said: string): string =>
  `The genimg self-test did not pass. Repair genimg, following the genimg skill's procedure.\n\n${said}`
