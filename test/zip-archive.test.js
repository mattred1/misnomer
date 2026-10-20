const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const { startArchive } = require('../renderer/zip-archive.js');
const { plan } = require('../renderer/zip.js');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'misnomer-zip-'));
}

function totalOf(entries) {
    return entries.reduce((sum, entry) => sum + fs.statSync(entry.path).size, 0);
}

test('startArchive: writes every entry and reports completion', async () => {
    const dir = tempDir();
    try {
        const a = path.join(dir, 'a.txt');
        const b = path.join(dir, 'b.txt');
        fs.writeFileSync(a, 'alpha');
        fs.writeFileSync(b, 'beta');
        const entries = plan([
            { path: a, name: 'alpha.txt' },
            { path: b, name: 'beta.txt' }
        ]);
        const target = path.join(dir, 'out.zip');
        const progress = [];
        const result = await startArchive({
            entries,
            target,
            totalBytes: totalOf(entries),
            onProgress: (p) => progress.push(p)
        }).promise;

        assert.equal(result.ok, true);
        assert.equal(result.count, 2);
        assert.ok(fs.existsSync(target));
        assert.deepEqual(progress.at(-1), { processed: 2, total: 2, percent: 100, bytes: 9, totalBytes: 9 });

        const zip = await JSZip.loadAsync(fs.readFileSync(target));
        assert.deepEqual(Object.keys(zip.files).sort(), ['alpha.txt', 'beta.txt']);
        assert.equal(await zip.file('alpha.txt').async('string'), 'alpha');
        assert.equal(await zip.file('beta.txt').async('string'), 'beta');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('startArchive: cancellation removes the partial archive', async () => {
    const dir = tempDir();
    try {
        const big = path.join(dir, 'big.bin');
        fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024, 7));
        const entries = plan([{ path: big, name: 'big.bin' }]);
        const target = path.join(dir, 'cancelled.zip');
        const job = startArchive({ entries, target, totalBytes: totalOf(entries), onProgress: () => {} });
        job.cancel();
        const result = await job.promise;

        assert.equal(result.canceled, true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(target), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('startArchive: a missing input fails and removes the partial archive', async () => {
    const dir = tempDir();
    try {
        const target = path.join(dir, 'missing.zip');
        const entries = [{ path: path.join(dir, 'missing.txt'), name: 'missing.txt' }];
        const result = await startArchive({ entries, target, totalBytes: 10, onProgress: () => {} }).promise;

        assert.equal(result.ok, false);
        assert.ok(result.error);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(target), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
