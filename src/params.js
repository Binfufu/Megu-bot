/**
 * Pure, zero-dependency parameter schemas and ordered overlays.
 * Rules follow Mozilla Convict 6.2.4 (schema/default/env/sensitive/strict keys):
 * https://github.com/mozilla/node-convict/blob/v6.2.4/packages/convict/README.md
 * Deliberate differences: validate EVERY layer, retain raw explicit inputs for
 * legacy readers, and never include input/paths/parser exceptions in diagnostics.
 * No file reads, implicit process.env reads, coercive trimming, or path resolving.
 */
const TYPES = new Set(['boolean', 'number', 'int', 'enum', 'string', 'url', 'path', 'ms', 'duration', 'array', 'object', 'custom']);
const OPTIONS = new Set(['id', 'type', 'default', 'env', 'validate', 'scope', 'sensitive', 'min', 'max', 'values', 'parse', 'emptyAsUnset', 'nullable']);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFINITIONS = new WeakSet();
const ID = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SOURCE = /^[a-z][a-z0-9-]{0,63}$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const INTEGER = /^[+-]?\d+$/;
const has = (value, key) => Object.hasOwn(value, key);
const setting = (fields, key, fallback) => fields.get(key) === undefined ? fallback : fields.get(key);
const plain = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Stable public diagnostics: only an allowlisted code, registered id and source. */
export class ParamError extends Error {
  constructor(code, id, source) {
    // Do not accept caller-controlled diagnostic strings, including custom errors.
    const codes = new Set(['PARAM_INVALID_DEFINITION', 'PARAM_DUPLICATE_ID', 'PARAM_ALIAS_CONFLICT',
      'PARAM_TYPE', 'PARAM_VALUE', 'PARAM_RANGE', 'PARAM_VALIDATION', 'PARAM_UNKNOWN',
      'PARAM_LAYER', 'PARAM_SCOPE', 'PARAM_UNSAFE']);
    const safeCode = codes.has(code) ? code : 'PARAM_VALUE';
    const safeId = typeof id === 'string' && ID.test(id) && !DANGEROUS.has(id) ? id : undefined;
    const safeSource = typeof source === 'string' && SOURCE.test(source) ? source : 'layer';
    super(`${safeCode}${safeId ? ` ${safeId}` : ''} (${safeSource})`);
    this.name = 'ParamError';
    this.code = safeCode;
    if (safeId) this.id = safeId;
    this.source = safeSource;
  }
}
const fail = (code, id, source) => { throw new ParamError(code, id, source); };

/** Copy data without invoking accessors or retaining caller-owned mutable objects. */
function copyData(value, id, source, active = new Set()) {
  try { return copyDataInner(value, id, source, active); }
  catch (error) {
    if (error instanceof ParamError) throw error;
    fail('PARAM_UNSAFE', id, source);
  }
}
function copyDataInner(value, id, source, active) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('PARAM_TYPE', id, source);
  if (value === null || ['string', 'boolean', 'number', 'undefined'].includes(typeof value)) return value;
  if ((!Array.isArray(value) && !plain(value)) || active.has(value) || active.size >= 128) fail('PARAM_UNSAFE', id, source);
  active.add(value);
  const array = Array.isArray(value);
  const result = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || DANGEROUS.has(key) || !descriptor || !has(descriptor, 'value')
      || !descriptor.enumerable || (array && !/^(0|[1-9]\d*)$/.test(key))) fail('PARAM_UNSAFE', id, source);
    result[key] = copyData(descriptor.value, id, source, active);
  }
  if (array) {
    if (Object.keys(result).length !== value.length) fail('PARAM_UNSAFE', id, source);
    result.length = value.length;
  }
  active.delete(value);
  return result;
}
function freezeData(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
function readRecord(value, source, options = {}) {
  try { return readRecordInner(value, source, options); }
  catch (error) {
    if (error instanceof ParamError) throw error;
    fail('PARAM_UNSAFE', options.id, source);
  }
}
function readRecordInner(value, source, { env = false, id } = {}) {
  // Node's process.env has a special prototype; only accept that explicit object,
  // never arbitrary instances/inherited records. No environment is read implicitly.
  if (!plain(value) && !(env && value === process.env)) fail('PARAM_UNSAFE', id, source);
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || DANGEROUS.has(key) || !descriptor || !has(descriptor, 'value')
      || !descriptor.enumerable) fail('PARAM_UNSAFE', id, source);
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function readSequence(value, code, source) {
  try {
    if (!Array.isArray(value)) fail(code, undefined, source);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    const result = [];
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)
        || Number(key) >= length || !descriptor?.enumerable || !has(descriptor, 'value')) {
        fail('PARAM_UNSAFE', undefined, source);
      }
      result[key] = descriptor.value;
      count += 1;
    }
    if (count !== length) fail('PARAM_UNSAFE', undefined, source);
    return result;
  } catch (error) {
    if (error instanceof ParamError) throw error;
    fail('PARAM_UNSAFE', undefined, source);
  }
}

function numeric(value, integer, id, source) {
  if (typeof value === 'string') {
    if (!(integer ? INTEGER : DECIMAL).test(value)) fail('PARAM_TYPE', id, source);
    value = Number(value);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (integer && !Number.isSafeInteger(value))) fail('PARAM_TYPE', id, source);
  return value;
}
function validateValue(def, value, source) {
  const { id } = def;
  const size = typeof value === 'number' ? value
    : typeof value === 'string' || Array.isArray(value) ? value.length
      : plain(value) ? Object.keys(value).length : undefined;
  if ((def.min !== undefined && (size === undefined || size < def.min))
    || (def.max !== undefined && (size === undefined || size > def.max))) fail('PARAM_RANGE', id, source);
  if (def.validate) {
    let valid;
    try { valid = def.validate(copyData(value, id, source)); } catch { fail('PARAM_VALIDATION', id, source); }
    if (valid !== true && valid !== undefined) fail('PARAM_VALIDATION', id, source);
  }
  return copyData(value, id, source);
}
function parseValue(def, raw, source) {
  const { id } = def;
  let value = copyData(raw, id, source);
  if (value === null) {
    if (!def.nullable) fail('PARAM_TYPE', id, source);
    return validateValue(def, null, source);
  }
  if (def.parse) {
    try { value = def.parse(value); } catch { fail('PARAM_VALUE', id, source); }
    value = copyData(value, id, source);
    if (value === null) {
      if (!def.nullable) fail('PARAM_TYPE', id, source);
      return validateValue(def, null, source);
    }
  }
  switch (def.type) {
    case 'boolean': {
      if (typeof value === 'string') {
        const token = value.toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(token)) value = true;
        else if (['0', 'false', 'no', 'off'].includes(token)) value = false;
        else fail('PARAM_TYPE', id, source);
      } else if (value === 0 || value === 1) value = Boolean(value);
      if (typeof value !== 'boolean') fail('PARAM_TYPE', id, source);
      break;
    }
    case 'number': value = numeric(value, false, id, source); break;
    case 'int': value = numeric(value, true, id, source); break;
    case 'ms': case 'duration': {
      if (def.type === 'duration' && typeof value === 'string') {
        // A single decimal magnitude plus ms/s/m/h/d, like the mature ms API;
        // no whitespace, negative values, compound expressions or rounding.
        const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i.exec(value);
        if (match) value = Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 })[match[2].toLowerCase()];
      }
      value = numeric(value, true, id, source);
      if (value < 0) fail('PARAM_RANGE', id, source);
      break;
    }
    case 'string': case 'path': case 'url':
      if (typeof value !== 'string') fail('PARAM_TYPE', id, source);
      if (def.type === 'path' && value.includes('\0')) fail('PARAM_VALUE', id, source);
      if (def.type === 'url') {
        try {
          const parsed = new URL(value);
          if (!/^https?:\/\//i.test(value) || /\s/.test(value) || !parsed.hostname
            || parsed.username || parsed.password
            || !['http:', 'https:'].includes(parsed.protocol)) fail('PARAM_VALUE', id, source);
        } catch { fail('PARAM_VALUE', id, source); }
      }
      break;
    case 'enum':
      if (!def.values.some((item) => Object.is(item, value))) fail('PARAM_VALUE', id, source);
      break;
    case 'array': case 'object':
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { fail('PARAM_VALUE', id, source); }
        value = copyData(value, id, source);
      }
      if (def.type === 'array' ? !Array.isArray(value) : !plain(value)) fail('PARAM_TYPE', id, source);
      break;
    case 'custom':
      if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) fail('PARAM_TYPE', id, source);
      break;
    default: fail('PARAM_INVALID_DEFINITION', id, source);
  }
  return validateValue(def, value, source);
}

/** Define and validate a schema; an undefined default is optional and not parsed. */
export function defineParam(options) {
  const entries = readRecord(options, 'definition');
  const fields = new Map(entries);
  const candidate = fields.get('id');
  const id = typeof candidate === 'string' && ID.test(candidate) && !DANGEROUS.has(candidate) ? candidate : undefined;
  if (!id || entries.some(([key]) => !OPTIONS.has(key))) fail('PARAM_INVALID_DEFINITION', id, 'definition');
  const type = fields.get('type');
  const sensitive = setting(fields, 'sensitive', false);
  const scope = setting(fields, 'scope', sensitive ? 'deployment' : 'runtime');
  const emptyAsUnset = setting(fields, 'emptyAsUnset', true);
  const nullable = setting(fields, 'nullable', false);
  if (!TYPES.has(type) || typeof sensitive !== 'boolean' || typeof emptyAsUnset !== 'boolean'
    || typeof nullable !== 'boolean' || !['runtime', 'deployment'].includes(scope)
    || (sensitive && scope !== 'deployment')
    || (fields.get('parse') !== undefined && typeof fields.get('parse') !== 'function')
    || (fields.get('validate') !== undefined && typeof fields.get('validate') !== 'function')
    || (type === 'custom' && typeof fields.get('parse') !== 'function')) fail('PARAM_INVALID_DEFINITION', id, 'definition');
  let env = copyData(setting(fields, 'env', id), id, 'definition');
  env = Array.isArray(env) ? env : [env];
  if (!env.length || env.some((name) => typeof name !== 'string' || !ENV.test(name) || DANGEROUS.has(name))
    || new Set(env).size !== env.length) fail('PARAM_INVALID_DEFINITION', id, 'definition');
  const min = fields.get('min');
  const max = fields.get('max');
  if ((min !== undefined && (typeof min !== 'number' || !Number.isFinite(min)))
    || (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max)))
    || (min !== undefined && max !== undefined && min > max)) fail('PARAM_INVALID_DEFINITION', id, 'definition');
  const values = fields.has('values') ? copyData(fields.get('values'), id, 'definition') : undefined;
  if (type === 'enum' && (!Array.isArray(values) || !values.length
    || values.some((item) => item === null || !['string', 'number', 'boolean'].includes(typeof item)
      || (typeof item === 'number' && !Number.isFinite(item)))
    || new Set(values).size !== values.length)) fail('PARAM_INVALID_DEFINITION', id, 'definition');
  const def = { id, type, default: copyData(fields.get('default'), id, 'default'), env: freezeData(env),
    validate: fields.get('validate'), scope, sensitive, min, max, values: freezeData(values),
    parse: fields.get('parse'), emptyAsUnset, nullable };
  if (def.default !== undefined) parseValue(def, def.default, 'default');
  freezeData(def.default);
  Object.freeze(def);
  DEFINITIONS.add(def);
  return def;
}

function registry(defs) {
  defs = readSequence(defs, 'PARAM_INVALID_DEFINITION', 'definition');
  const byId = new Map();
  const byEnv = new Map();
  for (const def of defs) {
    if (!DEFINITIONS.has(def)) fail('PARAM_INVALID_DEFINITION', undefined, 'definition');
    if (byId.has(def.id)) fail('PARAM_DUPLICATE_ID', def.id, 'definition');
    byId.set(def.id, def);
    for (const name of def.env) {
      if (byEnv.has(name)) fail('PARAM_ALIAS_CONFLICT', def.id, 'definition');
      byEnv.set(name, def);
    }
  }
  return { byId, byEnv, ordered: defs };
}

/**
 * Resolve ordered layers, including model-specific env -> saved-file overlays.
 * env alias arrays are highest-first; every provided alias is validated, then
 * applied in reverse order so the first alias wins. Empty string is unset only
 * when emptyAsUnset=true; whitespace is NEVER implicitly trimmed.
 */
export function resolveParamLayers(defs, layers, options = {}) {
  const { byId, ordered } = registry(defs);
  const settings = new Map(readRecord(options, 'layers'));
  const unknown = setting(settings, 'unknown', 'error');
  if ([...settings.keys()].some((key) => key !== 'unknown')
    || !['error', 'warn'].includes(unknown)) fail('PARAM_LAYER', undefined, 'layers');
  layers = readSequence(layers, 'PARAM_LAYER', 'layers');
  const values = {};
  const sources = {};
  const inputs = {};
  const warnings = [];
  for (const def of ordered) {
    values[def.id] = def.default === undefined ? undefined : parseValue(def, def.default, 'default');
    sources[def.id] = { source: 'default', chain: [{ source: 'default' }], sensitive: def.sensitive };
  }
  for (const layer of layers) {
    const fields = new Map(readRecord(layer, 'layers'));
    const source = fields.get('source');
    const kind = fields.get('kind');
    if (typeof source !== 'string' || !SOURCE.test(source) || source === 'default'
      || !['params', 'env'].includes(kind) || !fields.has('values')
      || [...fields.keys()].some((key) => !['source', 'kind', 'values'].includes(key))) fail('PARAM_LAYER', undefined, 'layers');
    const entries = readRecord(fields.get('values'), source, { env: kind === 'env' });
    const supplied = new Map(entries);
    if (kind === 'params') {
      let warned = false;
      for (const [key] of entries) {
        if (byId.has(key)) continue;
        if (unknown === 'error') fail('PARAM_UNKNOWN', undefined, source);
        // One fixed warning per layer, not even unknown-key counts are exposed.
        if (!warned) warnings.push({ code: 'PARAM_UNKNOWN', source });
        warned = true;
      }
    }
    for (const def of ordered) {
      const keys = kind === 'env' ? [...def.env].reverse() : [def.id];
      for (const key of keys) {
        if (!supplied.has(key)) continue;
        const raw = supplied.get(key);
        if (raw === undefined || (raw === '' && def.emptyAsUnset)) continue;
        if (def.scope === 'deployment' && ['world-pack', 'content-pack', 'config-file'].includes(source)) fail('PARAM_SCOPE', def.id, source);
        const parsed = parseValue(def, raw, source);
        values[def.id] = parsed;
        inputs[def.id] = copyData(raw, def.id, source);
        const metadata = kind === 'env' ? { source, env: key } : { source };
        sources[def.id].source = source;
        sources[def.id].chain.push(metadata);
      }
    }
    // Unknown env belongs to other modules and never causes failure here.
  }
  return { values, sources, inputs, warnings };
}

/**
 * Fixed general precedence: default < world-pack < content-pack < config-file <
 * env-file < env. World packs are content-owned tuning too, one layer below the
 * selected character content pack and above schema defaults. Only unregistered
 * QQBOT_ names produce advisory env warnings; knownEnv exempts names owned by
 * other modules. index is the local zero-based unknown-warning ordinal, never an
 * unknown name or raw input.
 */
export function resolveParams(defs, options = {}) {
  const settings = new Map(readRecord(options, 'layers'));
  const allowed = new Set(['worldPack', 'contentPack', 'configFile', 'envFile', 'env', 'unknown', 'knownEnv']);
  if ([...settings.keys()].some((key) => !allowed.has(key))) fail('PARAM_LAYER', undefined, 'layers');
  const worldPack = setting(settings, 'worldPack', {});
  const contentPack = setting(settings, 'contentPack', {});
  const configFile = setting(settings, 'configFile', {});
  const envFile = setting(settings, 'envFile', {});
  const env = setting(settings, 'env', {});
  const unknown = setting(settings, 'unknown', 'error');
  const knownEnv = copyData(setting(settings, 'knownEnv', []), undefined, 'env');
  if (!Array.isArray(knownEnv) || knownEnv.some((name) => typeof name !== 'string' || !ENV.test(name))) {
    fail('PARAM_LAYER', undefined, 'env');
  }
  const result = resolveParamLayers(defs, [
    { source: 'world-pack', values: worldPack, kind: 'params' },
    { source: 'content-pack', values: contentPack, kind: 'params' },
    { source: 'config-file', values: configFile, kind: 'params' },
    { source: 'env-file', values: envFile, kind: 'env' },
    { source: 'env', values: env, kind: 'env' },
  ], { unknown });
  const { byEnv } = registry(defs);
  const known = new Set(knownEnv);
  for (const [source, record] of [['env-file', envFile], ['env', env]]) {
    let index = 0;
    for (const [key] of readRecord(record, source, { env: true })) {
      if (key.startsWith('QQBOT_') && !byEnv.has(key) && !known.has(key)) {
        result.warnings.push({ code: 'PARAM_UNKNOWN_ENV', source, index });
        index += 1;
      }
    }
  }
  return result;
}
