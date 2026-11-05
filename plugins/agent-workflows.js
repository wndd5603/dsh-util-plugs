/**
 * dsh-plugs row: agent-workflows
 *
 * Mounts the two runtime plugins shipped by `dsh-agent-workflows`: the captain
 * workflow tools (team_init/team_members_check) and the prompt-forge tools/skill.
 * The former declarative preset rows are presets, not plugin runtime rows, so
 * this 8-row bundle does not duplicate them as separate plugin-manager rows.
 */
import { apply as applyCaptain, Config as captainConfig } from '../vendor/agent-workflows/captain-preset/plugin.js'
import { apply as applyPromptArchitect, Config as promptArchitectConfig } from '../vendor/agent-workflows/prompt-architect/index.js'
import { objectSchema, nested } from '../vendor/agent-workflows/lib/standard-schema.js'

export const inject = ['tools']

export const Config = objectSchema({
  captain: nested(captainConfig, { description: 'Captain workflow tools (team_init / team_members_check).' }),
  promptArchitect: nested(promptArchitectConfig, { description: 'Prompt-forge workflow tools and runtime skill.' }),
}, { description: 'Agent workflows row: captain + prompt-forge.', schemaVersion: 1 })

export function apply(ctx, config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const captain = source.captain !== null && typeof source.captain === 'object' ? source.captain : source
  const promptArchitect = source.promptArchitect !== null && typeof source.promptArchitect === 'object'
    ? source.promptArchitect
    : source
  applyCaptain(ctx, captain)
  applyPromptArchitect(ctx, promptArchitect)
}
