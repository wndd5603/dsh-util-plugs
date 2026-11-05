#!/usr/bin/env node
/**
 * Assemble the single Web client bundle for dsh-util-plugs.
 *
 * The bundle ships one `./client` module but THREE browser halves:
 * - `vendor/message-bus/lib/client.js` — the sidebar Messages page;
 * - `vendor/host-relaunch/lib/client.js` — the conversation-header restart button.
 *
 * Both halves are zero-toolchain `window.__ModuleLoader__.load({id, factory})`
 * registrations produced by their source packages (`scripts/build-client.mjs`).
 * This script extracts each factory body (the module body between the React
 * require and the `return module.exports`) and composes them into ONE
 * registration whose id is the bundle package name (`dsh-util-plugs`): the client
 * module system keys a package's client row by its package name, so a single
 * composed factory is required.
 *
 * Usage: node scripts/build-client.mjs   (writes client.js)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

/** Extract one built half's module body and normalize its export tail to a return. */
function factoryBody(relativePath) {
  const text = readFileSync(join(repoRoot, relativePath), 'utf8')
  const startMarker = 'const React = require("react");'
  const endMarker = '\t\treturn module.exports;'
  const start = text.indexOf(startMarker)
  const end = text.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(relativePath + ': not a built module-loader client half')
  }
  let body = text.slice(start + startMarker.length, end)
  body = body.replace(/^\s*exports\.(apply|inject) = (apply|inject)\s*;?\s*$/gm, '')
  body = body.replace(/\s+$/, '')
  if (/\bexports\./.test(body)) throw new Error(relativePath + ': unexpected exports reference inside factory body')
  return body
}

function half(name, relativePath) {
  return [
    `\t\t// ${name} client half (source: ${relativePath})`,
    `\t\tconst ${name} = (() => {`,
    factoryBody(relativePath),
    '\t\t\treturn { apply, inject }',
    '\t\t})()',
  ].join('\n')
}

const halves = [
  half('messageCenter', 'vendor/message-bus/lib/client.js'),
  half('hostRelaunch', 'vendor/host-relaunch/lib/client.js'),
  half('pluginConsole', 'vendor/plugin-console/lib/client.js'),
]

const bundle = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tconst React = require("react");

${halves.join('\n\n')}

\t\t// Compose both browser halves into the bundle's single client module.
\t\tfunction apply(ctx) {
\t\t\tmessageCenter.apply(ctx);
\t\t\thostRelaunch.apply(ctx);
\t\t\tpluginConsole.apply(ctx);
\t\t}
\t\tconst inject = [...new Set([...messageCenter.inject, ...hostRelaunch.inject, ...pluginConsole.inject])];
\t\texports.apply = apply;
\t\texports.inject = inject;

\t\treturn module.exports;
\t}
});
//# sourceURL=${pkg.name}/client.js
`
writeFileSync(join(repoRoot, 'client.js'), bundle, 'utf8')
console.log('built ' + pkg.name + ': client.js (' + Buffer.byteLength(bundle) + ' bytes, 3 client halves)')
