const test = require('node:test');
const assert = require('node:assert/strict');
const {
    LIST,
    providerById,
    headersFor,
    modelUrl,
    authRequest,
    parseModels,
    googleSchema,
    migrateSettings,
    estimateCost
} = require('../renderer/providers.js');
const pricing = require('../pricing/pricing.json');

const BASE = () => ({
    engine: 'cloud',
    provider: 'anthropic',
    models: {},
    apiKeys: {},
    localModel: '',
    localMmproj: '',
    llamaServer: '',
    presets: [],
    activePreset: 'default'
});

test('provider registry: ids are unique and every entry is complete', () => {
    const ids = LIST.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate provider id');
    for (const p of LIST) {
        assert.ok(p.id && p.name && p.kind && p.base, p.id + ' is missing a field');
        assert.ok(['anthropic', 'openai', 'google'].includes(p.kind), p.id + ' has an unknown kind');
        assert.match(p.base, /^https:\/\//, p.id + ' base must be https');
        assert.match(p.docs, /^https:\/\//, p.id + ' docs must be https');
    }
});

test('provider registry: covers the requested vendors', () => {
    for (const id of ['anthropic', 'openai', 'google', 'xai', 'openrouter', 'deepseek']) {
        assert.ok(providerById(id), 'missing ' + id);
    }
});

test('providerById: returns undefined for an unknown id', () => {
    assert.equal(providerById('nope'), undefined);
});

test('provider registry: documented request limits are present and sane', () => {
    const anthropic = providerById('anthropic').limits;
    assert.equal(anthropic.imageBytes, 5 * 1024 * 1024);
    assert.equal(anthropic.requestBytes, 32 * 1024 * 1024);
    assert.equal(providerById('openai').limits.imageBytes, 20 * 1024 * 1024);
    assert.equal(providerById('google').limits.requestBytes, 20 * 1024 * 1024);
    for (const p of LIST) {
        if (!p.limits) continue;
        for (const [key, value] of Object.entries(p.limits)) {
            assert.ok(Number.isInteger(value) && value > 0, p.id + ' has a bad ' + key);
        }
    }
});

test('headersFor: uses the auth style each API expects', () => {
    assert.deepEqual(headersFor(providerById('anthropic'), 'k'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    assert.deepEqual(headersFor(providerById('openai'), 'k'), { authorization: 'Bearer k' });
    // Gemini authenticates with a query parameter, so there is no auth header.
    assert.deepEqual(headersFor(providerById('google'), 'k'), {});
});

test('modelUrl: builds each catalogue endpoint', () => {
    assert.equal(modelUrl(providerById('anthropic'), 'k'), 'https://api.anthropic.com/v1/models?limit=100');
    assert.equal(modelUrl(providerById('openai'), 'k'), 'https://api.openai.com/v1/models');
    assert.equal(modelUrl(providerById('google'), 'AIza x'), 'https://generativelanguage.googleapis.com/v1beta/models?key=AIza%20x');
});

test('authRequest: only exists for providers whose catalogue is public', () => {
    assert.equal(authRequest(providerById('openai'), 'k'), null);
    assert.deepEqual(authRequest(providerById('openrouter'), 'k'), {
        url: 'https://openrouter.ai/api/v1/key',
        headers: { authorization: 'Bearer k' }
    });
});

test('parseModels: OpenAI returns data[].id', () => {
    const out = parseModels(providerById('openai'), { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    assert.deepEqual(
        out.map((m) => m.id),
        ['gpt-4o', 'gpt-4o-mini']
    );
});

test('parseModels: Anthropic prefers display_name', () => {
    const out = parseModels(providerById('anthropic'), { data: [{ id: 'claude-x', display_name: 'Claude X' }] });
    assert.deepEqual(out, [{ id: 'claude-x', label: 'Claude X' }]);
});

test('parseModels: Google keeps full model names and filters to generateContent', () => {
    const out = parseModels(providerById('google'), {
        models: [
            { name: 'models/gemini-flash', displayName: 'Gemini Flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-pro', displayName: 'Gemini Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] }
        ]
    });
    assert.deepEqual(
        out.map((m) => m.id),
        ['models/gemini-flash', 'models/gemini-pro']
    );
});

test('parseModels: tolerates a malformed or empty payload', () => {
    assert.deepEqual(parseModels(providerById('openai'), {}), []);
    assert.deepEqual(parseModels(providerById('openai'), null), []);
    assert.deepEqual(parseModels(providerById('google'), { models: [{}] }), []);
});

test('parseModels: sorts by label for display', () => {
    const out = parseModels(providerById('openai'), { data: [{ id: 'z' }, { id: 'a' }] });
    assert.deepEqual(
        out.map((m) => m.id),
        ['a', 'z']
    );
});

test('googleSchema: strips additionalProperties at every depth', () => {
    const input = {
        type: 'object',
        additionalProperties: false,
        properties: {
            title: { type: 'string' },
            nested: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }
        },
        required: ['title']
    };
    const out = googleSchema(input);
    assert.equal('additionalProperties' in out, false);
    assert.equal('additionalProperties' in out.properties.nested, false);
    // Everything else survives.
    assert.deepEqual(out.properties.nested.properties, { a: { type: 'string' } });
    assert.deepEqual(out.required, ['title']);
});

test('estimateCost: exact model prices win over family patterns', () => {
    const data = {
        models: { openai: { 'gpt-test': { input: 2, output: 10 } } },
        families: { openai: [{ match: 'gpt-test', input: 9, output: 9 }] }
    };
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(close(estimateCost(data, 'openai', 'gpt-test', 1e6, 0), 2));
    assert.ok(close(estimateCost(data, 'openai', 'GPT-TEST', 0, 1e6), 10));
});

test('estimateCost: falls back to family patterns and normalizes models/ prefixes', () => {
    const data = { models: {}, families: { google: [{ match: 'gemini-2\\.5-flash', input: 0.3, output: 2.5 }] } };
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(close(estimateCost(data, 'google', 'models/gemini-2.5-flash', 1e6, 0), 0.3));
    assert.ok(close(estimateCost(data, 'google', 'gemini-2.5-flash', 0, 1e6), 2.5));
});

test('estimateCost: returns null for unknown models, providers, and missing data', () => {
    assert.equal(estimateCost({ models: {}, families: {} }, 'openrouter', 'anything', 100, 100), null);
    assert.equal(estimateCost({ models: {}, families: {} }, 'anthropic', 'claude-unknown', 100, 100), null);
    assert.equal(estimateCost(null, 'anthropic', 'claude-sonnet-5', 100, 100), null);
});

test('estimateCost: bundled pricing covers every priced provider', () => {
    for (const provider of ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral', 'together']) {
        assert.ok(pricing.models[provider], provider + ' is missing exact model prices');
        assert.ok(Object.keys(pricing.models[provider]).length > 0, provider + ' has no model prices');
    }
    // Curated family fallbacks still resolve models that the dataset may not list.
    assert.equal(typeof estimateCost(pricing, 'anthropic', 'claude-opus-4-5', 1000, 1000), 'number');
});

test('migrateSettings: first run yields the defaults', () => {
    const s = migrateSettings(null, BASE());
    assert.equal(s.engine, 'cloud');
    assert.equal(s.provider, 'anthropic');
    assert.deepEqual(s.models, {});
    assert.deepEqual(s.apiKeys, {});
});

test('migrateSettings: moves the legacy encrypted key and model to Anthropic', () => {
    const s = migrateSettings({ provider: 'anthropic', model: 'claude-x', apiKeyEnc: 'ENC' }, BASE());
    assert.equal(s.apiKeys.anthropic, 'ENC');
    assert.equal(s.models.anthropic, 'claude-x');
    assert.equal(s.engine, 'cloud');
    assert.equal('apiKeyEnc' in s, false);
    assert.equal('model' in s, false);
});

test('migrateSettings: turns the old "local" provider into the local engine', () => {
    const s = migrateSettings({ provider: 'local', model: 'claude-x' }, BASE());
    assert.equal(s.engine, 'local');
    assert.equal(s.provider, 'anthropic');
    // The legacy model is still preserved for the cloud engine.
    assert.equal(s.models.anthropic, 'claude-x');
});

test('migrateSettings: keeps an existing new-layout selection intact', () => {
    const s = migrateSettings({ engine: 'cloud', provider: 'openai', models: { openai: 'gpt-4o' }, apiKeys: { openai: 'ENC' } }, BASE());
    assert.equal(s.provider, 'openai');
    assert.equal(s.models.openai, 'gpt-4o');
    assert.equal(s.apiKeys.openai, 'ENC');
});

test('migrateSettings: repairs a corrupt models or apiKeys value', () => {
    const s = migrateSettings({ models: 'nope', apiKeys: 42 }, BASE());
    assert.deepEqual(s.models, {});
    assert.deepEqual(s.apiKeys, {});
});
