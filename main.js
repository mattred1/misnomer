const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const { startArchive } = require('./renderer/zip-archive.js');
const ZipEntries = require('./renderer/zip.js');
const path = require('path'),
    fs = require('fs'),
    os = require('os'),
    { spawn } = require('child_process');
const {
    LIST: PROVIDERS,
    providerById,
    headersFor,
    modelUrl,
    authRequest,
    parseModels,
    googleSchema,
    migrateSettings,
    estimateCost
} = require('./renderer/providers.js');
const Exif = require('./renderer/exif.js');
const Errors = require('./renderer/errors.js');

const CLOUD_TIMEOUT_MS = 120000,
    LOCAL_TIMEOUT_MS = 120000,
    PORT = 8187;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{title}', sep: '-', dateFormat: 'ymd', extra: '', fields: [] };
// Bundled model prices, refreshed by scripts/update-pricing.js. If the file is
// missing the app still reports tokens, just without a cost estimate.
let PRICING = { schemaVersion: 0, families: {}, models: {} };
try {
    PRICING = require('./pricing/pricing.json');
} catch {
    /* token-only mode */
}
// A factory so each read gets its own objects rather than sharing mutable defaults.
const DEF = () => ({
    engine: 'cloud',
    provider: 'anthropic',
    models: {},
    apiKeys: {},
    localModel: '',
    localMmproj: '',
    llamaServer: '',
    presets: [DEFAULT_PRESET],
    activePreset: 'default',
    theme: 'auto'
});
const SF = () => path.join(app.getPath('userData'), 'settings.json');
const write = (s) => fs.writeFileSync(SF(), JSON.stringify(s, null, 2));
// Reads settings, migrating the single-provider layout that predates the provider list.
function read() {
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(SF(), 'utf8'));
    } catch {
        /* first run, or unreadable file */
    }
    return migrateSettings(parsed, DEF());
}
const decrypt = (enc) => {
    try {
        return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : '';
    } catch {
        return '';
    }
};
const keyFor = (s, id) => decrypt((s.apiKeys || {})[id]);
const providerOf = (s) => providerById(s.provider) || PROVIDERS[0];
// OpenAI-compatible chat APIs cannot take a PDF, so those providers get page images instead.
const pdfMode = (s) => (s.engine === 'local' || providerOf(s).kind === 'openai' ? 'pages' : 'native');
const detectBin = () => ['/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server'].find((p) => fs.existsSync(p)) || '';

const DEFAULT_DATE_HINT = 'the document date formatted as YYYY-MM-DD, or an empty string if no date is visible';
// Date-format hint text, keyed by the same ids used in the renderer's date-format picker.
const DATE_HINTS = {
    ymd: DEFAULT_DATE_HINT,
    mdy: 'the document date formatted as MM-DD-YYYY, or an empty string if no date is visible',
    dmy: 'the document date formatted as DD-MM-YYYY, or an empty string if no date is visible',
    compact: 'the document date formatted as YYYYMMDD with no separators, or an empty string if no date is visible',
    ym: 'the document date formatted as YYYY-MM (year and month only), or an empty string if no date is visible',
    y: 'the document year only, formatted as YYYY, or an empty string if no date is visible'
};

// JSON schema used for structured outputs so the model cannot return malformed JSON.
// The four built-in fields are always present; users can add their own on top.
const SCHEMA = (dateHint, fields) => {
    const properties = {
        title: { type: 'string', description: 'A 2 to 5 word plain-language description of the file contents, lowercase, no punctuation' },
        entity: {
            type: 'string',
            description: 'The vendor, company, or person tied to the document, or an empty string if none is identifiable'
        },
        date: { type: 'string', description: dateHint || DEFAULT_DATE_HINT },
        type: {
            type: 'string',
            description: 'One or two words describing the document type, like invoice, receipt, screenshot, photo, or resume'
        }
    };
    for (const f of fields || []) {
        if (!f.key || properties[f.key]) continue; // never overwrite a built-in field
        properties[f.key] = {
            type: 'string',
            description: f.description || 'The ' + f.key.replace(/[_-]+/g, ' ') + ' for this file, or an empty string if not applicable'
        };
    }
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
};
const fieldKeys = (fields) => {
    const custom = (fields || []).map((f) => f.key).filter((k) => k && !['title', 'entity', 'date', 'type'].includes(k));
    return ['title', 'entity', 'date', 'type', ...custom.filter((k, i) => custom.indexOf(k) === i)];
};

function prompt(name, text, dateHint, extra, fields) {
    const parts = [
        'title (2 to 5 word description)',
        'entity (vendor, person or company, or empty)',
        'date (' + (dateHint || DEFAULT_DATE_HINT) + ')',
        'type (one or two words like invoice, receipt, screenshot, photo, resume)'
    ];
    for (const f of fields || []) parts.push(f.key.replace(/[_-]+/g, ' ') + ' (' + (f.description || 'a short value') + ')');
    let p =
        'You name files. Look at the attached file and describe it using the required fields: ' +
        parts.join(', ') +
        '. ' +
        'Lowercase plain words, no punctuation. Never guess a date; use an empty string if none is visible. ' +
        'Reply with only a JSON object containing those fields.';
    if (extra && extra.trim()) p += ' Additional instructions: ' + extra.trim();
    p += ' Original filename: ' + name + (text ? '\n\nExtracted text:\n' + text : '');
    return p;
}
// Providers report token usage under different names; normalize to input/output.
const usageOf = (input, output) => {
    const i = Number(input) || 0,
        o = Number(output) || 0;
    return i || o ? { input: i, output: o } : null;
};
async function timed(ms, label, signal, fn, provider) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) {
        if (signal.aborted) ctl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    const t = setTimeout(() => ctl.abort(), ms);
    try {
        return await fn(ctl.signal);
    } catch (e) {
        // Distinguish a user cancellation from our own timeout.
        if (e.name === 'AbortError')
            throw Errors.transportError(e, { label, provider, timeoutMs: ms, cancelled: !!(signal && signal.aborted) });
        // Errors raised by the adapters already have a user-facing message and status.
        if (e && e.friendly) throw e;
        throw Errors.transportError(e, { label, provider });
    } finally {
        clearTimeout(t);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}
// Reads the body once so a non-JSON error page still yields a useful message.
async function readResponse(r) {
    const text = await r.text().catch(() => '');
    let body = null;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            /* not JSON; keep the raw text for the error mapper */
        }
    }
    return { body, text };
}
// `req.kind` is decided by the renderer: 'document' (native PDF), 'image' (bytes the
// provider accepts), or 'text' (extracted from a text/Office/spreadsheet file).
// Providers fall into three request shapes; the registry says which one to use.
async function cloud(s, req, signal) {
    const p = providerOf(s);
    const key = keyFor(s, p.id);
    if (!key) throw new Error('No ' + p.name + ' API key saved. Add one in Settings.');
    const model = (s.models || {})[p.id] || '';
    if (!model) throw new Error('No ' + p.name + ' model selected. Pick one in Settings.');
    const fields = req.fields || [];
    const text = prompt(req.name, req.text, req.dateHint, req.extra, fields);
    Errors.preflight(p, req);
    if (p.kind === 'anthropic') return cloudAnthropic(p, key, model, req, text, fields, signal);
    if (p.kind === 'google') return cloudGoogle(p, key, model, req, text, fields, signal);
    return cloudOpenAI(p, key, model, req, text, fields, signal);
}

async function cloudAnthropic(p, key, model, req, text, fields, signal) {
    const content = [];
    if (req.kind !== 'text') {
        const data = Buffer.from(req.bytes).toString('base64');
        content.push(
            req.kind === 'document'
                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
                : { type: 'image', source: { type: 'base64', media_type: MIME[req.ext], data } }
        );
    }
    content.push({ type: 'text', text });
    return timed(
        CLOUD_TIMEOUT_MS,
        'API request',
        signal,
        async (sig) => {
            const r = await fetch(p.base + '/v1/messages', {
                method: 'POST',
                signal: sig,
                headers: { ...headersFor(p, key), 'content-type': 'application/json' },
                body: JSON.stringify({
                    model,
                    max_tokens: 512,
                    messages: [{ role: 'user', content }],
                    output_config: { format: { type: 'json_schema', schema: SCHEMA(req.dateHint, fields) } }
                })
            });
            const { body: j, text: raw } = await readResponse(r);
            if (!r.ok) throw Errors.apiError({ provider: p.name, status: r.status, body: j, text: raw, headers: r.headers });
            return {
                info: Errors.parseModelJson((j?.content || []).map((c) => c.text || '').join(''), fieldKeys(fields), {
                    provider: p.name,
                    stopReason: j?.stop_reason
                }),
                usage: usageOf(j?.usage?.input_tokens, j?.usage?.output_tokens)
            };
        },
        p.name
    );
}

function openAIContent(req, text) {
    if (req.kind === 'text') return [{ type: 'text', text }];
    const parts = [];
    if (req.kind === 'image') {
        parts.push({
            type: 'image_url',
            image_url: { url: 'data:' + MIME[req.ext] + ';base64,' + Buffer.from(req.bytes).toString('base64') }
        });
    } else {
        // Chat-completions APIs do not accept PDFs, so the renderer supplies page images.
        for (const page of req.pages || []) {
            parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + Buffer.from(page).toString('base64') } });
        }
    }
    parts.push({ type: 'text', text });
    return parts;
}

async function cloudOpenAI(p, key, model, req, text, fields, signal) {
    const body = {
        model,
        max_tokens: 512,
        temperature: 0.1,
        messages: [{ role: 'user', content: openAIContent(req, text) }],
        response_format: { type: 'json_schema', json_schema: { name: 'file_info', strict: true, schema: SCHEMA(req.dateHint, fields) } }
    };
    return timed(
        CLOUD_TIMEOUT_MS,
        'API request',
        signal,
        async (sig) => {
            const send = (payload) =>
                fetch(p.base + '/chat/completions', {
                    method: 'POST',
                    signal: sig,
                    headers: { ...headersFor(p, key), 'content-type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            let r = await send(body);
            // Not every OpenAI-compatible vendor supports structured outputs. Fall back to
            // plain JSON and let parseModelJson() coerce the shape.
            if (r.status === 400 || r.status === 422) {
                const plain = { ...body };
                delete plain.response_format;
                r = await send(plain);
            }
            const { body: j, text: raw } = await readResponse(r);
            if (!r.ok) throw Errors.apiError({ provider: p.name, status: r.status, body: j, text: raw, headers: r.headers });
            return {
                info: Errors.parseModelJson(j?.choices?.[0]?.message?.content || '', fieldKeys(fields), {
                    provider: p.name,
                    stopReason: j?.choices?.[0]?.finish_reason
                }),
                usage: usageOf(j?.usage?.prompt_tokens, j?.usage?.completion_tokens)
            };
        },
        p.name
    );
}

async function cloudGoogle(p, key, model, req, text, fields, signal) {
    const parts = [];
    const inline = (mime, data) => ({ inline_data: { mime_type: mime, data: Buffer.from(data).toString('base64') } });
    if (req.kind === 'document') parts.push(inline('application/pdf', req.bytes));
    else if (req.kind === 'image') parts.push(inline(MIME[req.ext], req.bytes));
    else for (const page of req.pages || []) parts.push(inline('image/jpeg', page));
    parts.push({ text });

    const url = p.base + '/' + String(model).replace(/^models\//, '') + ':generateContent?key=' + encodeURIComponent(key);
    return timed(
        CLOUD_TIMEOUT_MS,
        'API request',
        signal,
        async (sig) => {
            const r = await fetch(url, {
                method: 'POST',
                signal: sig,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: {
                        maxOutputTokens: 512,
                        temperature: 0.1,
                        responseMimeType: 'application/json',
                        responseSchema: googleSchema(SCHEMA(req.dateHint, fields))
                    }
                })
            });
            const { body: j, text: raw } = await readResponse(r);
            if (!r.ok) throw Errors.apiError({ provider: p.name, status: r.status, body: j, text: raw, headers: r.headers });
            return {
                info: Errors.parseModelJson(
                    (j?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join(''),
                    fieldKeys(fields),
                    {
                        provider: p.name,
                        stopReason: j?.candidates?.[0]?.finishReason
                    }
                ),
                usage: usageOf(j?.usageMetadata?.promptTokenCount, j?.usageMetadata?.candidatesTokenCount)
            };
        },
        p.name
    );
}

let srv = null,
    srvKey = '',
    srvErr = '';
function stopServer() {
    if (srv) {
        srv.kill();
        srv = null;
    }
}
async function ensureServer(s) {
    const key = [s.localModel, s.localMmproj, s.llamaServer].join('|');
    if (srv && srvKey === key) return;
    stopServer();
    const bin = s.llamaServer || detectBin();
    if (!bin) throw new Error('llama-server not found. Run "brew install llama.cpp" or choose the binary in Settings.');
    if (!s.localModel) throw new Error('No local model chosen. Pick a .gguf file in Settings.');
    const args = ['-m', s.localModel, '--host', '127.0.0.1', '--port', String(PORT)];
    if (s.localMmproj) args.push('--mmproj', s.localMmproj);
    srvErr = '';
    srvKey = key;
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    srv = p;
    p.stderr.on('data', (d) => {
        srvErr = (srvErr + d).slice(-400);
    });
    p.on('exit', () => {
        if (srv === p) srv = null;
    });
    for (const t0 = Date.now(); Date.now() - t0 < 180000;) {
        if (!srv)
            throw new Error(
                'llama-server exited while loading. Check that the model and mmproj files match. ' + srvErr.trim().split('\n').pop()
            );
        try {
            if ((await fetch('http://127.0.0.1:' + PORT + '/health')).ok) return;
        } catch {
            /* server not accepting connections yet */
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Local model took more than 3 minutes to load.');
}
async function local(s, req, signal) {
    await ensureServer(s);
    const fields = req.fields || [];
    const img = (buf, mime) => ({
        type: 'image_url',
        image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64') }
    });
    let imgs = [];
    if (req.kind === 'image') imgs = [img(req.bytes, MIME[req.ext])];
    else if (req.kind === 'document') imgs = (req.pages || []).map((b) => img(b, 'image/jpeg'));
    return timed(
        LOCAL_TIMEOUT_MS,
        'Local model request',
        signal,
        async (sig) => {
            const r = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', {
                method: 'POST',
                signal: sig,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    max_tokens: 512,
                    temperature: 0.1,
                    messages: [
                        {
                            role: 'user',
                            content: [...imgs, { type: 'text', text: prompt(req.name, req.text, req.dateHint, req.extra, fields) }]
                        }
                    ],
                    // llama-server (OpenAI-compatible) grammar-constrains output to this schema when supported.
                    // Falls back harmlessly on older builds since parseModelJson() below still extracts JSON from free text.
                    response_format: {
                        type: 'json_schema',
                        json_schema: { name: 'file_info', strict: true, schema: SCHEMA(req.dateHint, fields) }
                    }
                })
            });
            const { body: j, text: raw } = await readResponse(r);
            if (!r.ok) throw Errors.apiError({ provider: 'The local model', status: r.status, body: j, text: raw, headers: r.headers });
            return {
                info: Errors.parseModelJson(j?.choices?.[0]?.message?.content || '', fieldKeys(fields), {
                    provider: 'The local model',
                    stopReason: j?.choices?.[0]?.finish_reason
                }),
                usage: usageOf(j?.usage?.prompt_tokens, j?.usage?.completion_tokens)
            };
        },
        'the local model'
    );
}

// Track in-flight requests so the renderer's Cancel button can abort them.
const inflight = new Set();
// A photo often shows no printed date, but the camera recorded one when it was taken.
// The renderer sends the original path so this still works for formats it converted
// to JPEG before the request (TIFF/HEIC, canvas re-encodes), whose EXIF would be lost.
// Only the head of the file is read: every container keeps its EXIF block near the start.
const EXIF_HEAD_BYTES = 4 * 1024 * 1024;
async function captureDate(filePath, dateFormat) {
    if (!filePath) return '';
    let fh = null;
    try {
        fh = await fs.promises.open(filePath, 'r');
        const head = Buffer.alloc(EXIF_HEAD_BYTES);
        const { bytesRead } = await fh.read(head, 0, head.length, 0);
        return Exif.formatDate(Exif.exifDate(head.subarray(0, bytesRead)), dateFormat);
    } catch {
        return '';
    } finally {
        if (fh)
            await fh.close().catch(() => {
                /* already closed */
            });
    }
}
ipcMain.handle('analyze', async (e, req) => {
    const s = read();
    const ctl = new AbortController();
    inflight.add(ctl);
    req = { ...req, dateHint: DATE_HINTS[req.dateFormat] || DEFAULT_DATE_HINT };
    const label = s.provider === 'local' ? 'the local model' : providerOf(s).name;
    // Surface retry waits on the row instead of leaving the app looking stuck.
    const notify = (message) => {
        try {
            if (!e.sender.isDestroyed()) e.sender.send('analyze:status', { id: req.id, message });
        } catch {
            /* the window closed while the request was retrying */
        }
    };
    try {
        const result = await Errors.attempt(() => (s.provider === 'local' ? local(s, req, ctl.signal) : cloud(s, req, ctl.signal)), {
            signal: ctl.signal,
            onRetry: ({ attempt, of, waitMs, error }) => notify(Errors.retryMessage(error, { attempt, of, waitMs }))
        });
        const info = result.info;
        // Fill in an estimated cost where the provider/model has a known list price.
        if (result.usage) {
            const local = s.provider === 'local';
            result.usage.local = local;
            result.usage.cost = local
                ? 0
                : estimateCost(PRICING, s.provider, (s.models || {})[s.provider], result.usage.input, result.usage.output);
        }
        // Only fill a date the model left empty; a visible printed date always wins.
        if (req.kind === 'image' && !info.date) {
            const taken = await captureDate(req.path, req.dateFormat);
            if (taken) {
                info.date = taken;
                info.dateSource = 'exif';
            }
        }
        return { ok: true, info, usage: result.usage || null };
    } catch (err) {
        const message = err && err.message ? err.message : 'Something went wrong.';
        if (!err || !err.cancelled)
            console.error(
                '[analyze]',
                label + ':',
                err && err.status ? 'HTTP ' + err.status : 'error',
                err && err.requestId ? 'request ' + err.requestId : '',
                (err && (err.detail || err.message)) || message
            );
        return { ok: false, error: message };
    } finally {
        inflight.delete(ctl);
    }
});
ipcMain.handle('abort', () => {
    for (const c of inflight) c.abort();
    return true;
});

// sips ships with macOS and handles the formats Chromium cannot decode
// (TIFF, HEIC/HEIF), which the renderer's canvas-based conversion cannot reach.
const SIPS = '/usr/bin/sips';
async function sipsToJpeg(buf, max) {
    if (!fs.existsSync(SIPS)) throw new Error('TIFF and HEIC conversion needs macOS sips.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misnomer-'));
    const src = path.join(dir, 'input'),
        dst = path.join(dir, 'output.jpg');
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
        await fs.promises.writeFile(src, buf);
    } catch (e) {
        cleanup();
        throw e;
    }
    const args = ['-s', 'format', 'jpeg'];
    // Thumbnails only need a small image; resize during the conversion instead of
    // converting at full size and shrinking the bytes in the renderer.
    if (max) args.push('-Z', String(max));
    args.push(src, '--out', dst);
    return new Promise((resolve, reject) => {
        const p = spawn(SIPS, args);
        let err = '';
        p.stderr.on('data', (d) => {
            err = (err + d).slice(-300);
        });
        p.on('error', (e) => {
            cleanup();
            reject(e);
        });
        p.on('exit', async (code) => {
            try {
                if (code !== 0 || !fs.existsSync(dst)) throw new Error('Could not convert the image: ' + err.trim());
                resolve(await fs.promises.readFile(dst));
            } catch (e) {
                reject(e);
            } finally {
                cleanup();
            }
        });
    });
}
ipcMain.handle('convert', async (_e, buf, max) => {
    try {
        return { ok: true, bytes: await sipsToJpeg(Buffer.from(buf), max) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ---------------------------------------------------------------------------
// Filesystem access for in-place renaming. The renderer only ever deals in
// paths; every operation below is confined to the folder a file came from.
// ---------------------------------------------------------------------------
const MAX_EXPAND = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

async function walk(dir, out) {
    for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (out.length >= MAX_EXPAND) return;
        if (ent.name.startsWith('.')) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) await walk(p, out);
        } else if (ent.isFile()) out.push(p);
        else if (ent.isSymbolicLink()) {
            try {
                if ((await fs.promises.stat(p)).isFile()) out.push(p);
            } catch {
                /* broken link */
            }
        }
    }
}

// Expands files and folders into a flat list. Folders are walked recursively.
// Async so a large drop does not freeze the window while it is scanned.
ipcMain.handle('files:expand', async (_e, paths) => {
    try {
        const found = [];
        for (const p of paths || []) {
            if (found.length >= MAX_EXPAND) break;
            let st;
            try {
                st = await fs.promises.stat(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) await walk(p, found);
            else if (st.isFile()) found.push(p);
        }
        const files = found.map((p) => {
            const name = path.basename(p);
            return { path: p, dir: path.dirname(p), name, ext: (name.split('.').pop() || '').toLowerCase() };
        });
        return { ok: true, truncated: found.length >= MAX_EXPAND, files };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('files:read', async (_e, p) => {
    try {
        return { ok: true, bytes: await fs.promises.readFile(p) };
    } catch (e) {
        return { ok: false, error: Errors.fsError(e, { name: path.basename(String(p)), action: 'read' }).message };
    }
});

// Filenames currently in each directory, so collisions can be resolved before renaming.
ipcMain.handle('files:existing', async (_e, dirs) => {
    const out = {};
    await Promise.all(
        (dirs || []).map(async (d) => {
            try {
                out[d] = await fs.promises.readdir(d);
            } catch {
                out[d] = [];
            }
        })
    );
    return out;
});

ipcMain.handle('files:rename', (_e, plan) =>
    (plan || []).map((e) => {
        const from = String(e.from || ''),
            to = String(e.to || '');
        try {
            if (!from || !to) return { id: e.id, ok: false, error: 'Missing path.' };
            // The single guard that stops a bad plan from moving a file anywhere else on disk.
            if (path.dirname(from) !== path.dirname(to))
                return { id: e.id, ok: false, error: 'Refusing to move a file to another folder.' };
            if (from === to) return { id: e.id, ok: true, skipped: true };
            // On a case-insensitive volume a case-only rename resolves to the same file,
            // so existsSync would wrongly look like a collision.
            const caseOnly = from.toLowerCase() === to.toLowerCase();
            if (!caseOnly && fs.existsSync(to)) return { id: e.id, ok: false, error: 'Another file already uses that name.' };
            fs.renameSync(from, to);
            return { id: e.id, ok: true };
        } catch (err) {
            return { id: e.id, ok: false, error: Errors.fsError(err, { name: path.basename(to || from), action: 'rename' }).message };
        }
    })
);

// ---------------------------------------------------------------------------
// ZIP export. Files stream from disk through archiver, so a large batch never
// has to be loaded into the renderer or held in memory as one buffer.
// ---------------------------------------------------------------------------
let zipJob = null,
    quitting = false;

const zipFail = (message) => ({ ok: false, error: message });
function sendZip(sender, payload) {
    if (!sender.isDestroyed()) sender.send('zip:progress', payload);
}

ipcMain.handle('zip:create', async (event, entries) => {
    if (zipJob) return zipFail('An archive is already being created.');
    // Reserve the slot before the save dialog so two clicks cannot start two jobs.
    zipJob = { cancel: null };
    try {
        const plan = ZipEntries.plan(entries);
        if (!plan.length) throw new Error('There are no completed files to archive.');

        let totalBytes = 0;
        for (const entry of plan) {
            const st = await fs.promises.stat(entry.path);
            if (!st.isFile()) throw new Error(entry.name + ' is not a file.');
            totalBytes += st.size;
        }

        const picked = await dialog.showSaveDialog({
            defaultPath: path.join(app.getPath('downloads'), 'renamed-files.zip'),
            filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
        });
        if (picked.canceled || !picked.filePath) {
            zipJob = null;
            return { ok: false, canceled: true };
        }
        const target = picked.filePath;
        const job = startArchive({
            entries: plan,
            target,
            totalBytes,
            onProgress: (progress) => sendZip(event.sender, progress)
        });
        zipJob = job;
        try {
            return await job.promise;
        } finally {
            zipJob = null;
        }
    } catch (err) {
        zipJob = null;
        return zipFail(err.message);
    }
});

ipcMain.handle('zip:cancel', () => {
    if (!zipJob || !zipJob.cancel) return false;
    zipJob.cancel();
    return true;
});

ipcMain.handle('settings:get', () => {
    const s = read();
    // Only report which providers have a key plus the last four characters.
    const keys = {};
    for (const p of PROVIDERS) {
        const k = keyFor(s, p.id);
        if (k) keys[p.id] = k.slice(-4);
    }
    return {
        engine: s.engine,
        provider: providerOf(s).id,
        models: s.models,
        keys,
        pdfMode: pdfMode(s),
        localModel: s.localModel,
        localMmproj: s.localMmproj,
        llamaServer: s.llamaServer,
        detectedBin: detectBin(),
        presets: s.presets,
        activePreset: s.activePreset,
        theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto'
    };
});
ipcMain.handle('settings:set', (_e, p) => {
    const s = read();
    // Key and model operations apply to the provider in the payload, or the current one.
    const target = providerById(p.provider) || providerOf(s);
    if (p.apiKey) {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Secure storage is unavailable, key not saved.' };
        s.apiKeys = { ...s.apiKeys, [target.id]: safeStorage.encryptString(p.apiKey).toString('base64') };
    }
    if (p.clearKey) {
        s.apiKeys = { ...s.apiKeys };
        delete s.apiKeys[target.id];
    }
    if (typeof p.model === 'string') s.models = { ...s.models, [target.id]: p.model };
    for (const k of ['engine', 'provider', 'localModel', 'localMmproj', 'llamaServer', 'presets', 'activePreset']) if (k in p) s[k] = p[k];
    if (['auto', 'light', 'dark'].includes(p.theme)) {
        s.theme = p.theme;
        nativeTheme.themeSource = p.theme === 'auto' ? 'system' : p.theme;
    }
    write(s);
    return { ok: true };
});
// Fetches the provider's model catalogue. A successful call doubles as the
// connection check shown in Settings.
ipcMain.handle('models:list', async (_e, providerId) => {
    const s = read();
    const p = providerById(providerId) || providerOf(s);
    const key = keyFor(s, p.id);
    if (!key) return { ok: false, error: 'Save an API key first.' };
    try {
        const check = authRequest(p, key);
        if (check) {
            const r = await timed(
                20000,
                'Connection check',
                null,
                (signal) => fetch(check.url, { headers: check.headers, signal }),
                p.name
            );
            if (!r.ok) {
                const { body: j, text: raw } = await readResponse(r);
                throw Errors.apiError({ provider: p.name, status: r.status, body: j, text: raw, headers: r.headers });
            }
        }
        const models = await timed(
            20000,
            'Model list request',
            null,
            async (signal) => {
                const r = await fetch(modelUrl(p, key), { headers: headersFor(p, key), signal });
                const { body: j, text: raw } = await readResponse(r);
                if (!r.ok) throw Errors.apiError({ provider: p.name, status: r.status, body: j, text: raw, headers: r.headers });
                const list = parseModels(p, j);
                return list;
            },
            p.name
        );
        if (!models.length) throw new Error('The key works, but no models were returned.');
        return { ok: true, models };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});
ipcMain.handle('pick', async (_e, kind) => {
    const r = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: kind === 'bin' ? [] : [{ name: 'GGUF model', extensions: ['gguf'] }]
    });
    return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('save', async (_e, name, buf) => {
    const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('downloads'), name) });
    if (r.canceled || !r.filePath) return false;
    await fs.promises.writeFile(r.filePath, Buffer.from(buf));
    return true;
});
// Only links we put in the UI ourselves may be opened externally.
const ALLOWED_HOSTS = new Set(['huggingface.co']);
for (const p of PROVIDERS) {
    try {
        ALLOWED_HOSTS.add(new URL(p.docs).host);
    } catch {
        /* ignore malformed docs url */
    }
}
ipcMain.handle('open', (_e, url) => {
    try {
        const u = new URL(String(url));
        if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.host)) shell.openExternal(u.toString());
    } catch {
        /* ignore malformed urls */
    }
});

// Settings used to live under the previous product name. Copy them over once so
// renaming the app does not silently drop saved keys and presets.
const LEGACY_APP_NAME = 'AI File Renamer';
function migrateUserData() {
    try {
        const current = app.getPath('userData');
        if (fs.existsSync(path.join(current, 'settings.json'))) return;
        const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME, 'settings.json');
        if (!fs.existsSync(legacy)) return;
        fs.mkdirSync(current, { recursive: true });
        fs.copyFileSync(legacy, path.join(current, 'settings.json'));
    } catch {
        /* best effort; a fresh settings file is created on first save */
    }
}

// ---------------------------------------------------------------------------
// Auto-update. electron-updater reads app-update.yml from the packaged app and
// checks the GitHub release feed. Checks are skipped in development because
// the updater needs the installed, signed bundle.
// ---------------------------------------------------------------------------
const UPDATE_DELAY_MS = 5000,
    UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const updater = {
    supported: app.isPackaged,
    state: app.isPackaged ? 'idle' : 'unsupported',
    version: '',
    percent: 0,
    message: ''
};
let updateTimer = null;

const updateSnapshot = () => ({ ...updater, currentVersion: app.getVersion() });
function broadcastUpdate() {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('updates:status', updateSnapshot());
    }
}
function setUpdater(patch) {
    Object.assign(updater, patch);
    broadcastUpdate();
}
// Turn electron-updater's raw errors into something the user can act on.
function updaterError(err) {
    const raw = String(err?.message || err || 'Update check failed.');
    let message = raw;
    if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|net::/i.test(raw))
        message = 'Could not reach GitHub. Check your connection and try again.';
    else if (/latest-mac\.yml|latest version|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|no published versions/i.test(raw))
        message = 'No published update was found yet.';
    else if (/code signature|not signed/i.test(raw)) message = 'This build is not signed, so macOS cannot install updates.';
    setUpdater({ state: 'error', percent: 0, message });
}
function checkForUpdates() {
    if (!app.isPackaged) return Promise.resolve(updateSnapshot());
    if (['checking', 'downloading', 'downloaded'].includes(updater.state)) return Promise.resolve(updateSnapshot());
    return autoUpdater
        .checkForUpdates()
        .catch(updaterError)
        .then(() => updateSnapshot());
}
function wireUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => setUpdater({ state: 'checking', version: '', percent: 0, message: '' }));
    autoUpdater.on('update-available', (info) =>
        setUpdater({ state: 'downloading', version: String(info?.version || ''), percent: 0, message: '' })
    );
    autoUpdater.on('update-not-available', () => setUpdater({ state: 'up-to-date', version: '', percent: 0, message: '' }));
    autoUpdater.on('download-progress', (p) =>
        setUpdater({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0))), message: '' })
    );
    autoUpdater.on('update-downloaded', (info) =>
        setUpdater({ state: 'downloaded', version: String(info?.version || ''), percent: 100, message: '' })
    );
    autoUpdater.on('error', updaterError);
}
function initUpdater(win) {
    if (!app.isPackaged) return;
    wireUpdater();
    win.webContents.once('did-finish-load', () => setTimeout(checkForUpdates, UPDATE_DELAY_MS));
    updateTimer = setInterval(checkForUpdates, UPDATE_INTERVAL_MS);
}
ipcMain.handle('updates:get', () => updateSnapshot());
ipcMain.handle('updates:check', () => checkForUpdates());
ipcMain.handle('updates:install', () => {
    if (updater.state !== 'downloaded') return false;
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
});

app.whenReady().then(() => {
    migrateUserData();
    if (!app.isPackaged && process.platform === 'darwin') {
        app.dock.setIcon(path.join(__dirname, 'build', 'icon-512.png'));
    }
    // Match the native title bar and menus to the saved preference before the page paints.
    const theme = read().theme;
    nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
    const w = new BrowserWindow({
        width: 1120,
        height: 800,
        minWidth: 900,
        minHeight: 620,
        title: 'Misnomer',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 16 } } : {}),
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    initUpdater(w);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);
app.on('before-quit', () => clearInterval(updateTimer));
app.on('before-quit', (event) => {
    if (quitting || !zipJob || !zipJob.promise) return;
    // Let the archive stream close and remove its partial file before exiting.
    quitting = true;
    event.preventDefault();
    const job = zipJob;
    job.cancel();
    job.promise.finally(() => app.quit());
});
