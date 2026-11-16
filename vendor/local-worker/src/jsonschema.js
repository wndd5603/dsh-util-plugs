/**
 * Small deterministic JSON-Schema checker used by `local_task_validate`.
 *
 * It intentionally supports a practical subset rather than every draft
 * keyword: type (including an array of types), enum/const, object
 * properties/required/additionalProperties, array items/minItems/maxItems,
 * string length/pattern, numeric bounds, and oneOf/anyOf/allOf. Unknown
 * keywords are ignored so a schema written for a full validator still gives
 * useful structural feedback. The local LLM handles semantic rules.
 */

const MAX_ERRORS = 20

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function valueType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function matchesType(value, type) {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function addError(errors, path, message) {
  if (errors.length < MAX_ERRORS) errors.push({ path, message })
}

function walk(value, schema, path, errors) {
  if (errors.length >= MAX_ERRORS || !isPlainObject(schema)) return

  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) {
    addError(errors, path, `must equal ${JSON.stringify(schema.const)}`)
    return
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => deepEqual(value, candidate))) {
    addError(errors, path, `must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`)
    return
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) walk(value, branch, path, errors)
  }
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map(branch => {
      const local = []
      walk(value, branch, path, local)
      return local
    })
    if (branchErrors.every(local => local.length > 0)) {
      addError(errors, path, `does not match any allowed shape (${schema.anyOf.length} variants)`)
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(branch => {
      const local = []
      walk(value, branch, path, local)
      return local.length === 0
    }).length
    if (matched !== 1) addError(errors, path, `must match exactly one shape; matched ${matched}`)
  }

  if (Object.hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(value, type))) {
      addError(errors, path, `expected ${types.join(' or ')}, got ${valueType(value)}`)
      return
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      addError(errors, path, `must have at least ${schema.minLength} characters`)
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      addError(errors, path, `must have at most ${schema.maxLength} characters`)
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) addError(errors, path, `must match /${schema.pattern}/`)
      } catch {
        // A bad pattern is a schema authoring problem; ignore it rather than
        // turning a validation call into a crash.
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      addError(errors, path, `must be >= ${schema.minimum}`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      addError(errors, path, `must be <= ${schema.maximum}`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      addError(errors, path, `must be > ${schema.exclusiveMinimum}`)
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      addError(errors, path, `must be < ${schema.exclusiveMaximum}`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      addError(errors, path, `must contain at least ${schema.minItems} items`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      addError(errors, path, `must contain at most ${schema.maxItems} items`)
    }
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      value.forEach((item, index) => walk(item, schema.items, `${path}[${index}]`, errors))
    }
  }

  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === 'string' && !Object.hasOwn(value, key)) {
          addError(errors, path === '$' ? `$.${key}` : `${path}.${key}`, 'is required')
        }
      }
    }
    if (isPlainObject(schema.properties)) {
      for (const [key, child] of Object.entries(schema.properties)) {
        if (Object.hasOwn(value, key)) {
          walk(value[key], child, path === '$' ? `$.${key}` : `${path}.${key}`, errors)
        }
      }
    }
    if (schema.additionalProperties === false && isPlainObject(schema.properties)) {
      const declared = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) {
          addError(errors, path === '$' ? `$.${key}` : `${path}.${key}`, 'is not a declared property')
        }
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      const declared = new Set(isPlainObject(schema.properties) ? Object.keys(schema.properties) : [])
      for (const key of Object.keys(value)) {
        if (!declared.has(key)) {
          walk(value[key], schema.additionalProperties, path === '$' ? `$.${key}` : `${path}.${key}`, errors)
        }
      }
    }
  }
}

/**
 * @param {unknown} value parsed result value
 * @param {Record<string, unknown>} schema JSON-Schema-like object
 * @returns {{path: string, message: string}[]} up to 20 violations
 */
export function validateJsonSchema(value, schema) {
  const errors = []
  walk(value, schema, '$', errors)
  return errors
}
