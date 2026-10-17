// Path and rename planning. Deliberately free of fs so it can be unit tested;
// main.js performs the actual file operations.
//
// UMD for the same reason as naming.js: window.Rename in the renderer, require() in tests.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Rename = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const lastSep = (p) => {
        const s = String(p);
        return Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    };
    const dirOf = (p) => {
        const i = lastSep(p);
        return i < 0 ? '' : String(p).slice(0, i);
    };
    const baseOf = (p) => {
        const i = lastSep(p);
        return i < 0 ? String(p) : String(p).slice(i + 1);
    };
    const joinPath = (dir, name) => (dir ? String(dir).replace(/[\\/]+$/, '') + '/' + name : name);
    const lower = (s) => String(s).toLowerCase();

    // Directory keys arrive in whatever case the filesystem reports, while lookups
    // here are case-insensitive, so fold the keys once up front.
    function indexExisting(existing) {
        const out = {};
        for (const dir of Object.keys(existing || {})) {
            const key = lower(dir);
            if (!out[key]) out[key] = [];
            out[key].push(...((existing[dir]) || []));
        }
        return out;
    }

    // items:    [{ id, from, name, ext }] - `name` is the desired base name, `from` the current path
    // existing: { [dir]: [filename, ...] } - what is currently on disk; keys are matched case-insensitively
    //
    // Returns one entry per item: { id, from, dir, target, path, changed, caseOnly }.
    // `changed` is false when the file already has the desired name, so callers can skip it.
    function planRenames(items, existing) {
        const onDisk = indexExisting(existing);
        const disk = {}, claimed = {}, out = [];
        for (const it of items || []) {
            const dir = dirOf(it.from);
            const key = lower(dir);
            const original = baseOf(it.from);
            if (!disk[key]) disk[key] = new Set((onDisk[key] || []).map(lower));
            if (!claimed[key]) claimed[key] = new Set();

            const candidate = (n) => it.name + (n > 1 ? '-' + n : '') + '.' + it.ext;
            const noop = candidate(1) === original;
            // A case-only rename resolves to the same file on a case-insensitive volume,
            // so it must not be treated as colliding with itself.
            const caseOnly = !noop && lower(candidate(1)) === lower(original);

            const taken = (name) => {
                const l = lower(name);
                if (caseOnly && l === lower(original)) return false;
                if (claimed[key].has(l)) return true;
                return disk[key].has(l) && l !== lower(original);
            };

            let n = 1, target = candidate(n);
            while (!noop && taken(target)) target = candidate(++n);

            claimed[key].add(lower(target));
            out.push({ id: it.id, from: it.from, dir, target, path: joinPath(dir, target), changed: !noop, caseOnly });
        }
        return out;
    }

    // entries: [{ id, from, to }] in the order the renames were applied.
    // Reverting walks backwards so a chain of renames unwinds in the opposite order.
    // Returns entries with `ok` and, when not ok, a `reason` of 'missing' or 'occupied'.
    function planUndo(entries, existing) {
        const onDisk = indexExisting(existing);
        const disk = {}, claimed = {}, out = [];
        for (const e of [...(entries || [])].reverse()) {
            const rev = { id: e.id, from: e.to, to: e.from };
            const key = lower(dirOf(rev.to));
            if (!disk[key]) disk[key] = new Set((onDisk[key] || []).map(lower));
            if (!claimed[key]) claimed[key] = new Set();

            const fromName = lower(baseOf(rev.from));
            const toName = lower(baseOf(rev.to));
            const exists = disk[key].has(fromName) || claimed[key].has(fromName);
            // Reverting is only safe if the renamed file is still there and the
            // original name has not been taken by something else.
            if (!exists) out.push({ ...rev, ok: false, reason: 'missing' });
            else if (toName !== fromName && (disk[key].has(toName) || claimed[key].has(toName))) out.push({ ...rev, ok: false, reason: 'occupied' });
            else {
                claimed[key].add(toName);
                out.push({ ...rev, ok: true });
            }
        }
        return out;
    }

    // Distinct directories, for looking up what already exists on disk.
    function dirsOf(paths) {
        const seen = [];
        for (const p of paths || []) {
            const d = dirOf(p);
            if (!seen.includes(d)) seen.push(d);
        }
        return seen;
    }

    return { dirOf, baseOf, joinPath, planRenames, planUndo, dirsOf };
});
