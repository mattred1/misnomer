const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path'), fs = require('fs'), { spawn } = require('child_process');

const CLOUD_TIMEOUT_MS = 120000, LOCAL_TIMEOUT_MS = 120000, PORT = 8187;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
const DEFAULT_PRESET = { id: 'default', name: 'Default', template: '{date}-{entity}-{type}-{title}', sep: '-', dateFormat: 'ymd', extra: '' };
const DEF = { provider: 'anthropic', model: 'claude-haiku-5-5', apiKeyEnc: '', localModel: '', localMmproj: '', llamaServer: '', presets: [DEFAULT_PRESET], activePreset: 'default' };
const SF = () => path.join(app.getPath('userData'), 'settings.json');
const read = () => { try { return { ...DEF, ...JSON.parse(fs.readFileSync(SF(), 'utf8')) }; } catch { return { ...DEF }; } };
const write = (s) => fs.writeFileSync(SF(), JSON.stringify(s, null, 2));
const getKey = (s) => { try { return s.apiKeyEnc ? safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64')) : ''; } catch { return ''; } };
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
const SCHEMA = (dateHint) => ({
    type: 'object',
    properties: {
        title: { type: 'string', description: 'A 2 to 5 word plain-language description of the file contents, lowercase, no punctuation' },
        entity: { type: 'string', description: 'The vendor, company, or person tied to the document, or an empty string if none is identifiable' },
        date: { type: 'string', description: dateHint || DEFAULT_DATE_HINT },
        type: { type: 'string', description: 'One or two words describing the document type, like invoice, receipt, screenshot, photo, or resume' }
    },
    required: ['title', 'entity', 'date', 'type'],
    additionalProperties: false
});

function prompt(name, text, dateHint, extra) {
    let p = 'You name files. Look at the attached file and describe it using the required fields: '
        + 'title (2 to 5 word description), entity (vendor, person or company, or empty), '
        + 'date (' + (dateHint || DEFAULT_DATE_HINT) + '), and type (one or two words like invoice, receipt, screenshot, photo, resume). '
        + 'Lowercase plain words, no punctuation. Never guess a date; use an empty string if none is visible.';
    if (extra && extra.trim()) p += ' Additional instructions: ' + extra.trim();
    p += ' Original filename: ' + name + (text ? '\n\nExtracted text:\n' + text : '');
    return p;
}
function parse(t) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('Model did not return JSON: ' + t.slice(0, 120));
    const j = JSON.parse(t.slice(a, b + 1));
    return { title: String(j.title || ''), entity: String(j.entity || ''), date: String(j.date || ''), type: String(j.type || '') };
}
async function timed(ms, label, fn) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try { return await fn(ctl.signal); }
    catch (e) {
        if (e.name === 'AbortError') throw new Error(label + ' timed out after ' + ms / 1000 + ' seconds.');
        throw new Error(e.cause?.message ? e.message + ': ' + e.cause.message : e.message);
    } finally { clearTimeout(t); }
}
async function cloud(s, req) {
    const key = getKey(s);
    if (!key) throw new Error('No Anthropic API key saved. Add one in Settings.');
    const data = Buffer.from(req.bytes).toString('base64');
    const block = req.ext === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
        : { type: 'image', source: { type: 'base64', media_type: MIME[req.ext], data } };
    return timed(CLOUD_TIMEOUT_MS, 'API request', async (signal) => {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST', signal,
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
                model: s.model, max_tokens: 300,
                messages: [{ role: 'user', content: [block, { type: 'text', text: prompt(req.name, '', req.dateHint, req.extra) }] }],
                output_config: { format: { type: 'json_schema', schema: SCHEMA(req.dateHint) } }
            })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error('API error ' + r.status + ': ' + (j.error?.message || r.statusText));
        return parse((j.content || []).map((c) => c.text || '').join(''));
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
        try { if ((await fetch('http://127.0.0.1:' + PORT + '/health')).ok) return; } catch { }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('Local model took more than 3 minutes to load.');
}
async function local(s, req) {
    await ensureServer(s);
    const img = (buf, mime) => ({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64') } });
    const imgs = req.ext === 'pdf' ? (req.pages || []).map((b) => img(b, 'image/jpeg')) : [img(req.bytes, MIME[req.ext])];
    return timed(LOCAL_TIMEOUT_MS, 'Local model request', async (signal) => {
        const r = await fetch('http://127.0.0.1:' + PORT + '/v1/chat/completions', {
            method: 'POST', signal, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                max_tokens: 300, temperature: 0.1,
                messages: [{ role: 'user', content: [...imgs, { type: 'text', text: prompt(req.name, req.text, req.dateHint, req.extra) }] }],
                // llama-server (OpenAI-compatible) grammar-constrains output to this schema when supported.
                // Falls back harmlessly on older builds since parse() below still extracts JSON from free text.
                response_format: { type: 'json_schema', json_schema: { name: 'file_info', strict: true, schema: SCHEMA(req.dateHint) } }
            })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error('Local server error ' + r.status + ': ' + (j.error?.message || r.statusText));
        return parse(j.choices?.[0]?.message?.content || '');
    });
}

ipcMain.handle('analyze', async (_e, req) => {
    const s = read();
    req = { ...req, dateHint: DATE_HINTS[req.dateFormat] || DEFAULT_DATE_HINT };
    try { return { ok: true, info: await (s.provider === 'local' ? local(s, req) : cloud(s, req)) }; }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('settings:get', () => {
    const s = read(), k = getKey(s);
    return {
        provider: s.provider, model: s.model, hasKey: !!k, keyTail: k.slice(-4),
        localModel: s.localModel, localMmproj: s.localMmproj, llamaServer: s.llamaServer, detectedBin: detectBin(),
        presets: s.presets, activePreset: s.activePreset
    };
});
ipcMain.handle('settings:set', (_e, p) => {
    const s = read();
    if (p.apiKey) {
        if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Secure storage is unavailable, key not saved.' };
        s.apiKeyEnc = safeStorage.encryptString(p.apiKey).toString('base64');
    }
    if (p.clearKey) s.apiKeyEnc = '';
    for (const k of ['provider', 'model', 'localModel', 'localMmproj', 'llamaServer', 'presets', 'activePreset']) if (k in p) s[k] = p[k];
    write(s); return { ok: true };
});
ipcMain.handle('pick', async (_e, kind) => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: kind === 'bin' ? [] : [{ name: 'GGUF model', extensions: ['gguf'] }] });
    return r.canceled ? '' : r.filePaths[0];
});
ipcMain.handle('save', async (_e, name, buf) => {
    const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('downloads'), name) });
    if (r.canceled || !r.filePath) return false;
    fs.writeFileSync(r.filePath, Buffer.from(buf)); return true;
});
ipcMain.handle('open', (_e, url) => { if (/^https:\/\/huggingface\.co\//.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
    const w = new BrowserWindow({ width: 980, height: 820, title: 'AI File Renamer', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopServer);
