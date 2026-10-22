// Settings dialog: engine, theme, provider keys/models, local model paths, and presets.
window.Settings = (() => {
    const $ = (s) => document.querySelector(s);
    const { LIST: PROVIDERS, providerById } = window.Providers;

    // The starter preset keeps the first run simple: a single title placeholder.
    const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{title}', sep: '-', dateFormat: 'ymd', extra: '', fields: [] };
    // Older builds seeded first-run settings with the four built-in fields; load()
    // upgrades the untouched starter preset so existing installs pick up the simpler default.
    const LEGACY_DEFAULT_TEMPLATE = '{date}-{entity}-{type}-{title}';

    let deps = null,
        presets = [DEFAULT_PRESET],
        activePreset = 'default',
        refreshSeq = 0;

    const esc = (s) =>
        String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    // A saved key fills the field's placeholder with dots so it reads as a filled
    // password field, making the stored secret obvious without exposing it.
    const KEY_MASK = '\u2022'.repeat(14);
    const hostOf = (url) => {
        try {
            return new URL(url).host;
        } catch {
            return url;
        }
    };

    // Applies the saved theme preference to the document; CSS handles the actual tokens.
    function applyTheme(pref) {
        const theme = ['light', 'dark'].includes(pref) ? pref : 'auto';
        document.documentElement.dataset.theme = theme;
        document.querySelectorAll('input[name=theme]').forEach((r) => {
            r.checked = r.value === theme;
        });
    }
    function syncEngine() {
        const cloud = document.querySelector('input[name=engine]:checked').value === 'cloud';
        $('#apisec').hidden = !cloud;
        $('#localsec').hidden = cloud;
    }

    // Green/amber/red dot plus its caption.
    function setConn(state, text) {
        $('#dot').className = 'dot' + (state ? ' ' + state : '');
        $('#keystat').textContent = text;
    }
    function setModelOptions(list, emptyText, selected) {
        const sel = $('#modelSel');
        if (!list.length) {
            sel.innerHTML = '<option value="">' + esc(emptyText || 'No models') + '</option>';
            sel.disabled = true;
            return '';
        }
        sel.disabled = false;
        sel.innerHTML = list.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('');
        const pick = list.some((m) => m.id === selected) ? selected : list[0].id;
        sel.value = pick;
        return pick;
    }

    // Rebuilds the Cloud API panel for the selected provider: key hint, connection
    // state, and the model list fetched from that provider.
    async function refreshProvider() {
        const seq = ++refreshSeq;
        const s = deps.getSettings();
        const id = $('#providerSel').value;
        const p = providerById(id) || PROVIDERS[0];
        const saved = (s.models || {})[id] || '';
        const tail = (s.keys || {})[id];
        $('#key').placeholder = tail ? KEY_MASK : p.keyHint || 'API key';
        $('#keyhelp').innerHTML = 'Get a key at <a href="#" data-docs="' + esc(p.docs) + '">' + esc(hostOf(p.docs)) + '</a>';

        if (!tail) {
            setConn('', 'No ' + p.name + ' key saved.');
            setModelOptions([], 'Save an API key to load models');
            return;
        }
        setConn('wait', 'Checking connection...');
        setModelOptions([], 'Loading models...');
        const r = await api.listModels(id);
        // A newer selection may have started while this request was in flight.
        if (seq !== refreshSeq) return;
        if (!r.ok) {
            setConn('er', r.error);
            setModelOptions([], 'Could not load models');
            return;
        }
        setConn('ok', 'Connected. Key ends in ' + tail + ', stored encrypted. ' + r.models.length + ' models available.');
        const picked = setModelOptions(r.models, '', saved);
        // First visit, or the saved model is no longer offered: remember what we selected.
        if (picked && picked !== saved) {
            s.models = { ...(s.models || {}), [id]: picked };
            await api.setSettings({ provider: id, model: picked });
        }
    }

    function renderPresetSel() {
        $('#presetSel').innerHTML = presets.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
        $('#presetSel').value = activePreset;
    }
    function currentPresetFields(name, id) {
        return {
            id: id || 'p' + Date.now(),
            name,
            template: $('#tpl').value,
            sep: $('#sep').value,
            dateFormat: $('#datefmt').value,
            extra: $('#extra').value,
            fields: deps.fieldDefs()
        };
    }
    async function persistPresets() {
        await api.setSettings({ presets, activePreset });
    }
    function applyPreset(p) {
        deps.applyTemplate(p);
    }

    async function load(full) {
        // `full` only runs once at startup - load() otherwise fires on every Settings-dialog
        // open and provider change, and reapplying the active preset there would clobber
        // unsaved template edits.
        const s = await api.getSettings();
        deps.setSettings(s);
        applyTheme(s.theme);
        $('#providerSel').innerHTML = PROVIDERS.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
        $('#providerSel').value = s.provider;
        document.querySelector('input[name=engine][value=' + s.engine + ']').checked = true;
        syncEngine();
        $('#lm').textContent = s.localModel || 'None chosen';
        $('#lp').textContent = s.localMmproj || 'None chosen';
        $('#lb').textContent = s.llamaServer || (s.detectedBin ? 'Auto-detected: ' + s.detectedBin : 'Not found');
        await refreshProvider();
        if (!full) return;
        presets = s.presets && s.presets.length ? s.presets : [DEFAULT_PRESET];
        activePreset = presets.find((p) => p.id === s.activePreset) ? s.activePreset : presets[0].id;
        // Upgrade the untouched starter preset from builds that defaulted to four fields.
        const starter = presets.find((p) => p.id === 'default' && p.name === 'Default');
        if (starter && starter.template === LEGACY_DEFAULT_TEMPLATE) {
            starter.template = DEFAULT_PRESET.template;
            persistPresets();
        }
        renderPresetSel();
        const active = presets.find((p) => p.id === activePreset);
        if (active) applyPreset(active);
    }

    function init(options) {
        deps = options;
        $('#presetSel').onchange = () => {
            activePreset = $('#presetSel').value;
            const p = presets.find((x) => x.id === activePreset);
            if (p) applyPreset(p);
            persistPresets();
        };
        $('#presetSave').onclick = () => {
            const name = (window.prompt('Name this preset:', '') || '').trim();
            if (!name) return;
            const p = currentPresetFields(name);
            presets.push(p);
            activePreset = p.id;
            renderPresetSel();
            persistPresets();
        };
        $('#presetUpdate').onclick = () => {
            const i = presets.findIndex((p) => p.id === activePreset);
            if (i < 0) return;
            presets[i] = currentPresetFields(presets[i].name, presets[i].id);
            persistPresets();
        };
        $('#presetDelete').onclick = () => {
            if (presets.length <= 1) {
                deps.message("Can't delete the only preset.");
                return;
            }
            if (!window.confirm('Delete the "' + presets.find((p) => p.id === activePreset).name + '" preset?')) return;
            presets = presets.filter((p) => p.id !== activePreset);
            activePreset = presets[0].id;
            renderPresetSel();
            applyPreset(presets[0]);
            persistPresets();
        };
        document.querySelectorAll('input[name=engine]').forEach(
            (r) =>
                (r.onchange = async () => {
                    await api.setSettings({ engine: r.value });
                    syncEngine();
                })
        );
        document.querySelectorAll('input[name=theme]').forEach(
            (r) =>
                (r.onchange = async () => {
                    applyTheme(r.value);
                    await api.setSettings({ theme: r.value });
                })
        );
        $('#providerSel').onchange = async () => {
            await api.setSettings({ provider: $('#providerSel').value });
            await load();
        };
        $('#modelSel').onchange = () => api.setSettings({ provider: $('#providerSel').value, model: $('#modelSel').value });
        $('#mrefresh').onclick = () => refreshProvider();
        $('#keyhelp').onclick = (e) => {
            const a = e.target.closest('a[data-docs]');
            if (a) {
                e.preventDefault();
                api.open(a.dataset.docs);
            }
        };
        $('#ksave').onclick = async () => {
            const k = $('#key').value.trim();
            if (!k) return;
            const r = await api.setSettings({ provider: $('#providerSel').value, apiKey: k });
            $('#key').value = '';
            if (!r.ok) {
                setConn('er', r.error);
                return;
            }
            await load();
        };
        $('#kdel').onclick = async () => {
            await api.setSettings({ provider: $('#providerSel').value, clearKey: true });
            await load();
        };
        document.querySelectorAll('[data-pick]').forEach(
            (b) =>
                (b.onclick = async () => {
                    const p = await api.pick(b.dataset.pick === 'llamaServer' ? 'bin' : 'gguf');
                    if (p) {
                        await api.setSettings({ [b.dataset.pick]: p });
                        await load();
                    }
                })
        );
        $('#hf').onclick = (e) => {
            e.preventDefault();
            api.open('https://huggingface.co/models?pipeline_tag=image-text-to-text&sort=trending&search=gguf');
        };
    }

    return { init, load };
})();
