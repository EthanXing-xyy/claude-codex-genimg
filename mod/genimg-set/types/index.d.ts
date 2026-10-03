export type Model = { slug: string; efforts: string[] }

/**
 * What the picker above the prompt draws from: codex's models, the model its
 * own config names, the settings as they stood when it opened, and the model
 * picked at the first step (null before it). Null while no picker is up.
 */
export type Picker = {
  catalog: Model[]
  preset: string
  model: string
  effort: string
  picked: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'genimg-set': { picker: Picker | null }
  }
}
