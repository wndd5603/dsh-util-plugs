/**
 * dsh-util-plugs row: agent-workflows
 *
 * DSH-native teams/session identity are authoritative. This row keeps only the
 * non-conflicting prompt-forge workflow tools/skill; the former captain
 * team_init/team_members_check tools are retired.
 */
import { apply as applyPromptArchitect, Config as promptArchitectConfig } from '../vendor/agent-workflows/prompt-architect/index.js'
import { objectSchema, nested } from '../vendor/agent-workflows/lib/standard-schema.js'

export const inject = ['tools']

export const Config = objectSchema({
  promptArchitect: nested(promptArchitectConfig, { description: 'Prompt-forge workflow tools and runtime skill.' }),
}, { description: 'Agent workflows row: prompt-forge only (native DSH teams are authoritative).', schemaVersion: 1 })

export function apply(ctx, config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const promptArchitect = source.promptArchitect !== null && typeof source.promptArchitect === 'object'
    ? source.promptArchitect
    : source
  applyPromptArchitect(ctx, promptArchitect)
}
