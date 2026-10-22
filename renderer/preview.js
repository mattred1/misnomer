// Name-template preview, placeholder chips, and custom-field parsing.
window.Preview = (() => {
    const $ = (s) => document.querySelector(s);
    const { build, placeholders, slug } = window.Naming;
    const Exif = window.Exif;

    const RESERVED_KEYS = ['title', 'entity', 'date', 'type'];
    // Sample values used only to render the template preview, never sent anywhere.
    const SAMPLE = { date: '2026-03-01', entity: 'acme', type: 'invoice', title: 'march service call' };

    let deps = null,
        lastSep = '-';

    // Custom fields are stored as one "name = description" per line.
    const fieldKey = (s) =>
        (s || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 30);

    function fieldDefs() {
        const defs = $('#fields')
            .value.split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const i = line.indexOf('=');
                return { key: fieldKey(i < 0 ? line : line.slice(0, i)), description: i < 0 ? '' : line.slice(i + 1).trim() };
            })
            .filter((f) => f.key);
        // A custom field may not shadow a built-in one; those are configured elsewhere in the UI.
        return defs.filter((f, i) => !RESERVED_KEYS.includes(f.key) && defs.findIndex((x) => x.key === f.key) === i);
    }

    // Rewrites separator characters already visible in the template input so the raw
    // text matches the newly chosen separator, instead of only affecting names.
    function retext(oldSep, newSep) {
        if (oldSep === newSep) return;
        let v = $('#tpl').value;
        v = oldSep ? v.split(oldSep).join(newSep) : v.replace(/\}\{/g, '}' + newSep + '{');
        $('#tpl').value = v;
    }

    function retpl() {
        const sep = $('#sep').value;
        deps.getFiles().forEach((f) => {
            if (f.info && !f.edited) {
                f.name = build(f.info, $('#tpl').value, sep);
                deps.paint(f);
            }
        });
        renderChips();
        preview();
        deps.hints();
    }

    function renderChips() {
        const defs = fieldDefs();
        const entries = RESERVED_KEYS.map((key) => ({ key, custom: false })).concat(
            defs.map((f) => ({ key: f.key, custom: true, description: f.description }))
        );
        $('#chips').innerHTML = '';
        for (const { key, custom, description } of entries) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = '{' + key + '}';
            if (custom) b.className = 'cust';
            if (description) b.title = description;
            b.onclick = () => {
                const v = $('#tpl').value.trim(),
                    sep = $('#sep').value;
                // A separator only belongs between fields, never before the first one.
                $('#tpl').value = v ? v + (v.endsWith(sep) ? '' : sep) + '{' + key + '}' : '{' + key + '}';
                retpl();
            };
            $('#chips').append(b);
        }
    }

    // Shows what the template produces with sample data, and flags placeholders no field will fill.
    // The result is drawn as coloured tokens so each placeholder's contribution is easy to scan.
    function preview() {
        const t = $('#tpl').value,
            sep = $('#sep').value,
            defs = fieldDefs();
        const used = placeholders(t),
            known = RESERVED_KEYS.concat(defs.map((f) => f.key));
        const unknown = used.filter((k) => !known.includes(k));
        const custIndex = (k) => defs.findIndex((d) => d.key === k);
        const sample = { ...SAMPLE, date: Exif.formatDate(SAMPLE.date, $('#datefmt').value) };
        for (const d of defs) sample[d.key] = d.key;
        const built = build(sample, t, sep);

        // Split the template into literal text and placeholders, slug each part the same way
        // build() slugs the whole string, then join the non-empty parts with the separator.
        const parts = [];
        let last = 0;
        for (const m of t.matchAll(/\{(\w+)\}/g)) {
            if (m.index > last) parts.push({ text: slug(t.slice(last, m.index), sep) });
            parts.push({ key: m[1], text: slug(sample[m[1]] || '', sep) });
            last = m.index + m[0].length;
        }
        if (last < t.length) parts.push({ text: slug(t.slice(last), sep) });
        const tokens = parts.filter((p) => p.text);

        const pv = $('#pv');
        pv.textContent = '';
        // Tokenizing matches build() for normal templates; if an odd literal breaks that
        // equivalence, show build()'s exact output rather than a misleading preview.
        if (tokens.map((p) => p.text).join(sep) === built) {
            tokens.forEach((p, i) => {
                if (i && sep) {
                    const s = document.createElement('span');
                    s.className = 'sep';
                    s.textContent = sep;
                    pv.append(s);
                }
                const span = document.createElement('span');
                if (p.key) {
                    const ci = custIndex(p.key);
                    span.className = 'tok' + (ci >= 0 ? ' cust' : '');
                    span.dataset.key = p.key;
                    if (ci >= 0 && defs[ci].description) span.title = defs[ci].description;
                } else span.className = 'lit';
                span.textContent = p.text;
                pv.append(span);
            });
        } else pv.textContent = built;
        pv.title = built + '.pdf';

        $('#pvnote').textContent = unknown.length ? 'Unknown placeholder(s): ' + unknown.map((k) => '{' + k + '}').join(', ') : '';
        $('#pvnote').className = unknown.length ? 'mut bad' : 'mut';
    }

    function applyTemplate(p) {
        $('#tpl').value = p.template;
        $('#sep').value = p.sep;
        $('#datefmt').value = p.dateFormat;
        $('#extra').value = p.extra || '';
        $('#fields').value = (p.fields || []).map((f) => f.key + (f.description ? ' = ' + f.description : '')).join('\n');
        lastSep = p.sep;
        retpl();
    }

    function init(options) {
        deps = options;
        lastSep = $('#sep').value;
        $('#tpl').oninput = retpl;
        $('#fields').oninput = () => {
            renderChips();
            preview();
        };
        $('#sep').onchange = () => {
            retext(lastSep, $('#sep').value);
            lastSep = $('#sep').value;
            retpl();
        };
        $('#datefmt').onchange = preview;
        renderChips();
        preview();
    }

    return { init, fieldDefs, applyTemplate };
})();
