/**
 * dsh-util-plugs row: context-sentinel
 *
 * One self-contained bundle row that mounts the two runtime components of the
 * former `dsh-context-sentinel` package: context-meter (occupancy tool/status)
 * and team-hooks2 (context archive loop, write policy, delegation advisor,
 * problem loop). The former declarative `preset-context-pro` row is a preset,
 * not a plugin runtime row, so it is not part of this 7-row bundle.
 */
import { apply as applyContextMeter, Config as contextMeterConfig } from '../vendor/context-sentinel/context-meter/index.js'
import { apply as applyTeamHooks, Config as teamHooksConfig } from '../vendor/context-sentinel/team-hooks2/index.js'
import { objectSchema, nested } from '../vendor/context-sentinel/lib/standard-schema.js'

export const inject = ['tools', 'tokenMeter', 'skills']

export const Config = objectSchema({
  contextMeter: nested(contextMeterConfig, {
    description: 'context-meter settings (tool, occupancy watchdog, per-turn [ctx] injection).',
  }),
  teamHooks2: nested(teamHooksConfig, {
    description: 'team-hooks2 settings (archive loop, write policy, delegation advisor, problem loop).',
  }),
}, { description: 'Context Sentinel row: occupancy + team hooks.', schemaVersion: 1 })

export function apply(ctx, config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const contextMeter = source.contextMeter !== null && typeof source.contextMeter === 'object'
    ? source.contextMeter
    : source
  const teamHooks2 = source.teamHooks2 !== null && typeof source.teamHooks2 === 'object'
    ? source.teamHooks2
    : source
  applyContextMeter(ctx, contextMeter)
  applyTeamHooks(ctx, teamHooks2)
}
