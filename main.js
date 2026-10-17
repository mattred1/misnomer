const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os'), { spawn } = require('child_process');
const { LIST: PROVIDERS, providerById, headersFor, modelUrl, authRequest, parseModels, googleSchema, migrateSettings } = require('./renderer/providers.js');

const CLOUD_TIMEOUT_MS = 120000, LOCAL_TIMEOUT_MS = 120000, PORT = 8187;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{date}-{entity}-{type}-{title}', sep: '-', dateFormat: 'ymd', extra: '' };
// A factory so each read gets its own objects rather than sharing mutable defaults.
const DEF = () => ({
    engine: 'cloud', provider: 'anthropic', models: {}, apiKeys: {},
    localModel: '', localMmproj: '', llamaServer: '', presets: [DEFAULT_PRESET], activePreset: 'default'
});
const SF = () => path.join(app.getPath('userData'), 'settings.json');
const write = (s) => fs.writeFileSync(SF(), JSON.stringify(s, null, 2));
// Reads settings, migrating the single-provider layout that predates the provider list.
function read() {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(SF(), 'utf8')); } catch { /* first run, or unreadable file */ }
    return migrateSettings(parsed, DEF());
}
const decrypt = (enc) => { try { return enc ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch { return ''; } };
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
        entity: { type: 'string', description: 'The vendor, company, or person tied to the document, or an empty string if none is identifiable' },
        date: { type: 'string', description: dateHint || DEFAULT_DATE_HINT },
        type: { type: 'string', description: 'One or two words describing the document type, like invoice, receipt, screenshot, photo, or resume' }
    };
    for (const f of fields || []) {
        if (!f.key || properties[f.key]) continue; // never overwrite a built-in field
        properties[f.key] = { type: 'string', description: f.description || 'The ' + f.key.replace(/[_-]+/g, ' ') + ' for this file, or an empty string if not applicable' };
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
    let p = 'You name files. Look at the attached file and describe it using the required fields: ' + parts.join(', ') + '. '
        + 'Lowercase plain words, no punctuation. Never guess a date; use an empty string if none is visible. '
        + 'Reply with only a JSON object containing those fields.';
    if (extra && extra.trim()) p += ' Additional instructions: ' + extra.trim();
    p += ' Original filename: ' + name + (text ? '\n\nExtracted text:\n' + text : '');
    return p;
}
function parse(t, keys) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('Model did not return JSON: ' + t.slice(0, 120));
    const j = JSON.parse(t.slice(a, b + 1));
    const out = {};
    for (const k of keys) out[k] = String(j[k] || '');
    return out;
}
async function timed(ms, label, signal, fn) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const t = setTimeout(() => ctl.abort(), ms);
    try { return await fn(ctl.signal); }
    catch (e) {
        if (e.name === 'AbortError') {
            // Distinguish a user cancellation from our own timeout.
            if (signal && signal.aborted) throw new Error('Cancelled.');
            throw new Error(label + ' timed out after ' + ms / 1000 + ' seconds.');
        }
        const err = new Error(e.cause?.message ? e.message + ': ' + e.cause.message : e.message);
        // Keep the HTTP status so attempt() can decide whether the call is worth retrying.
        if (e.status) err.status = e.status;
        throw err;
    } finally { clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort); }
}
const httpError = (label, status, detail) => {
    const e = new Error(label + ' ' + status + ': ' + detail);
    e.status = status;
    return e;
};
// Rate limiting, overload, and transient server failures are worth waiting out.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const RETRIES = 3;
async function attempt(fn) {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e) {
            if (i >= RETRIES - 1 || !RETRY_STATUS.has(e.status)) throw e;
            // Exponential backoff with jitter so parallel workers do not retry in lockstep.
            await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** i) + Math.random() * 250));
        }
    }
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
    if (p.kind === 'anthropic') return cloudAnthropic(p, key, model, req, text, fields, signal);
    if (p.kind === 'google') return cloudGoogle(p, key, model, req, text, fields, signal);
    return cloudOpenAI(p, key, model, req, text, fields, signal);
}

async function cloudAnthropic(p, key, model, req, text, fields, signal) {
    const content = [];
    if (req.kind !== 'text') {
        const data = Buffer.from(req.bytes).toString('base64');
        content.push(req.kind === 'document'
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
            : { type: 'image', source: { type: 'base64', media_type: MIME[req.ext], data } });
    }
    content.push({ type: 'text', text });
    return timed(CLOUD_TIMEOUT_MS, 'API request', signal, async (sig) => {
        const r = await fetch(p.base + '/v1/messages', {
            method: 'POST', signal: sig,
            headers: { ...headersFor(p, key), 'content-type': 'application/json' },
            body: JSON.stringify({
                model, max_tokens: 300,
                messages: [{ role: 'user', content }],
                output_config: { format: { type: 'json_schema', schema: SCHEMA(req.dateHint, fields) } }
            })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(p.name + ' error', r.status, j.error?.message || r.statusText);
        return parse((j.content || []).map((c) => c.text || '').join(''), fieldKeys(fields));
    });
}

function openAIContent(req, text) {
    if (req.kind === 'text') return [{ type: 'text', text }];
    const parts = [];
    if (req.kind === 'image') {
        parts.push({ type: 'image_url', image_url: { url: 'data:' + MIME[req.ext] + ';base64,' + Buffer.from(req.bytes).toString('base64') } });
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
        model, max_tokens: 300, temperature: 0.1,
        messages: [{ role: 'user', content: openAIContent(req, text) }],
        response_format: { type: 'json_schema', json_schema: { name: 'file_info', strict: true, schema: SCHEMA(req.dateHint, fields) } }
    };
    return timed(CLOUD_TIMEOUT_MS, 'API request', signal, async (sig) => {
        const send = (payload) => fetch(p.base + '/chat/completions', {
            method: 'POST', signal: sig,
            headers: { ...headersFor(p, key), 'content-type': 'application/json' },
            body: JSON.stringify(payload)
        });
        let r = await send(body);
        // Not every OpenAI-compatible vendor supports structured outputs. Fall back to
        // plain JSON and let parse() coerce the shape.
        if (r.status === 400 || r.status === 422) {
            const plain = { ...body };
            delete plain.response_format;
            r = await send(plain);
        }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(p.name + ' error', r.status, j.error?.message || j.message || r.statusText);
        return parse(j.choices?.[0]?.message?.content || '', fieldKeys(fields));
    });
}

async function cloudGoogle(p, key, model, req, text, fields, signal) {
    const parts = [];
    const inline = (mime, data) => ({ inline_data: { mime_type: mime, data: Buffer.from(data).toString('base64') } });
    if (req.kind === 'document') parts.push(inline('application/pdf', req.bytes));
    else if (req.kind === 'image') parts.push(inline(MIME[req.ext], req.bytes));
    else for (const page of req.pages || []) parts.push(inline('image/jpeg', page));
    parts.push({ text });

    const url = p.base + '/' + String(model).replace(/^models\//, '') + ':generateContent?key=' + encodeURIComponent(key);
    return timed(CLOUD_TIMEOUT_MS, 'API request', signal, async (sig) => {
        const r = await fetch(url, {
            method: 'POST', signal: sig,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts }],
                generationConfig: {
                    maxOutputTokens: 300, temperature: 0.1,
                    responseMimeType: 'application/json',
                    responseSchema: googleSchema(SCHEMA(req.dateHint, fields))
                }
            })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError(p.name + ' error', r.status, j.error?.message || r.statusText);
        return parse((j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join(''), fieldKeys(fields));
    });
}

let srv = null, srvKey = '', srvErr = '';
function stopServer() { if (srv) { srv.kill(); srv = null; } }
async function ensureServer(s) {
    const key = [s.localModel, s.localMmproj, s.llamaServer].join('|');
    if (srv && srvKey === key) return;
    stopServer();
    const bin = s.llamaServer || detectBin();
    if (!bin) throw new Error('llama-server not found. Run "brew install llama.cpp" or choose the binary in Settings.');
    if (!s.localModel) throw new Error('No local model chosen. Pick a .gguf file in Settings.');
    const args = ['-m', s.localModel, '--host', '127.0.0.1', '--port', String(PORT)];
    if (s.localMmproj) args.push('--mmproj', s.localMmproj);
    srvErr = ''; srvKey = key;
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    srv = p;
    p.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-400); });
    p.on('exit', () => { if (srv === p) srv = null; });
    for (const t0 = Date.now(); Date.now() - t0 < 180000;) {
        if (!srv) throw new Error('llama-server exited while loading. Check that the model and mmproj files match. ' + srvErr.trim().split('\n').pop());
        try { if ((await fetch('http://127.0.0.1:' + PORT + '/health')).ok) return; } catch { /* server not accepting connections yet */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Local model took more than 3 minutes to load.');
}
async function local(s, req, signal) {
    await ensureServer(s);
    const fields = req.fields || [];
    const img = (buf, mime) => ({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64') } });
    let imgs = [];
    if (req.kind === 'image') imgs = [img(req.bytes, MIME[req.ext])];
    else if (req.kind === 'document') imgs = (req.pages || []).map((b) => img(b, 'image/jpeg'));
    return timed(LOCAL_TIMEOUT_MS, 'Local model request', signal, async (sig) => {
        const r = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', {
            method: 'POST', signal: sig, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                max_tokens: 300, temperature: 0.1,
                messages: [{ role: 'user', content: [...imgs, { type: 'text', text: prompt(req.name, req.text, req.dateHint, req.extra, fields) }] }],
                // llama-server (OpenAI-compatible) grammar-constrains output to this schema when supported.
                // Falls back harmlessly on older builds since parse() below still extracts JSON from free text.
                response_format: { type: 'json_schema', json_schema: { name: 'file_info', strict: true, schema: SCHEMA(req.dateHint, fields) } }
            })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw httpError('Local server error', r.status, j.error?.message || r.statusText);
        return parse(j.choices?.[0]?.message?.content || '', fieldKeys(fields));
    });
}

// Track in-flight requests so the renderer's Cancel button can abort them.
const inflight = new Set();
ipcMain.handle('analyze', async (_e, req) => {
    const s = read();
    const ctl = new AbortController();
    inflight.add(ctl);
    req = { ...req, dateHint: DATE_HINTS[req.dateFormat] || DEFAULT_DATE_HINT };
    try { return { ok: true, info: await attempt(() => (s.provider === 'local' ? local(s, req, ctl.signal) : cloud(s, req, ctl.signal))) }; }
    catch (e) { return { ok: false, error: e.message }; }
    finally { inflight.delete(ctl); }
});
ipcMain.handle('abort', () => { for (const c of inflight) c.abort(); return true; });

// sips ships with macOS and handles the formats Chromium cannot decode
// (TIFF, HEIC/HEIF), which the renderer's canvas-based conversion cannot reach.
const SIPS = '/usr/bin/sips';
function sipsToJpeg(buf) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(SIPS)) return reject(new Error('TIFF and HEIC conversion needs macOS sips.'));
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afr-'));
        const src = path.join(dir, 'input'), dst = path.join(dir, 'output.jpg');
        const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
        try { fs.writeFileSync(src, buf); } catch (e) { cleanup(); return reject(e); }
        const p = spawn(SIPS, ['-s', 'format', 'jpeg', src, '--out', dst]);
        let err = '';
        p.stderr.on('data', (d) => { err = (err + d).slice(-300); });
        p.on('error', (e) => { cleanup(); reject(e); });
        p.on('exit', (code) => {
            try {
                if (code !== 0 || !fs.existsSync(dst)) return reject(new Error('Could not convert the image: ' + err.trim()));
                resolve(fs.readFileSync(dst));
            } finally { cleanup(); }
        });
    });
}
ipcMain.handle('convert', async (_e, buf) => {
    try { return { ok: true, bytes: await sipsToJpeg(Buffer.from(buf)) }; }
    catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------------------
// Filesystem access for in-place renaming. The renderer only ever deals in
// paths; every operation below is confined to the folder a file came from.
// ---------------------------------------------------------------------------
const MAX_EXPAND = 2000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg']);

function walk(dir, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_EXPAND) return;
        if (ent.name.startsWith('.')) continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(p, out); }
        else if (ent.isFile()) out.push(p);
        else if (ent.isSymbolicLink()) { try { if (fs.statSync(p).isFile()) out.push(p); } catch { /* broken link */ } }
    }
}

// Expands files and folders into a flat list. Folders are walked recursively.
ipcMain.handle('files:expand', (_e, paths) => {
    try {
        const found = [];
        for (const p of paths || []) {
            if (found.length >= MAX_EXPAND) break;
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.isDirectory()) walk(p, found);
            else if (st.isFile()) found.push(p);
        }
        const files = found.map((p) => {
            const name = path.basename(p);
            return { path: p, dir: path.dirname(p), name, ext: (name.split('.').pop() || '').toLowerCase() };
        });
        return { ok: true, truncated: found.length >= MAX_EXPAND, files };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('files:read', (_e, p) => {
    try { return { ok: true, bytes: fs.readFileSync(p) }; }
    catch (e) { return { ok: false, error: e.message }; }
});

// Filenames currently in each directory, so collisions can be resolved before renaming.
ipcMain.handle('files:existing', (_e, dirs) => {
    const out = {};
    for (const d of dirs || []) { try { out[d] = fs.readdirSync(d); } catch { out[d] = []; } }
    return out;
});

ipcMain.handle('files:rename', (_e, plan) => (plan || []).map((e) => {
    const from = String(e.from || ''), to = String(e.to || '');
    try {
        if (!from || !to) return { id: e.id, ok: false, error: 'Missing path.' };
        // The single guard that stops a bad plan from moving a file anywhere else on disk.
        if (path.dirname(from) !== path.dirname(to)) return { id: e.id, ok: false, error: 'Refusing to move a file to another folder.' };
        if (from === to) return { id: e.id, ok: true, skipped: true };
        // On a case-insensitive volume a case-only rename resolves to the same file,
        // so existsSync would wrongly look like a collision.
        const caseOnly = from.toLowerCase() === to.toLowerCase();
        if (!caseOnly && fs.existsSync(to)) return { id: e.id, ok: false, error: 'That name is already taken.' };
        fs.renameSync(from, to);
        return { id: e.id, ok: true };
    } catch (err) { return { id: e.id, ok: false, error: err.message }; }
}));
ipcMain.handle('settings:get', () => {
    const s = read();
    // Only report which providers have a key plus the last four characters.
    const keys = {};
    for (const p of PROVIDERS) {
        const k = keyFor(s, p.id);
        if (k) keys[p.id] = k.slice(-4);
    }
    return {
        engine: s.engine, provider: providerOf(s).id, models: s.models, keys, pdfMode: pdfMode(s),
        localModel: s.localModel, localMmproj: s.localMmproj, llamaServer: s.llamaServer, detectedBin: detectBin(),
        presets: s.presets, activePreset: s.activePreset
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
    write(s); return { ok: true };
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
            const r = await fetch(check.url, { headers: check.headers });
            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw httpError(p.name + ' error', r.status, j.error?.message || r.statusText);
            }
        }
        const models = await timed(20000, 'Model list request', null, async (signal) => {
            const r = await fetch(modelUrl(p, key), { headers: headersFor(p, key), signal });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw httpError(p.name + ' error', r.status, j.error?.message || j.message || r.statusText);
            const list = parseModels(p, j);
            if (!list.length) throw new Error('The key works, but no models were returned.');
            return list;
        });
        return { ok: true, models };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});
ipcMain.handle('pick', async (_e, kind) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: kind === 'bin' ? [] : [{ name: 'GGUF model', extensions: ['gguf'] }] });
    return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('save', async (_e, name, buf) => {
    const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('downloads'), name) });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, Buffer.from(buf)); return true;
});
// Only links we put in the UI ourselves may be opened externally.
const ALLOWED_HOSTS = new Set(['huggingface.co']);
for (const p of PROVIDERS) {
    try { ALLOWED_HOSTS.add(new URL(p.docs).host); } catch { /* ignore malformed docs url */ }
}
ipcMain.handle('open', (_e, url) => {
    try {
        const u = new URL(String(url));
        if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.host)) shell.openExternal(u.toString());
    } catch { /* ignore malformed urls */ }
});

app.whenReady().then(() => {
    const w = new BrowserWindow({ width: 980, height: 820, title: 'AI File Renamer', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);
