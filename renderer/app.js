const $ = (s) => document.querySelector(s), files = [];
let S = {}, halt = false, busy = false, uid = 0, haltFile = null, cancelled = false;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

// The <option value="..."> ids in the #datefmt select must match main.js's DATE_HINTS keys -
// the hint text itself lives there since that's what actually goes into the model prompt / schema.
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{date}-{entity}-{type}-{title}', sep: '-', dateFormat: 'ymd', extra: '', fields: [] };
let presets = [DEFAULT_PRESET], activePreset = 'default', lastSep = DEFAULT_PRESET.sep;

// Rewrites the separator characters already visible in the template input so the raw text
// matches the newly chosen separator, instead of only affecting names behind the scenes.
function retext(oldSep, newSep) {
    if (oldSep === newSep) return;
    let v = $('#tpl').value;
    v = oldSep ? v.split(oldSep).join(newSep) : v.replace(/\}\{/g, '}' + newSep + '{');
    $('#tpl').value = v;
}

// Naming helpers live in naming.js so they can be unit tested with `node --test`.
const { build, clean, extOf, placeholders } = window.Naming;
const names = () => window.Naming.names(files);
const Extract = window.Extract;

const RESERVED_KEYS = ['title', 'entity', 'date', 'type'];
// Chromium can decode these but the model APIs reject them, so they go through a canvas.
const CANVAS_CONVERT = ['bmp', 'ico', 'svg', 'avif'];
// Chromium cannot decode these at all, so they go through macOS sips in the main process.
const SIPS_CONVERT = ['tif', 'tiff', 'heic', 'heif'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', ...CANVAS_CONVERT, ...SIPS_CONVERT];
const OK_EXT = ['pdf', ...IMAGE_EXT, ...Extract.OK_EXT];
const OK_HINT = 'PDF, images (PNG, JPG, GIF, WebP, BMP, ICO, SVG, AVIF, TIFF, HEIC), and text or Office files (TXT, MD, CSV, JSON, RTF, DOCX, XLSX, PPTX, ODT, EPUB)';

// Sample values used only to render the template preview, never sent anywhere.
const SAMPLE = { date: '2026-03-01', entity: 'acme', type: 'invoice', title: 'march service call' };

// Custom fields are stored as one "name = description" per line.
const fieldKey = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
function fieldDefs() {
    const defs = $('#fields').value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const i = line.indexOf('=');
        return { key: fieldKey(i < 0 ? line : line.slice(0, i)), description: i < 0 ? '' : line.slice(i + 1).trim() };
    }).filter((f) => f.key);
    // A custom field may not shadow a built-in one; those are configured elsewhere in the UI.
    return defs.filter((f, i) => !RESERVED_KEYS.includes(f.key) && defs.findIndex((x) => x.key === f.key) === i);
}

$('#tpl').oninput = retpl;
$('#fields').oninput = () => { renderChips(); preview(); };
$('#sep').onchange = () => { retext(lastSep, $('#sep').value); lastSep = $('#sep').value; retpl(); };
function retpl() {
    const sep = $('#sep').value;
    files.forEach((f) => { if (f.info && !f.edited) { f.name = build(f.info, $('#tpl').value, sep); paint(f); } });
    renderChips(); preview(); hints();
}
function renderChips() {
    const keys = RESERVED_KEYS.concat(fieldDefs().map((f) => f.key));
    $('#chips').innerHTML = '';
    for (const k of keys) {
        const b = document.createElement('button'); b.textContent = '{' + k + '}';
        b.onclick = () => { const v = $('#tpl').value, sep = $('#sep').value; $('#tpl').value = v + (v.endsWith(sep) ? '' : sep) + '{' + k + '}'; retpl(); };
        $('#chips').append(b);
    }
}
// Shows what the template produces with sample data, and flags placeholders no field will fill.
function preview() {
    const t = $('#tpl').value, sep = $('#sep').value, defs = fieldDefs();
    const used = placeholders(t), known = RESERVED_KEYS.concat(defs.map((f) => f.key));
    const unknown = used.filter((k) => !known.includes(k));
    const custom = used.filter((k) => !RESERVED_KEYS.includes(k));
    const sample = { ...SAMPLE };
    for (const d of defs) sample[d.key] = d.key;
    $('#pv').textContent = build(sample, t, sep) + '.pdf';
    $('#pvnote').textContent = unknown.length
        ? 'Unknown placeholder(s): ' + unknown.map((k) => '{' + k + '}').join(', ')
        : (custom.length ? 'Custom field(s): ' + custom.map((k) => '{' + k + '}').join(', ') : '');
    $('#pvnote').className = unknown.length ? 'mut bad' : 'mut';
}

function add(list) {
    const rejected = [];
    for (const file of list) {
        const ext = extOf(file.name);
        if (!OK_EXT.includes(ext)) { rejected.push(file.name); continue; }
        const f = { id: ++uid, file, ext, name: file.name.replace(/\.[^.]+$/, ''), st: 'queued', note: '' };
        files.push(f); row(f);
    }
    $('#msg').textContent = rejected.length ? 'Unsupported, skipped: ' + rejected.join(', ') : '';
    sync();
}
function row(f) {
    $('#tc').hidden = false;
    const tr = document.createElement('tr'); tr.id = 'r' + f.id;
    tr.innerHTML = '<td class="o"></td><td><div class="nm"><input type="text"><span>.' + f.ext + '</span></div><div class="mut hint"></div></td><td class="st"></td><td><button class="d">Save</button></td>';
    tr.children[0].textContent = f.file.name;
    const inp = tr.querySelector('input'); inp.value = f.name;
    inp.oninput = () => { f.name = inp.value; f.edited = true; hints(); };
    tr.querySelector('.d').onclick = async () => save(fin(f), await f.file.arrayBuffer());
    $('#tb').append(tr); paint(f);
}
function paint(f) {
    const tr = $('#r' + f.id); if (!tr) return;
    const inp = tr.querySelector('input'); if (document.activeElement !== inp) inp.value = f.name;
    const lab = f.st === 'queued' && halt && !cancelled ? ['Paused', 'mut'] : { queued: ['Queued', 'mut'], working: ['Reading...', 'mut'], done: ['Done', 'ok'], error: ['Failed', 'er'], skipped: ['Skipped', 'mut'] }[f.st];
    const s = tr.querySelector('.st'); s.className = 'st ' + lab[1]; s.textContent = lab[0]; s.title = f.note;
    tr.querySelector('.d').disabled = f.st === 'working';
}
const fin = (f) => names()[files.indexOf(f)];
function hints() {
    const ns = names();
    files.forEach((f, i) => { const h = document.querySelector('#r' + f.id + ' .hint'); if (h) h.textContent = ns[i] !== clean(f.name) + '.' + f.ext ? 'duplicate, saves as ' + ns[i] : ''; });
}
function sync() {
    const todo = files.some((f) => f.st !== 'done' && f.st !== 'skipped');
    $('#go').disabled = busy || !todo; $('#go2').disabled = busy || !todo;
    const any = files.some((f) => f.st === 'done');
    $('#zip').disabled = !any; $('#zip2').disabled = !any;
    $('#clr').disabled = busy || !files.length; $('#clr2').disabled = busy;
    const anyErr = files.some((f) => f.st === 'error');
    $('#retry').disabled = busy || !anyErr; $('#retry2').disabled = busy || !anyErr;
    $('#cancel').hidden = !busy;
    const finished = files.filter((f) => f.st === 'done' || f.st === 'error' || f.st === 'skipped').length;
    $('#prog').textContent = busy && files.length ? finished + ' of ' + files.length + ' processed' : '';
    hints();
}
async function save(name, buf) { try { if (await api.save(name, buf)) $('#msg').textContent = 'Saved ' + name; } catch (e) { $('#msg').textContent = 'Save failed: ' + e.message; } }

async function pdfPrep(buf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise, pages = [];
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 2); i++) {
        const p = await pdf.getPage(i);
        text += (await p.getTextContent()).items.map((t) => t.str).join(' ') + '\n';
        const vp = p.getViewport({ scale: 1.3 }), c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        pages.push(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8))).arrayBuffer());
    }
    return { pages, text: text.slice(0, 3000) };
}
// Every file is normalized to one of three shapes before it reaches a model:
//   image    - bytes the provider accepts as-is (native, or converted to JPEG)
//   document - a PDF, which both providers read natively
//   text     - plain text extracted from a text, Office, or spreadsheet file
async function toImage(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!out) throw new Error('Could not convert the image to JPEG.');
    return out.arrayBuffer();
}
async function prep(f) {
    const bytes = await f.file.arrayBuffer();
    if (f.ext === 'pdf') return { kind: 'document', bytes };
    if (Extract.OK_EXT.includes(f.ext)) return { kind: 'text', text: await Extract.extractText(f.ext, bytes) };
    if (SIPS_CONVERT.includes(f.ext)) {
        const r = await api.convert(bytes);
        if (!r.ok) throw new Error(r.error);
        return { kind: 'image', ext: 'jpg', bytes: r.bytes };
    }
    if (CANVAS_CONVERT.includes(f.ext)) return { kind: 'image', ext: 'jpg', bytes: await toImage(f.file) };
    return { kind: 'image', ext: f.ext, bytes };
}
async function analyze(f) {
    const p = await prep(f);
    if (p.kind === 'text' && !p.text) throw new Error('No readable text found in this ' + f.ext.toUpperCase() + ' file.');
    const req = {
        name: f.file.name, kind: p.kind, ext: p.ext, bytes: p.bytes, text: p.text,
        fields: fieldDefs(), dateFormat: $('#datefmt').value, extra: $('#extra').value
    };
    // Only the local engine needs pages rendered; the API reads PDFs directly.
    if (S.provider === 'local' && p.kind === 'document') Object.assign(req, await pdfPrep(p.bytes.slice(0)));
    const r = await api.analyze(req);
    if (!r.ok) throw new Error(r.error);
    return r.info;
}
async function run() {
    S = await api.getSettings(); halt = false; cancelled = false; haltFile = null; busy = true;
    $('#err').hidden = true; $('#msg').textContent = '';
    const q = files.filter((f) => f.st !== 'done' && f.st !== 'skipped'); q.forEach((f) => { f.st = 'queued'; f.note = ''; paint(f); }); sync();
    const sep = $('#sep').value;
    const worker = async () => {
        for (let f; !halt && (f = q.shift());) {
            f.st = 'working'; paint(f); sync();
            try { f.info = await analyze(f); if (!f.edited) f.name = build(f.info, $('#tpl').value, sep); f.st = 'done'; }
            catch (e) {
                // A cancelled file goes back in the queue rather than being marked failed.
                if (cancelled) { f.st = 'queued'; f.note = ''; }
                else {
                    f.st = 'error'; f.note = e.message;
                    if (!halt) { halt = true; haltFile = f; $('#errmsg').textContent = f.file.name + ': ' + e.message; $('#err').hidden = false; }
                }
            }
            paint(f); sync();
        }
    };
    await Promise.all(Array.from({ length: S.provider === 'local' ? 1 : 2 }, worker));
    busy = false; $('#prog').textContent = ''; files.forEach(paint); sync();
}
function cancelRun() {
    if (!busy) return;
    cancelled = true; halt = true;
    api.abort();
    $('#msg').textContent = 'Cancelling...';
}
function skipAndResume() {
    if (haltFile) { haltFile.st = 'skipped'; haltFile.note = (haltFile.note ? haltFile.note + ' (skipped)' : 'Skipped after error'); paint(haltFile); haltFile = null; }
    run();
}
// Re-queue only the rows that failed, leaving already-finished work untouched.
function retryFailed() {
    files.forEach((f) => { if (f.st === 'error') { f.st = 'queued'; f.note = ''; paint(f); } });
    run();
}
async function zipAll() {
    const z = new JSZip(), ns = names();
    files.forEach((f, i) => { if (f.st === 'done') z.file(ns[i], f.file); });
    save('renamed-files.zip', await z.generateAsync({ type: 'arraybuffer' }));
}
function clearAll() { files.length = 0; $('#tb').innerHTML = ''; $('#tc').hidden = true; $('#err').hidden = true; halt = false; haltFile = null; $('#msg').textContent = ''; sync(); }
$('#go').onclick = $('#go2').onclick = run;
$('#skip2').onclick = skipAndResume;
$('#retry').onclick = $('#retry2').onclick = retryFailed;
$('#cancel').onclick = cancelRun;
$('#zip').onclick = $('#zip2').onclick = zipAll;
$('#clr').onclick = $('#clr2').onclick = clearAll;
$('#okhint').textContent = '(' + OK_HINT + ')';
const drop = $('#drop'); drop.onclick = () => $('#fi').click();
$('#fi').onchange = (e) => { add(e.target.files); e.target.value = ''; };
['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => add(e.dataTransfer.files));

function applyPreset(p) {
    $('#tpl').value = p.template; $('#sep').value = p.sep; $('#datefmt').value = p.dateFormat; $('#extra').value = p.extra || '';
    $('#fields').value = (p.fields || []).map((f) => f.key + (f.description ? ' = ' + f.description : '')).join('\n');
    lastSep = p.sep;
    retpl();
}
function renderPresetSel() {
    $('#presetSel').innerHTML = presets.map((p) => '<option value="' + p.id + '">' + p.name.replace(/</g, '&lt;') + '</option>').join('');
    $('#presetSel').value = activePreset;
}
function currentPresetFields(name, id) {
    return { id: id || ('p' + Date.now()), name, template: $('#tpl').value, sep: $('#sep').value, dateFormat: $('#datefmt').value, extra: $('#extra').value, fields: fieldDefs() };
}
async function persistPresets() { await api.setSettings({ presets, activePreset }); }
$('#presetSel').onchange = () => { activePreset = $('#presetSel').value; const p = presets.find((x) => x.id === activePreset); if (p) applyPreset(p); persistPresets(); };
$('#presetSave').onclick = () => {
    const name = (window.prompt('Name this preset:', '') || '').trim();
    if (!name) return;
    const p = currentPresetFields(name);
    presets.push(p); activePreset = p.id; renderPresetSel(); persistPresets();
};
$('#presetUpdate').onclick = () => {
    const i = presets.findIndex((p) => p.id === activePreset);
    if (i < 0) return;
    presets[i] = currentPresetFields(presets[i].name, presets[i].id);
    persistPresets();
};
$('#presetDelete').onclick = () => {
    if (presets.length <= 1) { $('#msg').textContent = "Can't delete the only preset."; return; }
    if (!window.confirm('Delete the "' + presets.find((p) => p.id === activePreset).name + '" preset?')) return;
    presets = presets.filter((p) => p.id !== activePreset);
    activePreset = presets[0].id;
    renderPresetSel(); applyPreset(presets[0]); persistPresets();
};

async function loadS(full) {
    // `full` only runs once at startup - loadS() otherwise fires on every Settings-dialog open and
    // engine-setting change, and reapplying the active preset there would clobber unsaved template edits.
    S = await api.getSettings();
    document.querySelector('input[name=prov][value=' + S.provider + ']').checked = true;
    $('#model').value = S.model;
    $('#keystat').textContent = S.hasKey ? 'Key saved (ends in ' + S.keyTail + '), stored encrypted' : 'No key saved';
    $('#lm').textContent = S.localModel || 'None chosen';
    $('#lp').textContent = S.localMmproj || 'None chosen';
    $('#lb').textContent = S.llamaServer || (S.detectedBin ? 'Auto-detected: ' + S.detectedBin : 'Not found');
    if (!full) return;
    presets = (S.presets && S.presets.length) ? S.presets : [DEFAULT_PRESET];
    activePreset = presets.find((p) => p.id === S.activePreset) ? S.activePreset : presets[0].id;
    renderPresetSel();
    const active = presets.find((p) => p.id === activePreset);
    if (active) applyPreset(active);
}
$('#gear').onclick = async () => { await loadS(); $('#dlg').showModal(); };
$('#close').onclick = () => $('#dlg').close();
document.querySelectorAll('input[name=prov]').forEach((r) => r.onchange = () => api.setSettings({ provider: r.value }));
$('#model').onchange = () => api.setSettings({ model: $('#model').value.trim() });
$('#ksave').onclick = async () => { const k = $('#key').value.trim(); if (!k) return; const r = await api.setSettings({ apiKey: k }); $('#key').value = ''; await loadS(); if (!r.ok) $('#keystat').textContent = r.error; };
$('#kdel').onclick = async () => { await api.setSettings({ clearKey: true }); await loadS(); };
document.querySelectorAll('[data-pick]').forEach((b) => b.onclick = async () => {
    const p = await api.pick(b.dataset.pick === 'llamaServer' ? 'bin' : 'gguf');
    if (p) { await api.setSettings({ [b.dataset.pick]: p }); await loadS(); }
});
$('#hf').onclick = () => api.open('https://huggingface.co/models?pipeline_tag=image-text-to-text&sort=trending&search=gguf');
loadS(true);
