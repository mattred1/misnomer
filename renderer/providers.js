// Registry of cloud providers plus the small request-shape helpers that differ
// between them. UMD so main.js can require it and the renderer can load it as a script.
//
// `kind` selects the adapter in main.js:
//   anthropic - Anthropic Messages API
//   openai    - OpenAI-compatible chat completions (most vendors speak this)
//   google    - Gemini generateContent
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Providers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const LIST = [
        {
            id: 'anthropic', name: 'Anthropic', kind: 'anthropic', base: 'https://api.anthropic.com',
            keyHint: 'sk-ant-...', docs: 'https://console.anthropic.com/settings/keys'
        },
        {
            id: 'openai', name: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1',
            keyHint: 'sk-...', docs: 'https://platform.openai.com/api-keys'
        },
        {
            id: 'google', name: 'Google Gemini', kind: 'google', base: 'https://generativelanguage.googleapis.com/v1beta',
            keyHint: 'AIza...', docs: 'https://aistudio.google.com/apikey'
        },
        {
            id: 'xai', name: 'xAI', kind: 'openai', base: 'https://api.x.ai/v1',
            keyHint: 'xai-...', docs: 'https://console.x.ai'
        },
        {
            id: 'deepseek', name: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com/v1',
            keyHint: 'sk-...', docs: 'https://platform.deepseek.com/api_keys'
        },
        {
            id: 'openrouter', name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1',
            keyHint: 'sk-or-...', docs: 'https://openrouter.ai/keys',
            // The model catalogue is public, so listing models proves nothing about the key.
            authCheck: '/key'
        },
        {
            id: 'groq', name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1',
            keyHint: 'gsk_...', docs: 'https://console.groq.com/keys'
        },
        {
            id: 'mistral', name: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai/v1',
            keyHint: 'your API key', docs: 'https://console.mistral.ai/api-keys'
        },
        {
            id: 'together', name: 'Together AI', kind: 'openai', base: 'https://api.together.xyz/v1',
            keyHint: 'your API key', docs: 'https://api.together.ai/settings/api-keys'
        }
    ];

    const providerById = (id) => LIST.find((p) => p.id === id);

    function headersFor(p, key) {
        if (!p) return {};
        // Gemini takes the key as a query parameter rather than a header.
        if (p.kind === 'google') return {};
        if (p.kind === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
        return { authorization: 'Bearer ' + key };
    }

    function modelUrl(p, key) {
        if (p.kind === 'google') return p.base + '/models?key=' + encodeURIComponent(key);
        if (p.kind === 'anthropic') return p.base + '/v1/models?limit=100';
        return p.base + '/models';
    }

    // Providers whose model catalogue is public still need a separate key check.
    function authRequest(p, key) {
        if (!p || !p.authCheck) return null;
        return { url: p.base + p.authCheck, headers: headersFor(p, key) };
    }

    // Normalizes the three catalogue shapes into [{ id, label }], sorted for display.
    function parseModels(p, json) {
        const j = json || {};
        let rows = [];
        if (p && p.kind === 'google') {
            rows = (j.models || [])
                .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
                .map((m) => ({ id: m.name, label: m.displayName || String(m.name || '').replace(/^models\//, '') }));
        } else if (p && p.kind === 'anthropic') {
            rows = (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
        } else {
            rows = (j.data || []).map((m) => ({ id: m.id, label: m.name || m.id }));
        }
        return rows
            .filter((m) => m.id)
            .sort((a, b) => String(a.label).localeCompare(String(b.label)));
    }

    // Gemini's responseSchema is an OpenAPI subset and rejects additionalProperties.
    function googleSchema(node) {
        if (Array.isArray(node)) return node.map(googleSchema);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const [k, v] of Object.entries(node)) {
            if (k === 'additionalProperties') continue;
            out[k] = googleSchema(v);
        }
        return out;
    }

    // Normalizes stored settings, including the single-provider layout that predates
    // this list: one encrypted key and one model at the top level, with provider
    // meaning the engine ('anthropic' or 'local').
    function migrateSettings(parsed, base) {
        const s = { ...(base || {}), ...(parsed || {}) };
        if (!s.models || typeof s.models !== 'object') s.models = {};
        if (!s.apiKeys || typeof s.apiKeys !== 'object') s.apiKeys = {};
        if (s.apiKeyEnc && !s.apiKeys.anthropic) s.apiKeys.anthropic = s.apiKeyEnc;
        if (s.model && !s.models.anthropic) s.models.anthropic = s.model;
        if (s.provider === 'local') { s.engine = 'local'; s.provider = 'anthropic'; }
        if (!s.engine) s.engine = 'cloud';
        delete s.apiKeyEnc;
        delete s.model;
        return s;
    }

    return { LIST, providerById, headersFor, modelUrl, authRequest, parseModels, googleSchema, migrateSettings };
});
