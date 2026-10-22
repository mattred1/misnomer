const $ = (s) => document.querySelector(s),
    files = [];
let S = {},
    halt = false,
    busy = false,
    uid = 0,
    haltFile = null,
    cancelled = false;
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';

// Naming helpers live in naming.js so they can be unit tested with `node --test`.
const { build, clean } = window.Naming;
const names = () => window.Naming.names(files);
const Extract = window.Extract;
const Rename = window.Rename;
// One entry per applied rename batch; Undo walks this stack backwards.
const undoStack = [];

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
        Table.row(f);
    }
    const notes = [];
    if (!r.files.length) notes.push('No files found here.');
    if (rejected.length) notes.push('Unsupported, skipped: ' + rejected.join(', '));
    if (r.truncated) notes.push('That folder is very large, so only the first batch was added.');
    $('#msg').textContent = notes.join(' ');
    sync();
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
    $('#clear').disabled = busy || zipping || !files.length;
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
    const named = files.filter((f) => f.st === 'done').length;
    $('#filecount').textContent = String(total);
    $('#filecount').hidden = !total;
    $('#batchsub').textContent = total
        ? total + (total === 1 ? ' file' : ' files') + (named ? ' \u00b7 ' + named + ' named' : '')
        : 'Drop files to create clean, consistent names.';
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
        fields: Preview.fieldDefs(),
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
    Thumbs.clear();
    Table.clear();
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
$('#clr').onclick = $('#clr2').onclick = $('#clear').onclick = clearAll;

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

// Sidebar navigation mirrors the single-page batch flow: it highlights the
// section in view and scrolls the content pane without moving the sidebar.
const scroller = $('#scroll');
const navTargets = [...document.querySelectorAll('.navitem[data-target]')].map((link) => ({
    link,
    target: link.dataset.target === 'top' ? null : document.getElementById(link.dataset.target)
}));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let navFrame = 0,
    navActive = 'top';
function paintNav() {
    navFrame = 0;
    const edge = scroller.getBoundingClientRect().top + 96;
    let active = 'top';
    for (const { target } of navTargets) {
        if (target && target.getBoundingClientRect().top <= edge) active = target.id;
    }
    if (active === navActive) return;
    navActive = active;
    for (const { link, target } of navTargets) {
        const id = target ? target.id : 'top';
        if (id === active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
}
scroller.addEventListener(
    'scroll',
    () => {
        if (!navFrame) navFrame = requestAnimationFrame(paintNav);
    },
    { passive: true }
);
for (const { link, target } of navTargets) {
    link.addEventListener('click', () => {
        const behavior = reduceMotion.matches ? 'auto' : 'smooth';
        if (target) target.scrollIntoView({ behavior, block: 'start' });
        else scroller.scrollTo({ top: 0, behavior });
    });
}
paintNav();
Sidebar.init();

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

$('#gear').onclick = () => {
    if ($('#dlg').open) return;
    openDialog($('#dlg'), $('#gear'));
    Settings.load();
};
$('#close').onclick = () => $('#dlg').close();

window.Exporter.init({
    getFiles: () => files,
    names,
    sync,
    message: (text) => {
        $('#msg').textContent = text;
    }
});

// Thin aliases keep the batch flow readable while the DOM-heavy logic lives in Table.
const paint = (f) => Table.paint(f);
const hints = () => Table.hints();
const renderUsage = () => Table.renderUsage();

Thumbs.init({
    api,
    openDialog,
    message: (text) => {
        $('#msg').textContent = text;
    },
    imageExt: IMAGE_EXT,
    sips: SIPS_CONVERT,
    blobType: BLOB_TYPE
});
Table.init({
    api,
    getFiles: () => files,
    names,
    save,
    isPaused: () => halt && !cancelled,
    message: (text) => {
        $('#msg').textContent = text;
    }
});
Preview.init({
    getFiles: () => files,
    paint: Table.paint,
    hints: Table.hints
});
Settings.init({
    getSettings: () => S,
    setSettings: (next) => {
        S = next;
    },
    fieldDefs: Preview.fieldDefs,
    applyTemplate: Preview.applyTemplate,
    message: (text) => {
        $('#msg').textContent = text;
    }
});
Settings.load(true);
