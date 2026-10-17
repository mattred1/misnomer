const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModels, validatePricing } = require('../scripts/pricing-lib.js');
const bundled = require('../pricing/pricing.json');

test('bundled pricing data: matches the schema', () => {
    assert.deepEqual(validatePricing(bundled), []);
    assert.ok(Object.keys(bundled.models).length >= 5, 'expected exact prices for multiple providers');
});

test('normalizeModels: maps providers, strips prefixes, and converts per-token prices', () => {
    const raw = {
        'claude-sonnet-5': {
            litellm_provider: 'anthropic', mode: 'chat',
            input_cost_per_token: 0.000002, output_cost_per_token: 0.00001
        },
        'groq/openai/gpt-oss-120b': {
            litellm_provider: 'groq', mode: 'chat',
            input_cost_per_token: 0.00000015, output_cost_per_token: 0.0000006
        },
        'together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo': {
            litellm_provider: 'together_ai', mode: 'chat',
            input_cost_per_token: 0.00000104, output_cost_per_token: 0.00000104
        },
        'xai/grok-4.7': {
            litellm_provider: 'xai', mode: 'chat',
            input_cost_per_token: 0.000002, output_cost_per_token: 0.000006
        }
    };
    const models = normalizeModels(raw);
    assert.deepEqual(models.anthropic['claude-sonnet-5'], { input: 2, output: 10 });
    assert.deepEqual(models.groq['openai/gpt-oss-120b'], { input: 0.15, output: 0.6 });
    assert.deepEqual(models.together['meta-llama/llama-3.3-70b-instruct-turbo'], { input: 1.04, output: 1.04 });
    assert.deepEqual(models.xai['grok-4.7'], { input: 2, output: 6 });
});

test('normalizeModels: prefers an unprefixed key over its provider-prefixed alias', () => {
    const raw = {
        'gemini/gemini-2.5-flash': {
            litellm_provider: 'gemini', mode: 'chat',
            input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000025
        },
        'gemini-2.5-flash': {
            litellm_provider: 'gemini', mode: 'chat',
            input_cost_per_token: 0.00000031, output_cost_per_token: 0.0000026
        },
        'models/gemini-2.5-pro': {
            litellm_provider: 'vertex_ai', mode: 'chat',
            input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001
        }
    };
    const models = normalizeModels(raw);
    assert.deepEqual(models.google['gemini-2.5-flash'], { input: 0.31, output: 2.6 });
    assert.deepEqual(models.google['gemini-2.5-pro'], { input: 1.25, output: 10 });
});

test('normalizeModels: skips unsupported providers, non-chat modes, and invalid prices', () => {
    const raw = {
        'text-embedding-3-small': {
            litellm_provider: 'openai', mode: 'embedding',
            input_cost_per_token: 0.00000002, output_cost_per_token: 0
        },
        'mystery-model': {
            litellm_provider: 'some_other_provider', mode: 'chat',
            input_cost_per_token: 0.000001, output_cost_per_token: 0.000002
        },
        'broken-model': {
            litellm_provider: 'openai', mode: 'chat',
            input_cost_per_token: -1, output_cost_per_token: 0.000002
        },
        'huge-model': {
            litellm_provider: 'openai', mode: 'chat',
            input_cost_per_token: 1, output_cost_per_token: 0.000002
        }
    };
    assert.deepEqual(normalizeModels(raw), {});
});

test('validatePricing: reports malformed data', () => {
    assert.ok(validatePricing({ schemaVersion: 2 }).length > 0);
    const bad = {
        schemaVersion: 1,
        generatedAt: 'x',
        source: { url: 'https://example.com' },
        families: { openai: [{ match: '[', input: 1, output: 1 }, { match: 'ok', input: -1, output: 1 }] },
        models: { openai: { 'x': { input: 1, output: 'nope' } } }
    };
    const errors = validatePricing(bad);
    assert.ok(errors.some((e) => e.includes('invalid pattern')));
    assert.ok(errors.some((e) => e.includes('invalid price')));
});
