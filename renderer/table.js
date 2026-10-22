// Results table: row creation, status painting, collision hints, and usage totals.
window.Table = (() => {
    const $ = (s) => document.querySelector(s);
    const { clean } = window.Naming;

    let deps = null;

    function init(options) {
        deps = options;
    }

    function row(f) {
        $('#tc').hidden = false;
        const tr = document.createElement('tr');
        tr.id = 'r' + f.id;
        tr.innerHTML =
            '<td><div class="thumb"><span>' +
            f.ext.toUpperCase() +
            '</span></div></td>' +
            '<td class="o"></td><td><div class="nm"><input type="text"><span>.' +
            f.ext +
            '</span></div><div class="mut hint" id="h' +
            f.id +
            '"></div></td><td><span class="st"></span></td><td><button class="d">Save copy</button></td>';
        tr.querySelector('.o').textContent = f.original;
        tr.querySelector('.o').title = f.path;
        const inp = tr.querySelector('input');
        inp.value = f.name;
        inp.setAttribute('aria-describedby', 'h' + f.id);
        inp.oninput = () => {
            f.name = inp.value;
            f.edited = true;
            hints();
        };
        tr.querySelector('.d').onclick = async () => {
            const r = await deps.api.readFile(f.path);
            if (!r.ok) {
                deps.message('Could not read ' + f.original + ': ' + r.error);
                return;
            }
            deps.save(fin(f), r.bytes);
        };
        $('#tb').append(tr);
        paint(f);
        window.Thumbs.observe(f, tr.querySelector('.thumb'));
    }

    function paint(f) {
        const tr = $('#r' + f.id);
        if (!tr) return;
        const inp = tr.querySelector('input');
        if (document.activeElement !== inp) inp.value = f.name;
        inp.setAttribute('aria-label', 'New name for ' + f.original);
        const thumb = tr.querySelector('.thumb');
        if (thumb && thumb.classList.contains('has')) {
            thumb.dataset.label = f.original;
            thumb.setAttribute('aria-label', 'Preview ' + f.original);
        }
        const lab =
            f.st === 'queued' && deps.isPaused()
                ? ['Paused', 'mut']
                : f.st === 'done' && f.renamed
                  ? ['Renamed', 'ok']
                  : {
                        queued: ['Queued', 'mut'],
                        working: ['Reading...', 'work'],
                        done: ['Done', 'ok'],
                        error: ['Failed', 'er'],
                        skipped: ['Skipped', 'mut']
                    }[f.st];
        const s = tr.querySelector('.st');
        s.className = 'st ' + lab[1];
        s.textContent = lab[0];
        s.title = f.note;
        const save = tr.querySelector('.d');
        save.disabled = f.st === 'working';
        save.setAttribute('aria-label', 'Save a copy of ' + f.original);
    }

    const fin = (f) => deps.names()[deps.getFiles().indexOf(f)];

    function hints() {
        const files = deps.getFiles(),
            ns = deps.names();
        files.forEach((f, i) => {
            const h = document.querySelector('#r' + f.id + ' .hint');
            if (!h) return;
            const notes = [];
            if (f.note) notes.push(f.note);
            else if (f.info && f.info.dateSource === 'exif') notes.push('date from EXIF');
            if (ns[i] !== clean(f.name) + '.' + f.ext) notes.push('duplicate, saves as ' + ns[i]);
            const text = notes.join(' \u00b7 ');
            h.textContent = text;
            h.title = text;
            h.classList.toggle('er', !!f.note && !!f.error);
        });
    }

    function fmtTokens(n) {
        const v = Number(n) || 0;
        if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
        return String(v);
    }

    // Batch totals across every row that returned usage. Cost is shown only when
    // each provider response could be matched to a known list price.
    function renderUsage() {
        const used = deps.getFiles().filter((f) => f.usage);
        const el = $('#usage');
        if (!used.length) {
            el.textContent = '';
            return;
        }
        let input = 0,
            output = 0,
            cost = 0,
            priced = 0;
        for (const f of used) {
            input += f.usage.input || 0;
            output += f.usage.output || 0;
            if (typeof f.usage.cost === 'number') {
                cost += f.usage.cost;
                priced++;
            }
        }
        const parts = [fmtTokens(input) + ' in', fmtTokens(output) + ' out'];
        if (used.every((f) => f.usage.local)) parts.push('local, no API cost');
        else if (priced === used.length) parts.push('est. $' + (cost > 0 && cost < 0.0001 ? '<0.0001' : cost.toFixed(4)));
        else if (priced) parts.push('est. $' + cost.toFixed(4) + ' for ' + priced + ' of ' + used.length + ' files');
        el.textContent = 'Usage: ' + parts.join(' \u00b7 ');
    }

    function clear() {
        $('#tb').innerHTML = '';
        $('#tc').hidden = true;
    }

    return { init, row, paint, paintAll: () => deps.getFiles().forEach(paint), hints, renderUsage, clear };
})();
