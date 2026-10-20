// Archive entry naming and deduplication. Kept free of fs so it can be unit
// tested; main.js streams the actual files into the archive.
//
// UMD for the same reason as naming.js: require() in tests and main.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ZipEntries = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_NAME = 180;

    // Archives are flat: strip any path components so an entry can never escape
    // the extraction directory, then remove characters that break common tools.
    function entryName(name) {
        let base = String(name == null ? '' : name)
            .split(/[\\/]/)
            .pop()
            .replace(/[\u0000-\u001f\u007f]/g, '') // eslint-disable-line no-control-regex -- stripping control characters is the point
            .replace(/[<>:"|?*]/g, '_')
            .replace(/^\.+/, '')
            .replace(/[. ]+$/, '')
            .trim();
        if (!base) base = 'unnamed';
        if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME).replace(/[. ]+$/, '');
        return base || 'unnamed';
    }

    function unique(name, used) {
        const key = name.toLowerCase();
        if (!used.has(key)) {
            used.add(key);
            return name;
        }
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        for (let i = 2; ; i++) {
            const candidate = stem + ' (' + i + ')' + ext;
            if (!used.has(candidate.toLowerCase())) {
                used.add(candidate.toLowerCase());
                return candidate;
            }
        }
    }

    // entries: [{ path, name }] where `name` is the desired filename in the ZIP.
    function plan(entries) {
        const used = new Set();
        return (entries || [])
            .filter((entry) => entry && entry.path)
            .map((entry) => ({ path: String(entry.path), name: unique(entryName(entry.name), used) }));
    }

    return { entryName, plan };
});
