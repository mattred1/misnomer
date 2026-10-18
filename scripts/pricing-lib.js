'use strict';

// Pure helpers for turning the LiteLLM pricing dataset into the compact shape the
// app consumes. Kept separate from the network-facing updater so it can be tested.

const PROVIDER_ALIASES = {
    anthropic: 'anthropic',
    openai: 'openai',
    gemini: 'google',
    vertex_ai: 'google',
    deepseek: 'deepseek',
    xai: 'xai',
    mistral: 'mistral',
    groq: 'groq',
    together_ai: 'together',
    openrouter: 'openrouter'
};
const CHAT_MODES = new Set(['chat', 'completion']);
const MAX_PRICE = 10000;

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const validPrice = (n) => Number.isFinite(n) && n >= 0 && n <= MAX_PRICE;

// LiteLLM keys often carry the provider as a prefix (gemini/gemini-2.5-flash,
// together_ai/meta-llama/..., groq/openai/gpt-oss-120b). Strip exactly one prefix
// so the key matches the model ID the app receives from that provider.
function splitId(key, provider) {
    const id = String(key).toLowerCase();
    const slash = id.indexOf('/');
    if (slash > 0) {
        const head = id.slice(0, slash);
        if (head === String(provider).toLowerCase() || head === 'models') {
            return { id: id.slice(slash + 1), prefixed: true };
        }
    }
    return { id, prefixed: false };
}

// Returns { providerId: { modelId: { input, output } } } in USD per 1M tokens.
// Exact IDs are preferred; equal aliases from different keys resolve to the same entry.
function normalizeModels(raw) {
    const buckets = {};
    for (const [key, entry] of Object.entries(raw || {})) {
        if (!entry || typeof entry !== 'object') continue;
        const provider = PROVIDER_ALIASES[entry.litellm_provider];
        if (!provider) continue;
        if (entry.mode && !CHAT_MODES.has(entry.mode)) continue;
        const input = round6(Number(entry.input_cost_per_token) * 1e6);
        const output = round6(Number(entry.output_cost_per_token) * 1e6);
        if (!validPrice(input) || !validPrice(output)) continue;
        const { id, prefixed } = splitId(key, entry.litellm_provider);
        if (!id) continue;
        if (!buckets[provider]) buckets[provider] = {};
        const current = buckets[provider][id];
        // Prefer an unprefixed key over a provider-prefixed alias when both exist.
        if (!current || (current.prefixed && !prefixed)) buckets[provider][id] = { input, output, prefixed };
    }

    const out = {};
    for (const provider of Object.keys(buckets).sort()) {
        out[provider] = {};
        for (const id of Object.keys(buckets[provider]).sort()) {
            out[provider][id] = { input: buckets[provider][id].input, output: buckets[provider][id].output };
        }
    }
    return out;
}

// Validates a written pricing file. Returns an array of human-readable errors.
function validatePricing(data) {
    const errors = [];
    if (!data || typeof data !== 'object') return ['pricing data must be an object'];
    if (data.schemaVersion !== 1) errors.push('schemaVersion must be 1');
    if (typeof data.generatedAt !== 'string' || !data.generatedAt) errors.push('generatedAt must be a string');
    if (!data.source || typeof data.source.url !== 'string') errors.push('source.url must be a string');

    for (const [provider, rows] of Object.entries(data.families || {})) {
        if (!Array.isArray(rows)) {
            errors.push('families.' + provider + ' must be an array');
            continue;
        }
        for (const row of rows) {
            if (!row || typeof row.match !== 'string') {
                errors.push('families.' + provider + ' has an entry without a match pattern');
                continue;
            }
            try {
                new RegExp(row.match);
            } catch {
                errors.push('families.' + provider + ' has an invalid pattern: ' + row.match);
            }
            if (!validPrice(Number(row.input)) || !validPrice(Number(row.output)))
                errors.push('families.' + provider + ' has an invalid price for ' + row.match);
        }
    }

    for (const [provider, entries] of Object.entries(data.models || {})) {
        if (!entries || typeof entries !== 'object') {
            errors.push('models.' + provider + ' must be an object');
            continue;
        }
        for (const [id, row] of Object.entries(entries)) {
            if (!id) errors.push('models.' + provider + ' has an empty model id');
            if (!row || !validPrice(Number(row.input)) || !validPrice(Number(row.output)))
                errors.push('models.' + provider + '.' + id + ' has an invalid price');
        }
    }
    return errors;
}

module.exports = { normalizeModels, validatePricing, MAX_PRICE };
