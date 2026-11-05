/**
 * dsh-util-plugs package-root entry.
 *
 * The bundle's seven plugin rows are subpath entries (`dsh-util-plugs/plugins/*`).
 * The DSH client module system keys a package's Web client row by the package
 * root entry, so the `workbench-bundle` row deliberately mounts THIS module:
 * that makes `dsh-util-plugs` a loader entry and exposes the package's single
 * `dsh.client` half (message center + restart button) to the browser.
 *
 * The workbench row's runtime implementation lives in vendor/workbench-bundle.
 */
export { apply, Config, inject } from './vendor/workbench-bundle/plugin.js'
