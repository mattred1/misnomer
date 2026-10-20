// Streaming ZIP creation used by main.js. Kept free of Electron so the archive
// path can be tested with node --test.
const fs = require('fs');
const archiver = require('archiver');

// entries: [{ path, name }] with an already-planned flat filename.
// Returns { promise, cancel }; the promise resolves to { ok, ... }.
function startArchive({ entries, target, totalBytes, onProgress }) {
    let resolvePromise;
    const promise = new Promise((resolve) => {
        resolvePromise = resolve;
    });

    const output = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(output);
    const total = entries.length;
    let settled = false,
        stopped = false,
        lastSent = 0;

    const report = (progress) => {
        if (typeof onProgress === 'function') onProgress(progress);
    };
    const finish = (result) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
    };
    const removePartial = () => {
        try {
            fs.rmSync(target, { force: true });
        } catch {
            /* best effort; the stream may still be closing */
        }
    };
    const stop = (result) => {
        if (settled) return;
        stopped = true;
        try {
            archive.abort();
        } catch {
            /* already finalized */
        }
        output.destroy();
        const done = () => {
            // Delete only after the write stream has closed; removing earlier can
            // race with the stream opening the file for the first time.
            removePartial();
            finish(result);
        };
        if (output.closed) done();
        else output.once('close', done);
    };

    output.on('close', () => {
        if (settled || stopped) return;
        report({ processed: total, total, percent: 100, bytes: totalBytes, totalBytes });
        finish({ ok: true, path: target, count: total });
    });
    output.on('error', (err) => stop({ ok: false, error: err.message }));
    archive.on('warning', (err) => stop({ ok: false, error: err.message }));
    archive.on('error', (err) => {
        if (!stopped) stop({ ok: false, error: err.message });
    });
    archive.on('progress', (p) => {
        if (stopped) return;
        const now = Date.now();
        const processed = Math.min(total, Number(p.entries.processed) || 0);
        if (now - lastSent < 100 && processed < total) return;
        lastSent = now;
        const bytes = Math.min(totalBytes, Number(p.fs.processedBytes) || 0);
        const percent = totalBytes ? Math.min(100, Math.round((bytes / totalBytes) * 100)) : Math.round((processed / total) * 100);
        report({ processed, total, percent, bytes, totalBytes });
    });

    try {
        for (const entry of entries) archive.file(entry.path, { name: entry.name });
        archive.finalize().catch((err) => stop({ ok: false, error: err.message }));
    } catch (err) {
        stop({ ok: false, error: err.message });
    }

    return {
        promise,
        cancel: () => stop({ ok: false, canceled: true })
    };
}

module.exports = { startArchive };
