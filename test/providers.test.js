const test = require('node:test');
const assert = require('node:assert/strict');
const { LIST, providerById, headersFor, modelUrl, authRequest, parseModels, googleSchema, migrateSettings, estimateCost } = require('../renderer/providers.js');

const BASE = () => ({
    engine: 'cloud', provider: 'anthropic', models: {}, apiKeys: {},
    localModel: '', localMmproj: '', llamaServer: '', presets: [], activePreset: 'default'
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
    assert.deepEqual(out.map((m) => m.id), ['gpt-4o', 'gpt-4o-mini']);
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
    assert.deepEqual(out.map((m) => m.id), ['models/gemini-flash', 'models/gemini-pro']);
});

test('parseModels: tolerates a malformed or empty payload', () => {
    assert.deepEqual(parseModels(providerById('openai'), {}), []);
    assert.deepEqual(parseModels(providerById('openai'), null), []);
    assert.deepEqual(parseModels(providerById('google'), { models: [{}] }), []);
});

test('parseModels: sorts by label for display', () => {
    const out = parseModels(providerById('openai'), { data: [{ id: 'z' }, { id: 'a' }] });
    assert.deepEqual(out.map((m) => m.id), ['a', 'z']);
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

test('estimateCost: prices known models from every supported provider', () => {
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(close(estimateCost('anthropic', 'claude-sonnet-5', 1e6, 0), 2));
    assert.ok(close(estimateCost('anthropic', 'claude-opus-4-5-20251101', 0, 1e6), 25));
    assert.ok(close(estimateCost('openai', 'gpt-6-luna', 1e6, 1e6), 0.6));
    assert.ok(close(estimateCost('google', 'models/gemini-2.5-flash', 1e6, 0), 0.3));
    assert.ok(close(estimateCost('deepseek', 'deepseek-flash', 0, 1e6), 1.2));
    assert.ok(close(estimateCost('xai', 'grok-4.7', 1e6, 0), 2));
    assert.ok(close(estimateCost('mistral', 'mistral-large-latest', 1e6, 0), 0.5));
    assert.ok(close(estimateCost('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', 1e6, 0), 1.04));
});

test('estimateCost: returns null when the model or provider has no price table', () => {
    assert.equal(estimateCost('openrouter', 'anything', 100, 100), null);
    assert.equal(estimateCost('groq', 'llama-3.3-70b', 100, 100), null);
    assert.equal(estimateCost('local', 'whatever', 100, 100), null);
    assert.equal(estimateCost('anthropic', 'claude-unknown', 100, 100), null);
    assert.equal(estimateCost('openai', '', 100, 100), null);
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
