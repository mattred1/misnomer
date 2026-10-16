const $ = (s) => document.querySelector(s), files = [];
let S = {}, halt = false, busy = false, uid = 0, haltFile = null;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

// The <option value="..."> ids in the #datefmt select must match main.js's DATE_HINTS keys -
// the hint text itself lives there since that's what actually goes into the model prompt / schema.
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{date}-{entity}-{type}-{title}', sep: '-', dateFormat: 'ymd', extra: '' };
let presets = [DEFAULT_PRESET], activePreset = 'default', lastSep = DEFAULT_PRESET.sep;

// Rewrites the separator characters already visible in the template input so the raw text
// matches the newly chosen separator, instead of only affecting names behind the scenes.
function retext(oldSep, newSep) {
    if (oldSep === newSep) return;
    let v = $('#tpl').value;
    v = oldSep ? v.split(oldSep).join(newSep) : v.replace(/\}\{/g, '}' + newSep + '{');
    $('#tpl').value = v;
}

const slug = (s, sep) => {
    const cleaned = (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, sep);
    if (!sep) return cleaned.slice(0, 80);
    const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return cleaned.replace(new RegExp('^' + esc + '+|' + esc + '+$', 'g'), '').slice(0, 80);
};
const build = (i, t, sep) => slug(t.replace(/\{(title|entity|date|type)\}/g, (_, k) => ' ' + (i[k] || '') + ' '), sep) || 'unnamed';
const clean = (n) => n.replace(/[\\\/:*?"<>|]+/g, '-').trim() || 'unnamed';
const extOf = (n) => (n.split('.').pop() || '').toLowerCase();

['{date}', '{entity}', '{type}', '{title}'].forEach((t) => {
    const b = document.createElement('button'); b.textContent = t;
    b.onclick = () => { const v = $('#tpl').value, sep = $('#sep').value; $('#tpl').value = v + (v.endsWith(sep) ? '' : sep) + t; retpl(); };
    $('#chips').append(b);
});
$('#tpl').oninput = retpl;
$('#sep').onchange = () => { retext(lastSep, $('#sep').value); lastSep = $('#sep').value; retpl(); };
function retpl() { const sep = $('#sep').value; files.forEach((f) => { if (f.info && !f.edited) { f.name = build(f.info, $('#tpl').value, sep); paint(f); } }); hints(); }

function add(list) {
    for (const file of list) {
        const ext = extOf(file.name);
        if (!['pdf', 'png', 'jpg', 'jpeg', 'gif'].includes(ext)) continue;
        const f = { id: ++uid, file, ext, name: file.name.replace(/\.[^.]+$/, ''), st: 'queued', note: '' };
        files.push(f); row(f);
    }
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
    const lab = f.st === 'queued' && halt ? ['Paused', 'mut'] : { queued: ['Queued', 'mut'], working: ['Reading...', 'mut'], done: ['Done', 'ok'], error: ['Failed', 'er'], skipped: ['Skipped', 'mut'] }[f.st];
    const s = tr.querySelector('.st'); s.className = 'st ' + lab[1]; s.textContent = lab[0]; s.title = f.note;
    tr.querySelector('.d').disabled = f.st === 'working';
}
function names() {
    const seen = {};
    return files.map((f) => { const b = clean(f.name); let k = b + '.' + f.ext, n = 1; while (seen[k.toLowerCase()]) k = b + '-' + (++n) + '.' + f.ext; seen[k.toLowerCase()] = 1; return k; });
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
async function analyze(f) {
    const req = { name: f.file.name, ext: f.ext, dateFormat: $('#datefmt').value, extra: $('#extra').value, bytes: await f.file.arrayBuffer() };
    if (S.provider === 'local' && f.ext === 'pdf') Object.assign(req, await pdfPrep(req.bytes.slice(0)));
    const r = await api.analyze(req);
    if (!r.ok) throw new Error(r.error);
    return r.info;
}
async function run() {
    S = await api.getSettings(); halt = false; haltFile = null; busy = true; $('#err').hidden = true;
    const q = files.filter((f) => f.st !== 'done' && f.st !== 'skipped'); q.forEach((f) => { f.st = 'queued'; f.note = ''; paint(f); }); sync();
    const sep = $('#sep').value;
    const worker = async () => {
        for (let f; !halt && (f = q.shift());) {
            f.st = 'working'; paint(f);
            try { f.info = await analyze(f); if (!f.edited) f.name = build(f.info, $('#tpl').value, sep); f.st = 'done'; }
            catch (e) {
                f.st = 'error'; f.note = e.message;
                if (!halt) { halt = true; haltFile = f; $('#errmsg').textContent = f.file.name + ': ' + e.message; $('#err').hidden = false; }
            }
            paint(f); sync();
        }
    };
    await Promise.all(Array.from({ length: S.provider === 'local' ? 1 : 2 }, worker));
    busy = false; files.forEach(paint); sync();
}
function skipAndResume() {
    if (haltFile) { haltFile.st = 'skipped'; haltFile.note = (haltFile.note ? haltFile.note + ' (skipped)' : 'Skipped after error'); paint(haltFile); haltFile = null; }
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
$('#zip').onclick = $('#zip2').onclick = zipAll;
$('#clr').onclick = $('#clr2').onclick = clearAll;
const drop = $('#drop'); drop.onclick = () => $('#fi').click();
$('#fi').onchange = (e) => { add(e.target.files); e.target.value = ''; };
['dragover', 'dragenter'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => add(e.dataTransfer.files));

function applyPreset(p) {
    $('#tpl').value = p.template; $('#sep').value = p.sep; $('#datefmt').value = p.dateFormat; $('#extra').value = p.extra || '';
    lastSep = p.sep;
    retpl();
}
function renderPresetSel() {
    $('#presetSel').innerHTML = presets.map((p) => '<option value="' + p.id + '">' + p.name.replace(/</g, '&lt;') + '</option>').join('');
    $('#presetSel').value = activePreset;
}
function currentPresetFields(name, id) {
    return { id: id || ('p' + Date.now()), name, template: $('#tpl').value, sep: $('#sep').value, dateFormat: $('#datefmt').value, extra: $('#extra').value };
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
