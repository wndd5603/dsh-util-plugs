/**
 * Zero-dependency Standard Schema v1 config builder for DSH/Cordis plugins.
 *
 * Why this exists
 * ---------------
 * The host validates a plugin's exported `Config` through the Standard Schema
 * interface (`Config['~standard'].validate(raw)`), see the DSH implementation
 * `vendor/cordis/src/fiber.ts` (`resolveConfig`) — no npm package is required
 * to participate. This module implements the interface directly, so a local
 * bundle can declare a real Config schema, honour defaults, and fail loudly on
 * invalid values **without adding a dependency**.
 *
 * Scope / known limitation
 * ------------------------
 * Cordis also projects *native Schemastery* schemas into the Web config editor
 * (`packages/boot/app-boot/src/config-schema/native.ts`). The root object built
 * here exposes the native graph fields (type/meta/dict/inner/sKey/list/value) in
 * addition to Standard Schema validate, so both runtime validation and the
 * settings form projection work.
 */

const VENDOR = 'dsh-agent-workbench'

/* ------------------------------------------------------------------ fields */

export function boolean(defaultValue, meta = {}) {
  return { kind: 'boolean', default: defaultValue, ...meta }
}

export function number(defaultValue, meta = {}) {
  return { kind: 'number', default: defaultValue, ...meta }
}

export function string(defaultValue, meta = {}) {
  return { kind: 'string', default: defaultValue, ...meta }
}

export function stringArray(defaultValue, meta = {}) {
  return { kind: 'string-array', default: defaultValue, ...meta }
}

/** Free-form object (keys and values kept as-is). */
export function record(defaultValue, meta = {}) {
  return { kind: 'record', default: defaultValue, ...meta }
}

export function enumOf(defaultValue, values, meta = {}) {
  return { kind: 'enum', values, default: defaultValue, ...meta }
}

/** Nested object schema (recursively validated, defaults applied). */
export function nested(schema, meta = {}) {
  return { kind: 'nested', schema, ...meta }
}

/** Any JSON-compatible value; useful for forward-compatible escape hatches. */
export function any(defaultValue, meta = {}) {
  return { kind: 'any', default: defaultValue, ...meta }
}

/* ---------------------------------------------------------------- helpers */

function clone(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => clone(item))
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = clone(item)
  return out
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function issue(issues, message, path) {
  issues.push(path.length === 0 ? { message } : { message, path })
}

function nullableOf(field) {
  if (typeof field.nullable === 'boolean') return field.nullable
  return field.default === null || field.kind === 'any' || field.kind === 'record'
}

function validateField(field, key, raw, path, issues) {
  switch (field.kind) {
    case 'boolean':
      if (typeof raw !== 'boolean') {
        issue(issues, `"${key}" must be a boolean`, path)
        return undefined
      }
      return raw
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        issue(issues, `"${key}" must be a finite number`, path)
        return undefined
      }
      if (field.int === true && !Number.isInteger(raw)) {
        issue(issues, `"${key}" must be an integer`, path)
        return undefined
      }
      if (typeof field.min === 'number' && raw < field.min) {
        issue(issues, `"${key}" must be >= ${field.min}`, path)
        return undefined
      }
      if (typeof field.max === 'number' && raw > field.max) {
        issue(issues, `"${key}" must be <= ${field.max}`, path)
        return undefined
      }
      return raw
    }
    case 'string': {
      if (typeof raw !== 'string') {
        issue(issues, `"${key}" must be a string`, path)
        return undefined
      }
      if (typeof field.minLength === 'number' && raw.length < field.minLength) {
        issue(issues, `"${key}" must be at least ${field.minLength} characters`, path)
        return undefined
      }
      if (typeof field.maxLength === 'number' && raw.length > field.maxLength) {
        issue(issues, `"${key}" must be at most ${field.maxLength} characters`, path)
        return undefined
      }
      return raw
    }
    case 'string-array': {
      if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) {
        issue(issues, `"${key}" must be an array of strings`, path)
        return undefined
      }
      return [...raw]
    }
    case 'enum':
      if (!field.values.includes(raw)) {
        issue(issues, `"${key}" must be one of ${field.values.map(value => JSON.stringify(value)).join(', ')}`, path)
        return undefined
      }
      return raw
    case 'record':
      if (!isPlainObject(raw)) {
        issue(issues, `"${key}" must be an object`, path)
        return undefined
      }
      return clone(raw)
    case 'nested': {
      const result = field.schema['~standard'].validate(raw)
      if (result.issues) {
        for (const nestedIssue of result.issues) {
          issue(issues, nestedIssue.message, [...path, ...(nestedIssue.path ?? [])])
        }
        return undefined
      }
      return result.value
    }
    case 'any':
      return clone(raw)
    default:
      issue(issues, `"${key}" has an unsupported schema kind`, path)
      return undefined
  }
}

/* ------------------------------------------------------------ object schema */

/** Schemastery identity marker used by the host's native schema checks. */
const NATIVE_MARKER = Symbol.for('schemastery')

/** Build the `meta` object the host reads for form labels/defaults/ranges. */
function nativeMeta(field) {
  const meta = {}
  if (field.default !== undefined) meta.default = clone(field.default)
  if (field.required === true) meta.required = true
  if (typeof field.description === 'string') meta.description = field.description
  if (typeof field.min === 'number') meta.min = field.min
  if (typeof field.max === 'number') meta.max = field.max
  if (field.int === true) meta.step = 1
  if (typeof field.minLength === 'number') meta.min = field.minLength
  if (typeof field.maxLength === 'number') meta.max = field.maxLength
  return meta
}

/**
 * Build the native Schemastery graph node for one field. The host projects this
 * graph into JSON Schema for the Web settings form; the Standard Schema on the
 * root object remains the runtime validator. Node shapes mirror
 * `packages/boot/app-boot/src/config-schema/types.ts` (NativeConfigSchema).
 */
function nativeNode(field) {
  const node = { [NATIVE_MARKER]: true, meta: nativeMeta(field) }
  switch (field.kind) {
    case 'boolean':
      node.type = 'boolean'
      return node
    case 'number':
      node.type = 'number'
      return node
    case 'string':
      node.type = 'string'
      return node
    case 'enum':
      node.type = 'union'
      node.list = field.values.map(value => ({ [NATIVE_MARKER]: true, type: 'const', meta: {}, value }))
      return node
    case 'string-array':
      node.type = 'array'
      node.inner = { [NATIVE_MARKER]: true, type: 'string', meta: {} }
      return node
    case 'record':
      node.type = 'dict'
      node.inner = { [NATIVE_MARKER]: true, type: 'any', meta: {} }
      return node
    case 'any':
      node.type = 'any'
      return node
    case 'nested': {
      const objectNode = {
        [NATIVE_MARKER]: true,
        type: 'object',
        meta: field.allowFalse === true ? {} : nativeMeta(field),
        dict: Object.fromEntries(Object.entries(field.schema.fields).map(([key, child]) => [key, nativeNode(child)])),
      }
      if (field.allowFalse === true) {
        // `roleWritePolicy: false` / `delegationAdvisor: false` whole-block switch:
        // project as union(object, false) so the form offers a valid graph.
        node.type = 'union'
        node.list = [objectNode, { [NATIVE_MARKER]: true, type: 'const', meta: {}, value: false }]
        return node
      }
      return objectNode
    }
    default:
      node.type = 'any'
      return node
  }
}

/**
 * Build one config schema that is BOTH:
 * - a Standard Schema v1 validator (`~standard.validate`, used by Cordis runtime), and
 * - a native Schemastery graph (`Symbol.for('schemastery')`, `type`, `meta`, `dict`),
 *   which the host's config-schema projector turns into a settings form.
 * Unknown keys are preserved (forward compatibility with newer patches).
 * @param {Record<string, object>} shape - field name -> field builder result
 * @param {{ description?: string, schemaVersion?: number }} [options]
 */
export function objectSchema(shape, options = {}) {
  const schema = {
    description: options.description,
    fields: shape,
    [NATIVE_MARKER]: true,
    type: 'object',
    meta: typeof options.description === 'string' ? { description: options.description } : {},
    dict: Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, nativeNode(field)])),
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate(value) {
        const issues = []
        const source = value === undefined || value === null ? {} : value
        if (!isPlainObject(source)) {
          return { issues: [{ message: 'config must be an object' }] }
        }
        const out = {}
        // Preserve unknown keys so patch overlays written for newer versions
        // never get silently dropped by an older package revision.
        for (const [key, raw] of Object.entries(source)) {
          if (!Object.hasOwn(shape, key)) out[key] = clone(raw)
        }
        for (const [key, field] of Object.entries(shape)) {
          const raw = source[key]
          if (raw === undefined) {
            if (field.required === true) {
              issue(issues, `"${key}" is required`, [key])
              continue
            }
            if (field.kind === 'nested') {
              out[key] = defaultsOf(field.schema)
            } else if (field.default !== undefined) {
              out[key] = clone(field.default)
            }
            continue
          }
          // `false` can be a documented whole-block disable switch (e.g.
          // `roleWritePolicy: false`); opt in per field to keep type safety.
          if (raw === false && field.allowFalse === true) {
            out[key] = false
            continue
          }
          if (raw === null) {
            if (nullableOf(field)) {
              out[key] = null
            } else {
              issue(issues, `"${key}" must not be null`, [key])
            }
            continue
          }
          const validated = validateField(field, key, raw, [key], issues)
          if (validated !== undefined) out[key] = validated
        }
        if (typeof options.schemaVersion === 'number'
          && typeof out.schemaVersion === 'number'
          && out.schemaVersion > options.schemaVersion) {
          issue(issues, `"schemaVersion" ${out.schemaVersion} is newer than this package supports (${options.schemaVersion})`, ['schemaVersion'])
        }
        return issues.length > 0 ? { issues } : { value: out }
      },
    },
  }
  return schema
}

/* ------------------------------------------------------------------ derived */

/** Deep default object derived from the schema shape (nested schemas recurse). */
export function defaultsOf(schema) {
  const out = {}
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.kind === 'nested') {
      out[key] = defaultsOf(field.schema)
    } else if (field.default !== undefined) {
      out[key] = clone(field.default)
    }
  }
  return out
}

/** Documentation rows for status tools / README tables. */
export function fieldDocs(schema) {
  return Object.entries(schema.fields).map(([key, field]) => ({
    key,
    kind: field.kind,
    default: field.kind === 'nested' ? defaultsOf(field.schema) : field.default,
    required: field.required === true,
    description: typeof field.description === 'string' ? field.description : null,
    ...(field.kind === 'enum' ? { values: [...field.values] } : {}),
  }))
}

/** Convenience wrapper matching the host call shape. */
export function validateConfig(schema, value) {
  return schema['~standard'].validate(value)
}
