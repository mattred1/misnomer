// ZIP export UI. The main process streams the archive and emits progress; this
// module only collects the rows, shows progress, and offers cancellation.
window.Exporter = (() => {
    const $ = (s) => document.querySelector(s);
    const zipBtn = $('#zip'),
        zipBtn2 = $('#zip2'),
        cancelBtn = $('#zipcancel'),
        stat = $('#zipstat'),
        wrap = $('#zipwrap'),
        bar = $('#zipbar'),
        live = $('#zipLive');

    let deps = null,
        busy = false,
        lastMilestone = -1;

    function setBar(percent) {
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        wrap.classList.add('active');
        bar.style.width = value + '%';
        wrap.setAttribute('aria-valuenow', String(value));
    }
    function setStatus(text, percent) {
        stat.textContent = text;
        if (percent == null) {
            wrap.classList.remove('active');
            bar.style.width = '0%';
            wrap.setAttribute('aria-valuenow', '0');
        } else setBar(percent);
    }
    function announce(text) {
        live.textContent = text;
    }
    function reset() {
        busy = false;
        lastMilestone = -1;
        cancelBtn.hidden = true;
        setStatus('', null);
        if (deps) deps.sync();
    }

    async function start() {
        if (busy || !deps) return;
        const all = deps.getFiles(),
            ns = deps.names(),
            entries = [];
        all.forEach((f, i) => {
            if (f.st === 'done') entries.push({ path: f.path, name: ns[i] });
        });
        if (!entries.length) return;

        busy = true;
        lastMilestone = -1;
        cancelBtn.hidden = false;
        setStatus('Preparing archive…', 0);
        announce('Preparing ZIP archive with ' + entries.length + ' files.');
        deps.sync();
        try {
            const r = await api.zipFiles(entries);
            if (r.canceled) {
                deps.message('ZIP export cancelled.');
                announce('ZIP export cancelled.');
            } else if (r.ok) {
                const name = String(r.path || '')
                    .split(/[\\/]/)
                    .pop();
                deps.message('Saved ' + name + ' (' + r.count + ' files).');
                announce('Saved ZIP archive with ' + r.count + ' files.');
            } else {
                deps.message('ZIP export failed: ' + r.error);
                announce('ZIP export failed.');
            }
        } catch (e) {
            deps.message('ZIP export failed: ' + e.message);
            announce('ZIP export failed.');
        } finally {
            reset();
        }
    }

    function init(options) {
        deps = options;
        zipBtn.onclick = start;
        zipBtn2.onclick = start;
        cancelBtn.onclick = () => api.cancelZip();
    }

    if (typeof api !== 'undefined') {
        api.onZipProgress((p) => {
            if (!busy) return;
            const percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
            setStatus('Zipping ' + p.processed + ' of ' + p.total + ' files · ' + percent + '%', percent);
            const milestone = Math.floor(percent / 25) * 25;
            if (percent < 100 && milestone >= 25 && milestone > lastMilestone) {
                lastMilestone = milestone;
                announce('ZIP archive ' + percent + ' percent complete.');
            }
        });
    }

    return { init, isBusy: () => busy };
})();
