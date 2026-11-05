/**
 * Host half of `dsh-plugin-console`.
 *
 * The console is a browser-only feature for this MVP: the Loader row must exist
 * so the client module system scans the package's `dsh.client` declaration and
 * serves `./client`, while the host half intentionally registers nothing. A
 * later phase adds the `pluginConsole` Remote for host-provided status and
 * actions (see the public README and CAPABILITY_AUDIT.md).
 */

/** No host-side services are registered in the MVP. */
export function apply() {}

/** Loader diagnostics label for this plugin. */
export const name = 'plugin-console'
