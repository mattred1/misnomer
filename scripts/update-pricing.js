'use strict';

// Refreshes pricing/pricing.json from LiteLLM's MIT-licensed dataset.
// Run manually with `npm run pricing:update`, or weekly via the pricing workflow.
// The curated `families` block is never overwritten; only `models` is regenerated.

const fs = require('fs/promises');
const path = require('path');
const { normalizeModels, validatePricing } = require('./pricing-lib.js');

const SOURCE_URL = process.env.PRICING_SOURCE_URL
    || 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FILE = path.join(__dirname, '..', 'pricing', 'pricing.json');
const MIN_MODELS = 50;

async function main() {
    const current = JSON.parse(await fs.readFile(FILE, 'utf8'));
    const res = await fetch(SOURCE_URL, {
        headers: { accept: 'application/json', 'user-agent': 'misnomer-pricing-updater' },
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('Pricing source returned HTTP ' + res.status);
    const models = normalizeModels(await res.json());
    const count = Object.values(models).reduce((n, entries) => n + Object.keys(entries).length, 0);
    // A truncated or reorganized source should never wipe the bundled table.
    if (count < MIN_MODELS) throw new Error('Only ' + count + ' models parsed; refusing to overwrite pricing data.');

    const next = { ...current, schemaVersion: 1, source: { ...current.source, url: SOURCE_URL }, models };
    const unchanged = current.schemaVersion === next.schemaVersion
        && current.source?.url === next.source.url
        && JSON.stringify(current.models) === JSON.stringify(next.models);
    if (unchanged) {
        console.log('Pricing is already up to date (' + count + ' models).');
        return;
    }

    next.generatedAt = new Date().toISOString();
    const errors = validatePricing(next);
    if (errors.length) throw new Error('Invalid pricing data:\n' + errors.join('\n'));
    await fs.writeFile(FILE, JSON.stringify(next, null, 2) + '\n');
    console.log('Updated ' + count + ' model prices.');
}

main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
