/**
 * Pure parameter contract tests: synthetic in-memory inputs only; no IO/env reads.
 * Run: node scripts/selftest-params.js
 * Export: registerParamsTests(test, assert).
 * Red controls: remove numeric checks -> strict integer/finite tests fail;
 * skip overwritten layers -> invalid-low-layer tests fail; echo parser errors ->
 * secret diagnostics fail; permit unsafe keys -> pollution tests fail.
 */
import defaultAssert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineParam, ParamError, resolveParams, resolveParamLayers } from '../src/params.js';

export function registerParamsTests(test, assert = defaultAssert) {
  if (typeof test !== 'function') throw new TypeError('registerParamsTests requires test');
  const def = (options = {}) => defineParam({ id: 'sample', type: 'string', ...options });
  const run = (definition, raw, options = {}) => resolveParams([definition], { env: { [definition.env[0]]: raw }, ...options });
  const rejected = (fn, code, id, source) => {
    assert.throws(fn, (error) => {
      assert.ok(error instanceof ParamError);
      assert.equal(error.name, 'ParamError');
      assert.equal(error.code, code);
      if (id !== undefined) assert.equal(error.id, id);
      if (source !== undefined) assert.equal(error.source, source);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  };
  const scalar = (type, good, bad, extra = {}) => {
    for (const [input, expected] of good) {
      test(`params:${type} accepts ${JSON.stringify(input)}`, () => {
        const result = run(def({ type, ...extra }), input);
        assert.deepEqual(result.values.sample, expected);
        assert.deepEqual(result.inputs.sample, input);
      });
    }
    for (const input of bad) {
      test(`params:${type} rejects ${JSON.stringify(input)}`, () => {
        assert.throws(() => run(def({ type, ...extra }), input), ParamError);
      });
    }
  };

  scalar('boolean', [[true, true], [false, false], [1, true], [0, false],
    ['1', true], ['TRUE', true], ['YeS', true], ['on', true], ['0', false],
    ['False', false], ['NO', false], ['off', false]], ['truthy', ' true', 'false ', 2, {}, null]);
  scalar('number', [[0, 0], [-2.5, -2.5], ['1.5', 1.5], ['2e3', 2000], ['.5', 0.5]],
    [Infinity, -Infinity, NaN, 'NaN', 'Infinity', '1x', '0x10', ' 1', '1 ', true, [], null]);
  scalar('int', [[0, 0], ['-12', -12], ['9007199254740991', Number.MAX_SAFE_INTEGER]],
    [1.2, '1.2', '1x', '1e3', '1.0', Number.MAX_SAFE_INTEGER + 1, '9007199254740992', Infinity]);
  scalar('enum', [['a', 'a'], ['b', 'b'], [3, 3]], ['A', ' a', '3', false, null], { values: ['a', 'b', 3] });
  scalar('string', [['hello', 'hello'], ['  text  ', '  text  ']], [0, false, [], {}, null]);
  scalar('path', [['./data/file.json', './data/file.json'], ['E:/fixture/data', 'E:/fixture/data']],
    ['bad\0path', 1, {}, null]);
  scalar('url', [['https://example.invalid/a?q=x', 'https://example.invalid/a?q=x'],
    ['http://localhost:8080/', 'http://localhost:8080/']],
  ['example.invalid', '/relative', 'https://', 'javascript:alert(1)', 'file:///x', ' https://example.invalid',
    'https://example.invalid/x y', 'https://user:password@example.invalid/', 'https://user@example.invalid/', null]);
  scalar('ms', [[0, 0], ['1000', 1000], [25, 25]], [-1, '-1', 1.5, '1.5', '1s', Infinity, '1x']);
  scalar('duration', [[0, 0], ['12', 12], ['2ms', 2], ['1.5s', 1500], ['2m', 120000],
    ['1h', 3600000], ['1d', 86400000], ['1S', 1000]],
  [-1, '-1s', '1.5ms', '1.0001s', '1 s', '1h2m', 'forever', '9999999999999999d']);
  scalar('array', [[[1, 'a'], [1, 'a']], ['[1,"a"]', [1, 'a']], [[], []]],
    ['{}', '{}notjson', {}, 'null', null, 3]);
  scalar('object', [[{ a: 1 }, { a: 1 }], ['{"a":1}', { a: 1 }], [{}, {}]],
    ['[]', '{oops}', [], 'null', null, 3]);

  test('params:custom parser transforms before typed validation and never changes raw inputs', () => {
    const definition = def({ type: 'int', parse: (value) => typeof value === 'string' ? Number(value.slice(1)) : value });
    assert.deepEqual(run(definition, '#7').values, { sample: 7 });
    assert.deepEqual(run(definition, '#7').inputs, { sample: '#7' });
    rejected(() => run(definition, '#bad'), 'PARAM_TYPE', 'sample', 'env');
  });
  test('params:custom type supports structured results and requires an explicit parser', () => {
    const definition = def({ type: 'custom', parse: (value) => ({ value }) });
    assert.deepEqual(run(definition, 'x').values.sample, { value: 'x' });
    rejected(() => def({ type: 'custom' }), 'PARAM_INVALID_DEFINITION');
    rejected(() => run(def({ type: 'custom', parse: () => undefined }), 'x'), 'PARAM_TYPE');
    rejected(() => run(def({ type: 'custom', parse: () => Infinity }), 'x'), 'PARAM_TYPE');
  });
  test('params:object/array parser and built-in JSON parsing both retain type checks', () => {
    const definition = def({ type: 'object', parse: (value) => ({ item: value }) });
    assert.deepEqual(run(definition, 'x').values.sample, { item: 'x' });
    rejected(() => run(def({ type: 'string', parse: () => ({}) }), 'x'), 'PARAM_TYPE');
    rejected(() => run(def({ type: 'array', parse: () => ({}) }), 'x'), 'PARAM_TYPE');
  });
  test('params:min/max numeric bounds are inclusive and reject both sides', () => {
    const definition = def({ type: 'number', min: 2, max: 4 });
    assert.equal(run(definition, '2').values.sample, 2);
    assert.equal(run(definition, '4').values.sample, 4);
    rejected(() => run(definition, '1'), 'PARAM_RANGE');
    rejected(() => run(definition, '5'), 'PARAM_RANGE');
  });
  test('params:min/max constrain strings, arrays and object key count', () => {
    for (const [type, good, badLow, badHigh] of [
      ['string', 'ab', 'a', 'abcd'], ['array', [1, 2], [], [1, 2, 3, 4]],
      ['object', { a: 1, b: 2 }, {}, { a: 1, b: 2, c: 3, d: 4 }],
    ]) {
      const definition = def({ type, min: 2, max: 3 });
      assert.deepEqual(run(definition, good).values.sample, good);
      rejected(() => run(definition, badLow), 'PARAM_RANGE');
      rejected(() => run(definition, badHigh), 'PARAM_RANGE');
    }
  });
  test('params:validate accepts true/undefined, rejects false/error text/throws', () => {
    for (const result of [true, undefined]) {
      assert.equal(run(def({ validate: () => result }), 'ok').values.sample, 'ok');
    }
    for (const validate of [() => false, () => 'not-valid', () => { throw new Error('secret-input'); }]) {
      rejected(() => run(def({ validate }), 'secret-input'), 'PARAM_VALIDATION', 'sample', 'env');
    }
  });
  test('params:undefined defaults are optional, never parsed or custom-validated', () => {
    const definition = def({ type: 'custom', parse: () => { throw new Error('should not run'); }, validate: () => false });
    const result = resolveParams([definition]);
    assert.equal(result.values.sample, undefined);
    assert.deepEqual(result.inputs, {});
    assert.deepEqual(result.sources.sample, { source: 'default', chain: [{ source: 'default' }], sensitive: false });
  });
  test('params:defaults are typed/validated at definition and resolution, never appear in inputs', () => {
    const definition = def({ type: 'int', default: '7' });
    const result = resolveParams([definition]);
    assert.deepEqual(result.values, { sample: 7 });
    assert.deepEqual(result.inputs, {});
    rejected(() => def({ type: 'int', default: '7junk' }), 'PARAM_TYPE', 'sample', 'default');
    rejected(() => def({ default: 'x', validate: () => false }), 'PARAM_VALIDATION', 'sample', 'default');
  });
  test('params:null only works with nullable (including default and parser result)', () => {
    rejected(() => def({ default: null }), 'PARAM_TYPE');
    assert.equal(resolveParams([def({ nullable: true, default: null })]).values.sample, null);
    assert.equal(run(def({ nullable: true }), null).values.sample, null);
    assert.equal(run(def({ nullable: true, parse: () => null }), 'x').values.sample, null);
    rejected(() => run(def({ parse: () => null }), 'x'), 'PARAM_TYPE');
  });
  test('params:nullable does not bypass explicit bounds or custom validators', () => {
    const accepting = def({ nullable: true, validate: (value) => value === null });
    assert.equal(run(accepting, null).values.sample, null);
    rejected(() => run(def({ nullable: true, validate: () => false }), null), 'PARAM_VALIDATION');
    rejected(() => def({ nullable: true, default: null, validate: () => false }), 'PARAM_VALIDATION');
    rejected(() => run(def({ nullable: true, min: 1 }), null), 'PARAM_RANGE');
    rejected(() => run(def({ nullable: true, parse: () => null, validate: () => false }), 'x'), 'PARAM_VALIDATION');
  });
  test('params:emptyAsUnset defaults true; false preserves explicit empty string', () => {
    const definition = def({ default: 'fallback' });
    assert.equal(run(definition, '').values.sample, 'fallback');
    assert.deepEqual(run(definition, '').inputs, {});
    assert.equal(run(def({ default: 'fallback', emptyAsUnset: false }), '').values.sample, '');
    rejected(() => run(def({ type: 'boolean', emptyAsUnset: false }), ''), 'PARAM_TYPE');
    assert.equal(resolveParams([def({ default: '' })]).values.sample, '');
  });
  test('params:fixed precedence returns typed winner, final raw input, complete metadata chain', () => {
    const definition = def({ type: 'int', default: 1, env: 'SAMPLE' });
    const result = resolveParams([definition], { contentPack: { sample: '2' }, configFile: { sample: '3' },
      envFile: { SAMPLE: '4' }, env: { SAMPLE: '5' } });
    assert.deepEqual(result.values, { sample: 5 });
    assert.deepEqual(result.inputs, { sample: '5' });
    assert.deepEqual(result.sources, { sample: { source: 'env', sensitive: false, chain: [
      { source: 'default' }, { source: 'content-pack' }, { source: 'config-file' },
      { source: 'env-file', env: 'SAMPLE' }, { source: 'env', env: 'SAMPLE' },
    ] } });
    assert.deepEqual(result.warnings, []);
  });
  test('params:partial/empty higher layers keep the latest real input and source', () => {
    const result = resolveParams([def({ default: 'base', env: 'VALUE' })], {
      contentPack: { sample: 'pack' }, configFile: { sample: undefined }, envFile: { VALUE: '' }, env: { VALUE: undefined },
    });
    assert.deepEqual(result.inputs, { sample: 'pack' });
    assert.equal(result.sources.sample.source, 'content-pack');
    assert.equal(result.sources.sample.chain.length, 2);
  });
  test('params:generic layer order preserves env then model saved-file override', () => {
    const result = resolveParamLayers([def({ type: 'int', default: 0, env: 'VALUE' })], [
      { source: 'env', kind: 'env', values: { VALUE: '2' } },
      { source: 'saved-file', kind: 'params', values: { sample: '3' } },
    ]);
    assert.deepEqual(result.values, { sample: 3 });
    assert.deepEqual(result.inputs, { sample: '3' });
    assert.equal(result.sources.sample.source, 'saved-file');
  });
  test('params:every lower layer is validated even when a higher layer is valid', () => {
    const definition = def({ type: 'int', default: 0, env: 'VALUE' });
    for (const [source, options] of [
      ['content-pack', { contentPack: { sample: 'bad' }, configFile: { sample: 2 }, env: { VALUE: 3 } }],
      ['config-file', { configFile: { sample: 'bad' }, env: { VALUE: 3 } }],
      ['env-file', { envFile: { VALUE: 'bad' }, env: { VALUE: 3 } }],
    ]) rejected(() => resolveParams([definition], options), 'PARAM_TYPE', 'sample', source);
    rejected(() => resolveParamLayers([definition], [
      { source: 'env', kind: 'env', values: { VALUE: 'bad' } },
      { source: 'saved-file', kind: 'params', values: { sample: 3 } },
    ]), 'PARAM_TYPE', 'sample', 'env');
  });
  test('params:env defaults to id and aliases are highest-first, all aliases enter safe chain', () => {
    assert.deepEqual(def().env, ['sample']);
    const definition = def({ env: ['OWN', 'FALLBACK'], type: 'int' });
    const result = resolveParams([definition], { env: { OWN: '1', FALLBACK: '2' } });
    assert.equal(result.values.sample, 1);
    assert.deepEqual(result.sources.sample.chain.slice(1), [{ source: 'env', env: 'FALLBACK' }, { source: 'env', env: 'OWN' }]);
    assert.equal(resolveParams([definition], { env: { OWN: '', FALLBACK: '2' } }).values.sample, 2);
    rejected(() => resolveParams([definition], { env: { OWN: '1', FALLBACK: 'bad' } }), 'PARAM_TYPE');
  });
  test('params:duplicate definitions and overlapping/repeated aliases fail closed', () => {
    rejected(() => resolveParams([def(), def()]), 'PARAM_DUPLICATE_ID');
    rejected(() => resolveParams([def({ env: 'SHARED' }), def({ id: 'other', env: 'SHARED' })]), 'PARAM_ALIAS_CONFLICT');
    rejected(() => def({ env: ['SAME', 'SAME'] }), 'PARAM_INVALID_DEFINITION');
    rejected(() => def({ env: [] }), 'PARAM_INVALID_DEFINITION');
  });
  test('params:unknown explicit keys fail closed; warn never echoes unknown keys', () => {
    const marker = 'private-key-never-echo';
    rejected(() => resolveParams([def()], { configFile: { [marker]: 'secret' } }), 'PARAM_UNKNOWN', undefined, 'config-file');
    const result = resolveParams([def()], { configFile: { [marker]: 'secret', anotherUnknown: 2 }, unknown: 'warn' });
    assert.deepEqual(result.warnings, [{ code: 'PARAM_UNKNOWN', source: 'config-file' }]);
    assert.deepEqual(result.inputs, {});
    assert.doesNotMatch(JSON.stringify(result.sources) + JSON.stringify(result.warnings), /private-key|anotherUnknown|secret/);
  });
  test('params:unrelated environment keys never reject or produce warnings', () => {
    const result = resolveParams([def()], { env: { PATH: '/synthetic', OTHER_MODULE: 'x' },
      envFile: { OTHER_MODULE: 'y' }, knownEnv: ['PATH', 'OTHER_MODULE'] });
    assert.equal(result.values.sample, undefined);
    assert.deepEqual(result.warnings, []);
  });
  test('params:QQBOT unknown env names warn safely, registered/known/ordinary names do not', () => {
    const definition = def({ env: ['QQBOT_REGISTERED', 'QQBOT_ALIAS'] });
    const result = resolveParams([definition], { knownEnv: ['QQBOT_OTHER_MODULE'],
      envFile: { QQBOT_TYPO_PRIVATE: 'secret-a', QQBOT_OTHER_MODULE: 'ok', PATH: '/fixture' },
      env: { QQBOT_REGISTERED: 'good', QQBOT_ALIAS: 'fallback', QQBOT_OTHER_MODULE: 'ok', QQBOT_TYPO_PRIVATE: 'secret-b', QQBOT_SECOND_PRIVATE: 'secret-c' },
    });
    assert.equal(result.values.sample, 'good');
    assert.deepEqual(result.warnings, [
      { code: 'PARAM_UNKNOWN_ENV', source: 'env-file', index: 0 },
      { code: 'PARAM_UNKNOWN_ENV', source: 'env', index: 0 },
      { code: 'PARAM_UNKNOWN_ENV', source: 'env', index: 1 },
    ]);
    assert.doesNotMatch(JSON.stringify(result.warnings), /QQBOT_|secret|PRIVATE/);
    assert.deepEqual(resolveParams([definition], { env: { QQBOT_OTHER_MODULE: 'ok', PATH: 'ok' }, knownEnv: ['QQBOT_OTHER_MODULE'] }).warnings, []);
  });
  test('params:deployment parameters reject both explicit-file layers even if overridden', () => {
    for (const extra of [{ sensitive: true }, { scope: 'deployment' }]) {
      const definition = def({ ...extra, env: 'VALUE' });
      for (const [source, options] of [['content-pack', { contentPack: { sample: 'secret' } }],
        ['config-file', { configFile: { sample: 'secret' } }]]) {
        rejected(() => resolveParams([definition], { ...options, env: { VALUE: 'valid' } }), 'PARAM_SCOPE', 'sample', source);
      }
      assert.equal(resolveParams([definition], { envFile: { VALUE: 'ok' } }).values.sample, 'ok');
      assert.equal(resolveParamLayers([definition], [{ source: 'saved-file', kind: 'params', values: { sample: 'ok' } }]).values.sample, 'ok');
    }
    rejected(() => def({ sensitive: true, scope: 'runtime' }), 'PARAM_INVALID_DEFINITION');
  });
  test('params:scope runtime allows both params layers; sensitive provenance contains metadata only', () => {
    const secret = 'fixture-secret-not-for-diagnostics';
    const result = resolveParams([def({ sensitive: true, default: secret, env: 'TOKEN' })], { env: { TOKEN: secret } });
    assert.deepEqual(result.sources.sample, { source: 'env', sensitive: true, chain: [{ source: 'default' }, { source: 'env', env: 'TOKEN' }] });
    assert.doesNotMatch(JSON.stringify(result.sources), /fixture-secret/);
    assert.equal(resolveParams([def()], { contentPack: { sample: 'a' }, configFile: { sample: 'b' } }).values.sample, 'b');
  });
  test('params:prototype-polluting records and nested parsed keys fail without pollution', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(`{"${key}":{"polluted":true}}`);
      rejected(() => resolveParams([def()], { configFile: payload }), 'PARAM_UNSAFE');
      rejected(() => run(def({ type: 'object' }), payload), 'PARAM_UNSAFE');
      rejected(() => run(def({ type: 'object' }), JSON.stringify(payload)), 'PARAM_UNSAFE');
      rejected(() => def({ type: 'object', default: payload }), 'PARAM_UNSAFE');
    }
    assert.equal({}.polluted, undefined);
  });
  test('params:class instances, inherited records, accessors and symbol keys are rejected without invocation', () => {
    let invoked = false;
    class Example { constructor() { this.sample = 'value'; } }
    for (const value of [new Example(), Object.create({ sample: 'inherited' }),
      { get sample() { invoked = true; return 'x'; } }, { [Symbol('secret')]: 'x' }]) {
      rejected(() => resolveParams([def()], { configFile: value }), 'PARAM_UNSAFE');
    }
    assert.equal(invoked, false);
    const nested = { get x() { invoked = true; return 'x'; } };
    rejected(() => run(def({ type: 'object' }), nested), 'PARAM_UNSAFE');
    assert.equal(invoked, false);
  });
  test('params:resolver options and layer records reject accessors without invoking them', () => {
    let invoked = false;
    const options = { get env() { invoked = true; throw new Error('private-options-secret'); } };
    rejected(() => resolveParams([def()], options), 'PARAM_UNSAFE');
    rejected(() => resolveParamLayers([def()], [], { get unknown() { invoked = true; return 'warn'; } }), 'PARAM_UNSAFE');
    rejected(() => resolveParamLayers([def()], [{ get source() { invoked = true; return 'env'; } }]), 'PARAM_UNSAFE');
    assert.equal(invoked, false);
    rejected(() => resolveParams([def()], { configFile: null }), 'PARAM_UNSAFE');
    rejected(() => resolveParams([def()], { unknown: null }), 'PARAM_LAYER');
  });
  test('params:definition/layer arrays reject accessors and sparse entries without invocation', () => {
    let invoked = false;
    const accessor = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked = true; throw new Error('private-array-secret'); } });
    rejected(() => resolveParams(accessor), 'PARAM_UNSAFE');
    rejected(() => resolveParamLayers([def()], accessor), 'PARAM_UNSAFE');
    rejected(() => resolveParams(new Array(1)), 'PARAM_UNSAFE');
    rejected(() => resolveParamLayers([def()], new Array(1)), 'PARAM_UNSAFE');
    assert.equal(invoked, false);
  });
  test('params:throwing proxy traps are wrapped without leaking private exceptions', () => {
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('fixture-proxy-SECRET'); } });
    for (const call of [() => resolveParams([def()], { configFile: proxy }), () => run(def({ type: 'object' }), proxy)]) {
      assert.throws(call, (error) => {
        assert.ok(error instanceof ParamError);
        assert.equal(error.code, 'PARAM_UNSAFE');
        assert.doesNotMatch(`${error.stack}`, /fixture-proxy-SECRET/);
        return true;
      });
    }
  });
  test('params:structured numeric overflow fails closed and excessive nesting has a safe error', () => {
    rejected(() => run(def({ type: 'object' }), '{"n":1e999}'), 'PARAM_TYPE');
    let deep = {};
    for (let i = 0; i < 150; i += 1) deep = { child: deep };
    rejected(() => run(def({ type: 'object' }), deep), 'PARAM_UNSAFE');
  });
  test('params:cyclic/sparse arrays and non-data values are rejected', () => {
    const cyclic = {}; cyclic.self = cyclic;
    for (const value of [cyclic, new Date(0), () => 'x', Symbol('secret'), 1n]) {
      rejected(() => run(def({ type: 'object' }), value), 'PARAM_UNSAFE');
    }
    rejected(() => run(def({ type: 'array' }), new Array(2)), 'PARAM_UNSAFE');
  });
  test('params:null-prototype plain records are supported and copied into ordinary safe records', () => {
    const contentPack = Object.create(null); contentPack.sample = { a: 1 };
    const result = resolveParams([def({ type: 'object' })], { contentPack });
    assert.deepEqual(result.values.sample, { a: 1 });
    assert.equal(Object.getPrototypeOf(result.values.sample), Object.prototype);
  });
  test('params:caller data/default/schema are not mutated or shared with result/parser/validator', () => {
    const original = { item: { count: 1 } };
    const before = JSON.stringify(original);
    const definition = def({ type: 'object', default: original,
      parse: (value) => { value.item.count += 1; return value; },
      validate: (value) => { value.item.count = 999; return true; } });
    const configFile = { sample: original };
    Object.freeze(configFile); Object.freeze(original.item); Object.freeze(original);
    const result = resolveParams([definition], { configFile });
    assert.equal(JSON.stringify(original), before);
    assert.equal(result.values.sample.item.count, 2);
    assert.equal(result.inputs.sample.item.count, 1);
    result.values.sample.item.count = 7;
    result.inputs.sample.item.count = 8;
    assert.equal(original.item.count, 1);
    assert.equal(definition.default.item.count, 1);
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.default.item));
  });
  test('params:parse/validate/default/unknown errors never include inputs, paths or custom exceptions', () => {
    const secret = 'fixture-secret-VERY-PRIVATE';
    const privatePath = 'E:/fixture/private/account.json';
    const bomb = () => { throw new Error(`${secret} ${privatePath}`); };
    for (const call of [
      () => run(def({ parse: bomb }), secret),
      () => run(def({ validate: bomb }), secret),
      () => def({ default: secret, parse: bomb }),
      () => def({ default: secret, validate: bomb }),
      () => resolveParams([def()], { configFile: { [secret]: privatePath } }),
      () => resolveParamLayers([def()], [{ source: privatePath, kind: 'params', values: {} }]),
    ]) {
      let error;
      try { call(); } catch (caught) { error = caught; }
      assert.ok(error instanceof ParamError);
      const rendered = `${error.stack}\n${JSON.stringify(error)}`;
      assert.doesNotMatch(rendered, /fixture-secret|private\/account|VERY-PRIVATE/);
      assert.equal(error.cause, undefined);
      assert.ok(error.message.startsWith('PARAM_'));
    }
  });
  test('params:undefined optional schema fields use defaults, null flags do not', () => {
    const definition = def({ env: undefined, parse: undefined, validate: undefined, scope: undefined,
      sensitive: undefined, nullable: undefined, emptyAsUnset: undefined });
    assert.deepEqual(definition.env, ['sample']);
    assert.equal(run(definition, 'ok').values.sample, 'ok');
    assert.deepEqual(defineParam({ id: 'nested.id', type: 'string' }).env, ['nested.id']);
    for (const key of ['scope', 'sensitive', 'nullable', 'emptyAsUnset', 'parse', 'validate']) {
      rejected(() => def({ [key]: null }), 'PARAM_INVALID_DEFINITION');
    }
  });
  test('params:invalid definitions fail closed with safe fixed codes', () => {
    for (const options of [
      { id: '__proto__' }, { id: '../private-path' }, { type: 'wat' }, { scope: 'wat' },
      { sensitive: 'true' }, { nullable: 1 }, { emptyAsUnset: 0 }, { parse: true }, { validate: true },
      { min: NaN }, { max: Infinity }, { min: 2, max: 1 }, { arbitrary: 'secret' },
      { type: 'enum', values: [] }, { type: 'enum', values: ['x', 'x'] }, { type: 'enum', values: [{}] },
      { env: 'unsafe/key' },
    ]) rejected(() => def(options), 'PARAM_INVALID_DEFINITION');
    rejected(() => defineParam(null), 'PARAM_UNSAFE');
    rejected(() => resolveParams([{ id: 'unregistered', type: 'string' }]), 'PARAM_INVALID_DEFINITION');
  });
  test('params:invalid layer kinds/options/sources reject without echoing arbitrary metadata', () => {
    for (const layers of [null, [{}], [{ source: 'env', kind: 'wat', values: {} }],
      [{ source: 'E:/private/path', kind: 'env', values: {} }],
      [{ source: 'default', kind: 'params', values: {} }],
      [{ source: 'env', kind: 'env', values: {}, file: 'E:/private/path' }]]) {
      rejected(() => resolveParamLayers([def()], layers), 'PARAM_LAYER');
    }
    rejected(() => resolveParams([def()], { unknown: 'ignore' }), 'PARAM_LAYER');
    rejected(() => resolveParams([def()], { knownEnv: ['unsafe/key'] }), 'PARAM_LAYER');
  });
}

const SELF_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_FILE) {
  const cases = [];
  registerParamsTests((name, fn) => cases.push([name, fn]), defaultAssert);
  let passed = 0;
  console.log('[selftest-params] synthetic inputs only; no file/network/process IO');
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`PASS ${name}`); }
    catch (error) { process.exitCode = 1; console.error(`FAIL ${name}`); console.error(error?.stack ?? error); }
  }
  console.log(`${passed}/${cases.length} passed`);
}
