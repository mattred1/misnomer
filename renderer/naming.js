// Naming logic, kept free of DOM and Electron dependencies so it can be unit tested
// with `node --test` while still loading as a plain <script> in the renderer.
//
// In the renderer this exposes `window.Naming`. In Node it exports the same object.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Naming = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Base names are capped well below the OS component limit so that an extension,
    // a duplicate suffix, and the surrounding path still fit inside MAX_PATH on Windows.
    const MAX_BASE = 120;
    const MAX_SLUG = 80;

    // Windows reserves these device names in every directory, with or without an extension,
    // so "con.txt" is just as unusable as "con". Matching is case-insensitive.
    const RESERVED = new Set([
        'con', 'prn', 'aux', 'nul',
        ...Array.from({ length: 9 }, (_, i) => 'com' + (i + 1)),
        ...Array.from({ length: 9 }, (_, i) => 'lpt' + (i + 1))
    ]);

    const stripTrailing = (s) => s.replace(/[. ]+$/, '');
    const isReserved = (s) => RESERVED.has(stripTrailing(s).split('.')[0].toLowerCase());

    // Lowercase, strip accents, and reduce everything that is not a letter or digit
    // to the chosen separator. An empty separator runs the words together.
    function slug(s, sep) {
        const cleaned = (s || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, sep);
        if (!sep) return cleaned.slice(0, MAX_SLUG);
        const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return cleaned.replace(new RegExp('^' + esc + '+|' + esc + '+$', 'g'), '').slice(0, MAX_SLUG);
    }

    // Fill the {placeholder} slots from a model result and slugify the whole thing.
    // Any {name} is accepted so users can define their own fields; unknown keys fill empty.
    function build(info, template, sep) {
        const filled = String(template).replace(/\{(\w+)\}/g, (_, k) => ' ' + ((info && info[k]) || '') + ' ');
        return slug(filled, sep) || 'unnamed';
    }

    // The distinct placeholder names referenced by a template, in order of first appearance.
    function placeholders(template) {
        const out = [];
        for (const m of String(template).matchAll(/\{(\w+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
        return out;
    }

    // Make a user- or model-supplied name safe to write to disk on macOS, Windows, and Linux.
    function clean(n) {
        let s = String(n == null ? '' : n)
            .replace(/[\t\n\r\v\f]+/g, ' ')         // whitespace-like controls are word breaks, not deletions
            // eslint-disable-next-line no-control-regex -- rejecting control characters is the whole point here
            .replace(/[\u0000-\u001f\u007f]+/g, '') // any other control character is dropped
            .replace(/[\\/:*?"<>|]+/g, '-')         // illegal on Windows
            .replace(/\s+/g, ' ')
            .trim();
        s = stripTrailing(s);
        if (!s) return 'unnamed';
        if (isReserved(s)) s = '_' + s;
        if (s.length > MAX_BASE) s = stripTrailing(s.slice(0, MAX_BASE));
        return s || 'unnamed';
    }

    const extOf = (n) => (n.split('.').pop() || '').toLowerCase();

    // Compute the final filenames for a batch, appending -2, -3, ... when two rows
    // would otherwise collide. Comparison is case-insensitive because Windows and
    // default macOS volumes are case-insensitive.
    function names(items) {
        const seen = {};
        return (items || []).map((f) => {
            const b = clean(f.name);
            let k = b + '.' + f.ext, n = 1;
            while (seen[k.toLowerCase()]) k = b + '-' + (++n) + '.' + f.ext;
            seen[k.toLowerCase()] = 1;
            return k;
        });
    }

    return { slug, build, clean, extOf, names, placeholders, isReserved, MAX_BASE, MAX_SLUG, RESERVED };
});
