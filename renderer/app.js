const $ = (s) => document.querySelector(s),
    files = [];
let S = {},
    halt = false,
    busy = false,
    uid = 0,
    haltFile = null,
    cancelled = false;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

// The <option value="..."> ids in the #datefmt select must match main.js's DATE_HINTS keys -
// the hint text itself lives there since that's what actually goes into the model prompt / schema.
// The starter preset keeps the first run simple: a single title placeholder.
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{title}', sep: '-', dateFormat: 'ymd', extra: '', fields: [] };
// Older builds seeded first-run settings with the four built-in fields; loadS upgrades
// the untouched starter preset so existing installs pick up the simpler default.
const LEGACY_DEFAULT_TEMPLATE = '{date}-{entity}-{type}-{title}';
let presets = [DEFAULT_PRESET],
    activePreset = 'default',
    lastSep = DEFAULT_PRESET.sep;

// Rewrites the separator characters already visible in the template input so the raw text
// matches the newly chosen separator, instead of only affecting names behind the scenes.
function retext(oldSep, newSep) {
    if (oldSep === newSep) return;
    let v = $('#tpl').value;
    v = oldSep ? v.split(oldSep).join(newSep) : v.replace(/\}\{/g, '}' + newSep + '{');
    $('#tpl').value = v;
}

// Naming helpers live in naming.js so they can be unit tested with `node --test`.
const { build, clean, placeholders, slug } = window.Naming;
const names = () => window.Naming.names(files);
const Extract = window.Extract;
const Rename = window.Rename;
const Exif = window.Exif;
// One entry per applied rename batch; Undo walks this stack backwards.
const undoStack = [];

const RESERVED_KEYS = ['title', 'entity', 'date', 'type'];
// Chromium can decode these but the model APIs reject them, so they go through a canvas.
const CANVAS_CONVERT = ['bmp', 'ico', 'svg', 'avif'];
// Chromium cannot decode these at all, so they go through macOS sips in the main process.
const SIPS_CONVERT = ['tif', 'tiff', 'heic', 'heif'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', ...CANVAS_CONVERT, ...SIPS_CONVERT];
const OK_EXT = ['pdf', ...IMAGE_EXT, ...Extract.OK_EXT];
const OK_HINT =
    'PDF, images (PNG, JPG, GIF, WebP, BMP, ICO, SVG, AVIF, TIFF, HEIC), and text or Office files (TXT, MD, CSV, JSON, RTF, DOCX, XLSX, PPTX, ODT, EPUB)';
// MIME type for the canvas decode path; SVG and ICO need their real type to decode.
const BLOB_TYPE = { svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };

// Thumbnails stay small and are generated a few at a time, so dropping a large
// batch does not kick off hundreds of simultaneous decodes.
const THUMB_MAX = 120,
    THUMB_WORKERS = 3;
const thumbCache = new Map(),
    thumbJobs = new Map(),
    thumbQueue = [];
let thumbActive = 0,
    previewUrl = '';
// Only draw thumbnails for rows near the viewport; off-screen rows wait until they
// are scrolled into view, which keeps big batches responsive.
const thumbObserver =
    typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
              (entries) => {
                  for (const entry of entries) {
                      if (!entry.isIntersecting) continue;
                      const f = thumbJobs.get(entry.target);
                      thumbObserver.unobserve(entry.target);
                      thumbJobs.delete(entry.target);
                      if (f) queueThumb(f);
                  }
              },
              { rootMargin: '200px' }
          )
        : null;

// Sample values used only to render the template preview, never sent anywhere.
const SAMPLE = { date: '2026-03-01', entity: 'acme', type: 'invoice', title: 'march service call' };

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
function retpl() {
    const sep = $('#sep').value;
    files.forEach((f) => {
        if (f.info && !f.edited) {
            f.name = build(f.info, $('#tpl').value, sep);
            paint(f);
        }
    });
    renderChips();
    preview();
    hints();
}
function renderChips() {
    const keys = RESERVED_KEYS.concat(fieldDefs().map((f) => f.key));
    $('#chips').innerHTML = '';
    for (const k of keys) {
        const b = document.createElement('button');
        b.textContent = '{' + k + '}';
        b.onclick = () => {
            const v = $('#tpl').value.trim(),
                sep = $('#sep').value;
            // A separator only belongs between fields, never before the first one.
            $('#tpl').value = v ? v + (v.endsWith(sep) ? '' : sep) + '{' + k + '}' : '{' + k + '}';
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
    const custom = used.filter((k) => !RESERVED_KEYS.includes(k));
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
            span.className = p.key ? 'tok' : 'lit';
            if (p.key) span.dataset.key = p.key;
            span.textContent = p.text;
            pv.append(span);
        });
    } else pv.textContent = built;
    pv.title = built + '.pdf';

    $('#pvnote').textContent = unknown.length
        ? 'Unknown placeholder(s): ' + unknown.map((k) => '{' + k + '}').join(', ')
        : custom.length
          ? 'Custom field(s): ' + custom.map((k) => '{' + k + '}').join(', ')
          : '';
    $('#pvnote').className = unknown.length ? 'mut bad' : 'mut';
}

// Files are tracked by path so they can be renamed in place. Drops and the file
// picker only hand us File objects, so their real paths come from Electron.
async function addPaths(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) {
        $('#msg').textContent = 'That item has no location on disk.';
        return;
    }
    const r = await api.expand(list);
    if (!r.ok) {
        $('#msg').textContent = 'Could not read that folder: ' + r.error;
        return;
    }
    const rejected = [];
    for (const file of r.files) {
        if (!OK_EXT.includes(file.ext)) {
            rejected.push(file.name);
            continue;
        }
        const f = {
            id: ++uid,
            path: file.path,
            dir: file.dir,
            ext: file.ext,
            original: file.name,
            name: file.name.replace(/\.[^.]+$/, ''),
            st: 'queued',
            note: '',
            renamed: false,
            usage: null
        };
        files.push(f);
        row(f);
    }
    const notes = [];
    if (!r.files.length) notes.push('No files found here.');
    if (rejected.length) notes.push('Unsupported, skipped: ' + rejected.join(', '));
    if (r.truncated) notes.push('That folder is very large, so only the first batch was added.');
    $('#msg').textContent = notes.join(' ');
    sync();
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
        const r = await api.readFile(f.path);
        if (!r.ok) {
            $('#msg').textContent = 'Could not read ' + f.original + ': ' + r.error;
            return;
        }
        save(fin(f), r.bytes);
    };
    $('#tb').append(tr);
    paint(f);
    observeThumb(f, tr.querySelector('.thumb'));
}

// A thumbnail is drawn from the file itself: PDFs render page one, sips formats are
// converted first, and everything else is decoded by Chromium and scaled down.
function observeThumb(f, box) {
    if (f.ext !== 'pdf' && !IMAGE_EXT.includes(f.ext)) return;
    if (!thumbObserver) {
        queueThumb(f);
        return;
    }
    thumbJobs.set(box, f);
    thumbObserver.observe(box);
}
function queueThumb(f) {
    thumbQueue.push(f);
    pumpThumbs();
}
function pumpThumbs() {
    while (thumbActive < THUMB_WORKERS && thumbQueue.length) {
        const f = thumbQueue.shift();
        thumbActive++;
        thumbFor(f)
            .then((src) => {
                const box = document.querySelector('#r' + f.id + ' .thumb');
                if (!box || !src) return;
                box.textContent = '';
                const img = document.createElement('img');
                img.alt = '';
                img.src = src;
                box.append(img);
                box.classList.add('has');
                box.dataset.label = f.original;
                box.setAttribute('role', 'button');
                box.setAttribute('aria-label', 'Preview ' + f.original);
                box.tabIndex = 0;
                box.onclick = () => showPreview(f);
                box.onkeydown = (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        showPreview(f);
                    }
                };
            })
            .catch(() => {
                /* leave the extension badge in place */
            })
            .finally(() => {
                thumbActive--;
                pumpThumbs();
            });
    }
}
async function thumbFor(f) {
    if (thumbCache.has(f.path)) return thumbCache.get(f.path);
    let src = '';
    const r = await api.readFile(f.path);
    if (r.ok) {
        if (f.ext === 'pdf') src = await pdfPreview(r.bytes, THUMB_MAX);
        else if (SIPS_CONVERT.includes(f.ext)) {
            const c = await api.convert(r.bytes, THUMB_MAX);
            if (c.ok) src = await imagePreview(new Blob([c.bytes], { type: 'image/jpeg' }), THUMB_MAX);
        } else src = await imagePreview(new Blob([r.bytes], { type: BLOB_TYPE[f.ext] || 'image/' + f.ext }), THUMB_MAX);
    }
    thumbCache.set(f.path, src);
    return src;
}
function pdfPreview(buf, max) {
    let pdf;
    return (async () => {
        pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
        const page = await pdf.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(1, max / Math.max(base.width, base.height)) });
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        return c.toDataURL('image/jpeg', 0.8);
    })()
        .catch(() => '')
        .finally(() => {
            if (pdf) pdf.destroy();
        });
}
async function imagePreview(blob, max) {
    let bmp;
    try {
        // Asking for one dimension preserves the aspect ratio. This also avoids
        // decoding a full-size bitmap just to shrink a phone photo into a thumbnail.
        bmp = await createImageBitmap(blob, { resizeWidth: max, resizeQuality: 'high' });
    } catch {
        return elementPreview(blob, max);
    }
    try {
        const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.8);
    } finally {
        if (bmp.close) bmp.close();
    }
}
// Some decoders (SVG in particular) only work through an <img> element.
function elementPreview(blob, max) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob),
            img = new Image();
        img.onload = () => {
            try {
                const w = img.naturalWidth || max,
                    h = img.naturalHeight || max;
                const scale = Math.min(1, max / Math.max(w, h));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(w * scale));
                c.height = Math.max(1, Math.round(h * scale));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                resolve(c.toDataURL('image/jpeg', 0.8));
            } catch {
                resolve('');
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve('');
        };
        img.src = url;
    });
}
// Clicking a thumbnail opens a larger view of the same first page.
async function showPreview(f) {
    const img = $('#imgview'),
        opener = document.activeElement;
    $('#imgname').textContent = f.original;
    if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
    }
    img.removeAttribute('src');
    const r = await api.readFile(f.path);
    if (!r.ok) {
        $('#msg').textContent = 'Could not read ' + f.original + ': ' + r.error;
        return;
    }
    let src = '';
    if (f.ext === 'pdf') src = await pdfPreview(r.bytes, 1100);
    else if (SIPS_CONVERT.includes(f.ext)) {
        const c = await api.convert(r.bytes, 1100);
        if (c.ok) {
            previewUrl = URL.createObjectURL(new Blob([c.bytes], { type: 'image/jpeg' }));
            src = previewUrl;
        }
    } else {
        previewUrl = URL.createObjectURL(new Blob([r.bytes], { type: BLOB_TYPE[f.ext] || 'image/' + f.ext }));
        src = previewUrl;
    }
    if (!src) {
        $('#msg').textContent = 'Could not preview ' + f.original + '.';
        return;
    }
    img.alt = f.original;
    img.src = src;
    if (!$('#imgdlg').open) openDialog($('#imgdlg'), opener);
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
        f.st === 'queued' && halt && !cancelled
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
const fin = (f) => names()[files.indexOf(f)];
function hints() {
    const ns = names();
    files.forEach((f, i) => {
        const h = document.querySelector('#r' + f.id + ' .hint');
        if (!h) return;
        const notes = [];
        if (ns[i] !== clean(f.name) + '.' + f.ext) notes.push('duplicate, saves as ' + ns[i]);
        if (f.info && f.info.dateSource === 'exif') notes.push('date from EXIF');
        h.textContent = notes.join(' \u00b7 ');
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
    const used = files.filter((f) => f.usage);
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
// The visual counter updates on every file, but announcements are limited to starts,
// pauses, 10% milestones, and completion so large batches do not flood screen readers.
let lastAnnouncedPct = -1,
    progressActive = false,
    progressPaused = false;
function updateProgress(total, finished, busy, paused) {
    const show = total > 0 && (busy || paused);
    const pct = total ? Math.round((finished / total) * 100) : 0;
    $('#progwrap').classList.toggle('active', show);
    $('#progwrap').classList.toggle('warn', paused);
    $('#progbar').style.width = pct + '%';
    $('#prog').textContent = show ? finished + ' of ' + total + ' processed' : '';
    const live = $('#progLive');
    if (show) {
        const text = paused ? 'Paused at ' + finished + ' of ' + total + ' files.' : finished + ' of ' + total + ' files processed.';
        const resumed = progressPaused && !paused;
        if ((!progressActive || paused || resumed || pct - lastAnnouncedPct >= 10) && live.textContent !== text) {
            live.textContent = text;
            lastAnnouncedPct = pct;
        }
        progressActive = true;
        progressPaused = paused;
    } else if (progressActive) {
        if (total && finished === total) live.textContent = 'Finished processing ' + total + ' file' + (total === 1 ? '' : 's') + '.';
        else if (total && cancelled) live.textContent = 'Cancelled after ' + finished + ' of ' + total + ' files.';
        else if (total) live.textContent = 'Processing stopped after ' + finished + ' of ' + total + ' files.';
        progressActive = false;
        progressPaused = false;
        lastAnnouncedPct = -1;
    }
}
function sync() {
    const todo = files.some((f) => f.st !== 'done' && f.st !== 'skipped');
    $('#go').disabled = busy || !todo;
    $('#go2').disabled = busy || !todo;
    const any = files.some((f) => f.st === 'done');
    const zipping = window.Exporter?.isBusy() || false;
    $('#zip').disabled = !any || zipping;
    $('#zip2').disabled = !any || zipping;
    $('#clr').disabled = busy || zipping || !files.length;
    $('#clr').hidden = !files.length;
    $('#clr2').disabled = busy || zipping;
    const anyErr = files.some((f) => f.st === 'error');
    $('#retry').disabled = busy || !anyErr;
    $('#retry2').disabled = busy || !anyErr;
    $('#rename').disabled = busy || zipping || !files.some((f) => f.st === 'done');
    $('#undo').disabled = busy || zipping || !undoStack.length;
    $('#undo').textContent = undoStack.length ? 'Undo rename (' + undoStack.length + ')' : 'Undo rename';
    $('#cancel').hidden = !busy;
    const total = files.length;
    const finished = files.filter((f) => f.st === 'done' || f.st === 'error' || f.st === 'skipped').length;
    const paused = halt && !cancelled && files.some((f) => f.st === 'error');
    updateProgress(total, finished, busy, paused);
    const hasFiles = total > 0;
    $('#drop').classList.toggle('has-files', hasFiles);
    $('#droptext').textContent = hasFiles
        ? 'Drop more files here, or click to choose files'
        : 'Drop files or folders here, or click to choose files';
    hints();
    renderUsage();
}
async function save(name, buf) {
    try {
        if (await api.save(name, buf)) $('#msg').textContent = 'Saved ' + name;
    } catch (e) {
        $('#msg').textContent = 'Save failed: ' + e.message;
    }
}

async function pdfPrep(buf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise,
        pages = [];
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 2); i++) {
        const p = await pdf.getPage(i);
        text += (await p.getTextContent()).items.map((t) => t.str).join(' ') + '\n';
        const vp = p.getViewport({ scale: 1.3 }),
            c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
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
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    if (!out) throw new Error('Could not convert the image to JPEG.');
    return out.arrayBuffer();
}
async function prep(f) {
    const read = await api.readFile(f.path);
    if (!read.ok) throw new Error(read.error);
    const bytes = read.bytes;
    if (f.ext === 'pdf') return { kind: 'document', bytes };
    if (Extract.OK_EXT.includes(f.ext)) return { kind: 'text', text: await Extract.extractText(f.ext, bytes) };
    if (SIPS_CONVERT.includes(f.ext)) {
        const r = await api.convert(bytes);
        if (!r.ok) throw new Error(r.error);
        return { kind: 'image', ext: 'jpg', bytes: r.bytes };
    }
    if (CANVAS_CONVERT.includes(f.ext)) {
        const blob = new Blob([bytes], { type: BLOB_TYPE[f.ext] || 'image/' + f.ext });
        return { kind: 'image', ext: 'jpg', bytes: await toImage(blob) };
    }
    return { kind: 'image', ext: f.ext, bytes };
}
async function analyze(f) {
    const p = await prep(f);
    if (p.kind === 'text' && !p.text) throw new Error('No readable text found in this ' + f.ext.toUpperCase() + ' file.');
    const req = {
        name: f.original,
        path: f.path,
        kind: p.kind,
        ext: p.ext,
        bytes: p.bytes,
        text: p.text,
        fields: fieldDefs(),
        dateFormat: $('#datefmt').value,
        extra: $('#extra').value
    };
    // Providers that cannot take a PDF directly get page images from the renderer.
    if (S.pdfMode === 'pages' && p.kind === 'document') Object.assign(req, await pdfPrep(p.bytes.slice(0)));
    const r = await api.analyze(req);
    if (!r.ok) throw new Error(r.error);
    return r;
}
async function run() {
    S = await api.getSettings();
    halt = false;
    cancelled = false;
    haltFile = null;
    busy = true;
    lastAnnouncedPct = -1;
    progressActive = false;
    progressPaused = false;
    $('#err').hidden = true;
    $('#msg').textContent = '';
    const q = files.filter((f) => f.st !== 'done' && f.st !== 'skipped');
    q.forEach((f) => {
        f.st = 'queued';
        f.note = '';
        paint(f);
    });
    sync();
    const sep = $('#sep').value;
    const worker = async () => {
        for (let f; !halt && (f = q.shift());) {
            f.st = 'working';
            f.usage = null;
            paint(f);
            sync();
            try {
                const r = await analyze(f);
                f.info = r.info;
                f.usage = r.usage || null;
                // Surface where the date came from, since the model did not read it off the image.
                if (f.info.dateSource === 'exif') f.note = 'Date taken from the photo\u2019s EXIF metadata';
                if (!f.edited) f.name = build(f.info, $('#tpl').value, sep);
                f.st = 'done';
            } catch (e) {
                // A cancelled file goes back in the queue rather than being marked failed.
                if (cancelled) {
                    f.st = 'queued';
                    f.note = '';
                } else {
                    f.st = 'error';
                    f.note = e.message;
                    if (!halt) {
                        halt = true;
                        haltFile = f;
                        $('#errmsg').textContent = f.original + ': ' + e.message;
                        const box = $('#err');
                        box.hidden = false;
                        box.focus();
                    }
                }
            }
            paint(f);
            sync();
        }
    };
    await Promise.all(Array.from({ length: S.engine === 'local' ? 1 : 2 }, worker));
    busy = false;
    $('#prog').textContent = '';
    files.forEach(paint);
    sync();
}
function cancelRun() {
    if (!busy) return;
    cancelled = true;
    halt = true;
    api.abort();
    $('#msg').textContent = 'Cancelling...';
}
function skipAndResume() {
    if (haltFile) {
        haltFile.st = 'skipped';
        haltFile.note = haltFile.note ? haltFile.note + ' (skipped)' : 'Skipped after error';
        paint(haltFile);
        haltFile = null;
    }
    run();
}
// Re-queue only the rows that failed, leaving already-finished work untouched.
function retryFailed() {
    files.forEach((f) => {
        if (f.st === 'error') {
            f.st = 'queued';
            f.note = '';
            paint(f);
        }
    });
    run();
}
// Renames every finished row inside its own folder. Collisions are resolved against
// what is already on disk, and the batch is recorded so it can be undone.
async function renameAll() {
    const rows = files.filter((f) => f.st === 'done');
    if (!rows.length) return;
    const existing = await api.existing(Rename.dirsOf(rows.map((f) => f.path)));
    const plan = Rename.planRenames(
        rows.map((f) => ({ id: f.id, from: f.path, name: clean(f.name), ext: f.ext })),
        existing
    );
    const todo = plan.filter((p) => p.changed);
    if (!todo.length) {
        $('#msg').textContent = 'Every file already has the name shown.';
        return;
    }

    const dirs = [...new Set(todo.map((p) => p.dir))];
    const where = dirs.length === 1 ? dirs[0] : dirs.length + ' folders';
    const plural = todo.length === 1 ? '' : 's';
    if (!window.confirm('Rename ' + todo.length + ' file' + plural + ' in ' + where + '?')) return;

    const results = await api.rename(todo.map((p) => ({ id: p.id, from: p.from, to: p.path })));
    const entries = [],
        failed = [];
    for (const r of results) {
        const p = todo.find((x) => x.id === r.id),
            f = files.find((x) => x.id === r.id);
        if (!p || !f) continue;
        if (r.ok) {
            entries.push({ id: f.id, from: p.from, to: p.path });
            f.path = p.path;
            f.dir = p.dir;
            f.original = p.target;
            f.renamed = true;
            f.note = '';
        } else {
            failed.push(f.original + ': ' + r.error);
            f.note = r.error;
        }
    }
    if (entries.length) undoStack.push({ entries });
    $('#msg').textContent =
        (entries.length ? 'Renamed ' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + '.' : '') +
        (failed.length ? ' Failed: ' + failed.join('; ') : '');
    files.forEach(paint);
    sync();
}
// Reverts the most recent rename batch, unwinding its entries in reverse order.
async function undoLast() {
    const batch = undoStack.pop();
    if (!batch) return;
    const existing = await api.existing(Rename.dirsOf(batch.entries.map((e) => e.to)));
    const plan = Rename.planUndo(batch.entries, existing);
    const ok = plan.filter((p) => p.ok);
    const results = ok.length ? await api.rename(ok.map((p) => ({ id: p.id, from: p.from, to: p.to }))) : [];
    const failedIds = results.filter((r) => !r.ok).map((r) => r.id);
    let restored = 0;
    for (const r of results) {
        const p = ok.find((x) => x.id === r.id),
            f = files.find((x) => x.id === r.id);
        if (!p || !f) continue;
        if (r.ok) {
            restored++;
            f.path = p.to;
            f.dir = Rename.dirOf(p.to);
            f.original = Rename.baseOf(p.to);
            f.renamed = false;
            f.note = '';
        } else {
            f.note = r.error;
        }
    }
    // Anything that could not be moved back stays on the stack for another attempt.
    const retry = plan.filter((p) => p.ok && failedIds.includes(p.id)).map((p) => ({ id: p.id, from: p.to, to: p.from }));
    if (retry.length) undoStack.push({ entries: retry });

    const blocked = plan.filter((p) => !p.ok);
    const notes = [];
    if (restored) notes.push('Restored ' + restored + ' original name' + (restored === 1 ? '' : 's') + '.');
    if (failedIds.length) notes.push(failedIds.length + ' could not be restored.');
    if (blocked.length) notes.push(blocked.length + ' skipped: the original name is taken or the file is gone.');
    if (!notes.length) notes.push('Nothing to undo.');
    $('#msg').textContent = notes.join(' ');
    files.forEach(paint);
    sync();
}
function clearAll() {
    files.length = 0;
    undoStack.length = 0;
    thumbCache.clear();
    thumbQueue.length = 0;
    if (thumbObserver) thumbObserver.disconnect();
    thumbJobs.clear();
    $('#tb').innerHTML = '';
    $('#tc').hidden = true;
    $('#err').hidden = true;
    halt = false;
    haltFile = null;
    $('#msg').textContent = '';
    sync();
}
$('#go').onclick = $('#go2').onclick = run;
$('#skip2').onclick = skipAndResume;
$('#retry').onclick = $('#retry2').onclick = retryFailed;
$('#cancel').onclick = cancelRun;
$('#rename').onclick = renameAll;
$('#undo').onclick = undoLast;
$('#clr').onclick = $('#clr2').onclick = clearAll;
$('#imgclose').onclick = () => $('#imgdlg').close();
$('#imgdlg').addEventListener('close', () => {
    if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrl = '';
    }
    $('#imgview').removeAttribute('src');
    $('#imgview').alt = '';
});

// Modal dialogs: focus the first control on open, keep Tab inside, and restore
// focus to whatever opened the dialog when it closes.
const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const dialogReturn = new WeakMap();
const dialogItems = (dlg) => [...dlg.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
function openDialog(dlg, opener) {
    dialogReturn.set(dlg, opener || document.activeElement);
    dlg.showModal();
    const first = dialogItems(dlg)[0];
    if (first) first.focus();
}
function trapFocus(dlg) {
    dlg.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const items = dialogItems(dlg);
        if (!items.length) return;
        const first = items[0],
            last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    });
    dlg.addEventListener('close', () => {
        const back = dialogReturn.get(dlg);
        dialogReturn.delete(dlg);
        if (back && document.contains(back)) back.focus();
    });
}
// Clicking the dimmed app behind a modal dismisses it (the backdrop reports the dialog
// as its target). Both the press and release must land outside the dialog's box, so
// dragging a text selection out of a field does not accidentally close Settings.
function dismissOnBackdrop(dlg) {
    let pressedOutside = false;
    const outside = (e) => {
        const r = dlg.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    dlg.addEventListener('pointerdown', (e) => {
        pressedOutside = e.target === dlg && outside(e);
    });
    dlg.addEventListener('click', (e) => {
        if (pressedOutside && e.target === dlg && outside(e)) dlg.close();
        pressedOutside = false;
    });
}
trapFocus($('#dlg'));
trapFocus($('#imgdlg'));
dismissOnBackdrop($('#dlg'));
dismissOnBackdrop($('#imgdlg'));
$('#okhint').textContent = '(' + OK_HINT + ')';
// Keep the picker in sync with the formats the app actually accepts.
$('#fi').accept = OK_EXT.map((e) => '.' + e).join(',');
const drop = $('#drop');
drop.onclick = () => $('#fi').click();
drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('#fi').click();
    }
});
$('#pickFolder').onclick = async () => {
    const d = await api.pickFolder();
    if (d) addPaths([d]);
};
$('#fi').onchange = (e) => {
    addPaths([...e.target.files].map((f) => api.pathFor(f)));
    e.target.value = '';
};
// Files can be dropped anywhere in the window, not just on the drop zone. The depth
// counter absorbs the dragenter/dragleave churn as the pointer crosses child elements.
const dropmask = $('#dropmask');
let dragDepth = 0;
const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
const setDragging = (on) => {
    dropmask.hidden = !on;
    drop.classList.toggle('over', on);
};
window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    setDragging(true);
});
window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
    if (!dragDepth) return;
    // relatedTarget is null when the pointer leaves the window entirely.
    dragDepth = e.relatedTarget ? Math.max(0, dragDepth - 1) : 0;
    if (!dragDepth) setDragging(false);
});
window.addEventListener('dragend', () => {
    dragDepth = 0;
    setDragging(false);
});
window.addEventListener('blur', () => {
    dragDepth = 0;
    setDragging(false);
});
// Dropped folders arrive as File entries too; files:expand walks them recursively.
window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);
    addPaths([...e.dataTransfer.files].map((f) => api.pathFor(f)));
});

// Keep the sticky table header tucked below the action bar, which can wrap to two rows.
const actionsBar = $('#actions');
const measureActions = () => document.documentElement.style.setProperty('--actions-h', actionsBar.offsetHeight + 'px');
new ResizeObserver(measureActions).observe(actionsBar);
window.addEventListener('resize', measureActions);
measureActions();

// Global shortcuts. Text fields keep their native undo and Escape behavior.
const isEditableTarget = (el) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
window.addEventListener('keydown', (e) => {
    if ($('#dlg').open || $('#imgdlg').open) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === ',') {
        e.preventDefault();
        $('#gear').click();
        return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        $('#fi').click();
        return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key === 'Enter') {
        e.preventDefault();
        if (!$('#go').disabled) $('#go').click();
        return;
    }
    if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)) {
        e.preventDefault();
        if (!$('#undo').disabled) $('#undo').click();
        return;
    }
    if (e.key === 'Escape' && busy && !isEditableTarget(e.target)) {
        e.preventDefault();
        cancelRun();
    }
});

function applyPreset(p) {
    $('#tpl').value = p.template;
    $('#sep').value = p.sep;
    $('#datefmt').value = p.dateFormat;
    $('#extra').value = p.extra || '';
    $('#fields').value = (p.fields || []).map((f) => f.key + (f.description ? ' = ' + f.description : '')).join('\n');
    lastSep = p.sep;
    retpl();
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
        fields: fieldDefs()
    };
}
async function persistPresets() {
    await api.setSettings({ presets, activePreset });
}
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
        $('#msg').textContent = "Can't delete the only preset.";
        return;
    }
    if (!window.confirm('Delete the "' + presets.find((p) => p.id === activePreset).name + '" preset?')) return;
    presets = presets.filter((p) => p.id !== activePreset);
    activePreset = presets[0].id;
    renderPresetSel();
    applyPreset(presets[0]);
    persistPresets();
};

const { LIST: PROVIDERS, providerById } = window.Providers;

const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hostOf = (url) => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

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

// Rebuilds the Cloud API panel for the selected provider: key hint, connection
// state, and the model list fetched from that provider.
let refreshSeq = 0;
async function refreshProvider() {
    const seq = ++refreshSeq;
    const id = $('#providerSel').value;
    const p = providerById(id) || PROVIDERS[0];
    const saved = (S.models || {})[id] || '';
    $('#key').placeholder = p.keyHint || 'API key';
    $('#keyhelp').innerHTML = 'Get a key at <a href="#" data-docs="' + esc(p.docs) + '">' + esc(hostOf(p.docs)) + '</a>';

    const tail = (S.keys || {})[id];
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
        S.models = { ...(S.models || {}), [id]: picked };
        await api.setSettings({ provider: id, model: picked });
    }
}

async function loadS(full) {
    // `full` only runs once at startup - loadS() otherwise fires on every Settings-dialog open and
    // engine-setting change, and reapplying the active preset there would clobber unsaved template edits.
    S = await api.getSettings();
    applyTheme(S.theme);
    $('#providerSel').innerHTML = PROVIDERS.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
    $('#providerSel').value = S.provider;
    document.querySelector('input[name=engine][value=' + S.engine + ']').checked = true;
    syncEngine();
    $('#lm').textContent = S.localModel || 'None chosen';
    $('#lp').textContent = S.localMmproj || 'None chosen';
    $('#lb').textContent = S.llamaServer || (S.detectedBin ? 'Auto-detected: ' + S.detectedBin : 'Not found');
    await refreshProvider();
    if (!full) return;
    presets = S.presets && S.presets.length ? S.presets : [DEFAULT_PRESET];
    activePreset = presets.find((p) => p.id === S.activePreset) ? S.activePreset : presets[0].id;
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
$('#gear').onclick = () => {
    if ($('#dlg').open) return;
    openDialog($('#dlg'), $('#gear'));
    loadS();
};
$('#close').onclick = () => $('#dlg').close();
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
    await loadS();
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
    await loadS();
};
$('#kdel').onclick = async () => {
    await api.setSettings({ provider: $('#providerSel').value, clearKey: true });
    await loadS();
};
document.querySelectorAll('[data-pick]').forEach(
    (b) =>
        (b.onclick = async () => {
            const p = await api.pick(b.dataset.pick === 'llamaServer' ? 'bin' : 'gguf');
            if (p) {
                await api.setSettings({ [b.dataset.pick]: p });
                await loadS();
            }
        })
);
$('#hf').onclick = (e) => {
    e.preventDefault();
    api.open('https://huggingface.co/models?pipeline_tag=image-text-to-text&sort=trending&search=gguf');
};
window.Exporter.init({
    getFiles: () => files,
    names,
    sync,
    message: (text) => {
        $('#msg').textContent = text;
    }
});
loadS(true);
