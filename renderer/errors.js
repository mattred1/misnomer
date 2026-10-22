// Error translation for provider requests and local file operations.
// Deliberately free of Electron and Node APIs so it can be unit tested; main.js
// supplies the HTTP status, body, and headers it read from the response.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Errors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_ATTEMPTS = 4;
    // Rate limiting, overload, and transient server failures are worth waiting out.
    const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
    const MAX_WAIT_MS = 30000;
    const BASE_WAIT_MS = 1000;
    const MAX_BACKOFF_MS = 20000;

    // Providers can return an HTML error page instead of JSON; never show that to the user.
    const looksLikeHtml = (s) => /<(?:!doctype|html|head|body|title|p|div|h1)\b/i.test(s);
    const clean = (s, max = 200) => {
        const t = String(s == null ? '' : s)
            .replace(/\s+/g, ' ')
            .trim();
        if (!t || looksLikeHtml(t)) return '';
        return t.length > max ? t.slice(0, max - 1).trimEnd() + '\u2026' : t;
    };

    function headerValue(headers, name) {
        if (!headers) return '';
        if (typeof headers.get === 'function') return headers.get(name) || '';
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
        return key ? String(headers[key] == null ? '' : headers[key]) : '';
    }

    // Retry-After is either a number of seconds or an HTTP date.
    function retryAfterMs(value, now = Date.now()) {
        if (value == null || value === '') return null;
        const text = String(value).trim();
        if (/^\d+(\.\d+)?$/.test(text)) {
            const secs = Number(text);
            return secs >= 0 ? Math.round(secs * 1000) : null;
        }
        const at = Date.parse(text);
        return Number.isFinite(at) ? Math.max(0, at - now) : null;
    }

    function formatWait(ms) {
        const secs = Math.max(1, Math.round((Number(ms) || 0) / 1000));
        return secs < 60 ? secs + 's' : Math.round(secs / 60) + ' min';
    }

    // attempt is the zero-based retry index, so the first wait is one second.
    function backoffMs(attempt, retryAfter, random = Math.random) {
        const hinted = retryAfterMs(retryAfter);
        if (hinted != null) return Math.min(MAX_WAIT_MS, Math.max(0, hinted));
        const base = Math.min(MAX_BACKOFF_MS, BASE_WAIT_MS * 2 ** Math.max(0, attempt));
        return base + Math.floor(random() * 250);
    }

    function isRetryable(error) {
        if (!error) return false;
        if (error.retryable === false) return false;
        if (error.retryable === true) return true;
        return RETRY_STATUS.has(Number(error.status));
    }

    function apiMessage(provider, status, type, detail) {
        const p = provider || 'The provider';
        switch (status) {
            case 401:
                return p + ' rejected the API key. Add a valid key in Settings.';
            case 402:
                return 'The ' + p + ' account is out of credit. Add credit in the provider console, then retry.';
            case 403:
                return p + ' says this API key cannot use the selected model. Choose another model or key in Settings.';
            case 404:
                return p + ' could not find the selected model. Pick a different model in Settings.';
            case 408:
            case 409:
            case 425:
                return p + ' could not finish the request (HTTP ' + status + '). Retry in a moment.';
            case 413:
                return 'This file is too large for ' + p + '. Use a smaller copy or a different provider.';
            case 429:
                return p + ' is rate limiting this account (429). Wait a minute before retrying, or use a different provider.';
            case 500:
                return p + ' had a server error (500). Retry in a moment.';
            case 502:
            case 503:
            case 504:
                return p + ' is temporarily unavailable (HTTP ' + status + '). Retry in a moment.';
            case 529:
                return p + ' is overloaded right now (529). Retry in a minute or switch providers.';
        }
        if (status === 400) {
            const d = (type + ' ' + detail).toLowerCase();
            if (/image (?:exceeds|is too large)|too large.*image|image.*maximum|image size/.test(d))
                return (
                    p +
                    ' could not read this image because it is over the image size limit for that provider. Save a smaller copy and add it again, or use a different provider.'
                );
            if (/pdf.*(?:too large|large|pages?|limit)|too many pages|exceeds.*pages/.test(d))
                return (
                    'This PDF is too large for ' +
                    p +
                    ' to read in one request. Try a smaller copy, split it into parts, or use a different provider.'
                );
            if (/prompt is too long|too many (?:input )?tokens|context (?:length|window)|maximum context/.test(d))
                return (
                    'This file has too much content for ' +
                    p +
                    ' to read in one request. Try a smaller file or a shorter extra instruction.'
                );
            if (/credit|billing|payment|insufficient (?:funds|balance|quota)|quota/.test(d))
                return 'The ' + p + ' account is out of credit or quota. Add credit in the provider console, then retry.';
            if (/model.*(?:not|invalid|unsupported|unknown|does not exist|not found)|unknown model/.test(d))
                return 'The selected ' + p + ' model is not available to this key. Pick another model in Settings.';
            if (/output_config|json_schema|response_format|structured output/i.test(d))
                return (
                    'The selected ' +
                    p +
                    ' model does not support the structured output this app asks for. Pick a different model in Settings.'
                );
            if (/media type|mime|unsupported (?:file|image|type|format)|file type/.test(d))
                return p + ' does not accept this file type. Convert it to a supported format, or use a different provider.';
            if (/password|encrypted/i.test(d))
                return 'This file is password protected, so ' + p + ' cannot read it. Remove the password and add the file again.';
            return (
                p +
                ' rejected the request (400)' +
                (detail ? ': ' + detail : '') +
                '. Retrying will not help until the file or settings change.'
            );
        }
        return p + ' returned an unexpected error' + (status ? ' (HTTP ' + status + ')' : '') + (detail ? ': ' + detail : '.');
    }

    // `body` is the parsed JSON body when there was one; `text` is the raw response.
    function apiError(options) {
        const o = options || {};
        const provider = o.provider || 'The provider';
        const status = Number(o.status) || 0;
        const body = o.body && typeof o.body === 'object' ? o.body : {};
        const info = body.error && typeof body.error === 'object' ? body.error : {};
        const detail = clean(info.message || (typeof body.error === 'string' ? body.error : '') || body.message || o.text || '');
        const type = String(info.type || info.status || body.status || '');
        const error = new Error(apiMessage(provider, status, type, detail));
        error.friendly = true;
        error.status = status;
        error.retryable = RETRY_STATUS.has(status);
        error.retryAfter = headerValue(o.headers, 'retry-after');
        error.requestId = headerValue(o.headers, 'request-id') || headerValue(o.headers, 'x-request-id') || String(body.request_id || '');
        error.provider = provider;
        error.detail = detail;
        return error;
    }

    function cancelled() {
        const error = new Error('Cancelled.');
        error.friendly = true;
        error.cancelled = true;
        error.retryable = false;
        return error;
    }

    // Turns fetch/abort failures into messages. Transient network failures and
    // timeouts stay retryable; a certificate problem and a cancellation do not.
    function transportError(cause, options) {
        const o = options || {};
        const provider = o.provider || 'the provider';
        const label = o.label || 'Request';
        if (o.cancelled) return cancelled();

        const raw = String((cause && cause.message) || cause || '');
        const nested = String((cause && cause.cause && cause.cause.message) || '');
        const text = nested && !raw.includes(nested) ? raw + ': ' + nested : raw;

        let message;
        let retryable = false;
        if (/abort/i.test(raw) && o.timeoutMs) {
            message = label + ' timed out after ' + Math.round(o.timeoutMs / 1000) + ' seconds. Check your connection, then retry.';
            retryable = true;
        } else if (/CERT_|ERR_TLS|SSL|TLS|certificate|self[- ]signed/i.test(text)) {
            message = 'Could not establish a secure connection to ' + provider + '. Check your network or proxy settings.';
        } else if (
            /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_|socket hang up|fetch failed|other side closed|network/i.test(
                text
            )
        ) {
            message = 'Could not reach ' + provider + '. Check your internet connection, then retry.';
            retryable = true;
        } else {
            message = 'Could not complete the request to ' + provider + (text ? ': ' + clean(text) : '.');
        }

        const error = new Error(message);
        error.friendly = true;
        error.retryable = retryable;
        error.provider = provider;
        error.detail = text;
        if (o.timeoutMs) error.timeout = true;
        return error;
    }

    const RETRY_WHAT = {
        429: (p) => p + ' is rate limiting requests.',
        529: (p) => p + ' is overloaded.',
        500: (p) => p + ' had a server error (500).',
        502: (p) => p + ' is temporarily unavailable (502).',
        503: (p) => p + ' is temporarily unavailable (503).',
        504: (p) => p + ' is temporarily unavailable (504).'
    };

    function retryMessage(error, info) {
        const o = info || {};
        const p = (error && error.provider) || 'The provider';
        let what;
        if (error && RETRY_WHAT[Number(error.status)]) what = RETRY_WHAT[Number(error.status)](p);
        else if (error && (error.timeout || /timed out/i.test(error.message || ''))) what = p + ' did not answer in time.';
        else if (error && error.status) what = p + ' returned a temporary error (' + error.status + ').';
        else what = 'Could not reach ' + p + '.';
        return what + ' Retrying in ' + formatWait(o.waitMs) + ' (attempt ' + (o.attempt || 2) + ' of ' + (o.of || MAX_ATTEMPTS) + ').';
    }

    const OUTPUT_MESSAGES = {
        truncated: () =>
            "The model's answer was cut off before it finished, so no name could be read. Retry, and if it keeps happening pick a different model in Settings.",
        blocked: (p) => p + ' declined to describe this file. Check the extra instructions in Settings, or try a different model.',
        empty: (p) => p + ' returned an empty answer, so no name could be read. Retry, or try a different model.',
        invalid: (p) =>
            p + " returned an answer that isn't valid JSON, so no name could be read. Retry; if it keeps happening, try a different model."
    };

    function outputError(options) {
        const o = options || {};
        const reason = OUTPUT_MESSAGES[o.reason] ? o.reason : 'invalid';
        const error = new Error(OUTPUT_MESSAGES[reason](o.provider || 'The model'));
        error.friendly = true;
        error.retryable = false;
        error.output = reason;
        if (o.stopReason) error.stopReason = o.stopReason;
        return error;
    }

    // Provider stop/finish reasons that mean the reply cannot be used.
    const STOP_REASONS = {
        max_tokens: 'truncated',
        length: 'truncated',
        MAX_TOKENS: 'truncated',
        refusal: 'blocked',
        SAFETY: 'blocked',
        RECITATION: 'blocked',
        BLOCKLIST: 'blocked',
        PROHIBITED_CONTENT: 'blocked',
        SPII: 'blocked'
    };
    const outputReason = (stop) => STOP_REASONS[String(stop == null ? '' : stop)] || '';

    // Extracts the JSON object a model replied with, turning every bad reply shape
    // (cut off, empty, not JSON) into a message the user can act on.
    function parseModelJson(text, keys, options) {
        const o = options || {};
        const value = String(text == null ? '' : text);
        const reason = outputReason(o.stopReason);
        if (reason) throw outputError({ provider: o.provider, reason, stopReason: o.stopReason });
        const a = value.indexOf('{'),
            b = value.lastIndexOf('}');
        if (a < 0 || b < a)
            throw outputError({ provider: o.provider, reason: value.trim() ? 'invalid' : 'empty', stopReason: o.stopReason });
        let parsed;
        try {
            parsed = JSON.parse(value.slice(a, b + 1));
        } catch {
            throw outputError({ provider: o.provider, reason: 'invalid', stopReason: o.stopReason });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw outputError({ provider: o.provider, reason: 'invalid', stopReason: o.stopReason });
        const out = {};
        for (const k of keys || []) out[k] = String(parsed[k] || '');
        return out;
    }

    const mb = (n) => {
        const v = Math.round(((Number(n) || 0) / (1024 * 1024)) * 10) / 10;
        return (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) + ' MB';
    };

    function limitError(options) {
        const o = options || {};
        const p = o.provider || 'The provider';
        const message =
            o.kind === 'image'
                ? 'This image is ' +
                  mb(o.bytes) +
                  ', over ' +
                  p +
                  "'s " +
                  mb(o.limit) +
                  ' image limit. Save a smaller copy and add it again, or use a different provider.'
                : 'This file is ' +
                  mb(o.bytes) +
                  '. ' +
                  p +
                  ' rejects requests larger than ' +
                  mb(o.limit) +
                  ', and files grow about a third when sent. Compress or split it, or use a different provider.';
        const error = new Error(message);
        error.friendly = true;
        error.retryable = false;
        error.limit = true;
        error.provider = p;
        return error;
    }

    // Provider limits from the registry, checked before sending. Requests grow about a
    // third once base64 encoded, so that is what counts against the request limit.
    // PDFs sent as page images only pay for those pages, not the original file.
    function preflight(p, req) {
        const limits = (p && p.limits) || {};
        const encoded = (n) => Math.ceil(Number(n || 0) / 3) * 4;
        if (req.kind === 'image' && limits.imageBytes && req.bytes && req.bytes.length > limits.imageBytes)
            throw limitError({ provider: p.name, kind: 'image', bytes: req.bytes.length, limit: limits.imageBytes });
        if (!limits.requestBytes) return;
        const parts = [];
        if (req.kind === 'document') {
            if (req.pages && req.pages.length) parts.push(...req.pages);
            else if (req.bytes) parts.push(req.bytes);
        } else if (req.kind === 'image' && req.bytes) parts.push(req.bytes);
        for (const part of parts) {
            if (part && encoded(part.length) + 8192 > limits.requestBytes)
                throw limitError({ provider: p.name, kind: 'request', bytes: part.length, limit: limits.requestBytes });
        }
    }

    // Filesystem failures carry an errno code that is meaningless in the UI.
    function fsError(cause, options) {
        const o = options || {};
        const code = String((cause && cause.code) || '');
        const name = o.name ? '"' + String(o.name) + '"' : 'this item';
        const action = o.action || 'use';
        let message;
        switch (code) {
            case 'EACCES':
            case 'EPERM':
                message = 'macOS did not allow the app to ' + action + ' ' + name + ". Check the folder's permissions, then try again.";
                break;
            case 'ENOENT':
                message = 'That file is no longer there. It may have been moved or deleted.';
                break;
            case 'EEXIST':
                message = 'Another file already uses the name ' + name + '.';
                break;
            case 'ENAMETOOLONG':
                message = 'The name ' + name + ' is too long for this folder. Shorten it and try again.';
                break;
            case 'EROFS':
                message = 'That folder is read-only, so the app cannot ' + action + ' ' + name + '.';
                break;
            case 'EBUSY':
            case 'ETXTBSY':
                message = 'Another app is using ' + name + '. Close it, then try again.';
                break;
            default:
                message = 'Could not ' + action + ' ' + name + (cause && cause.message ? ': ' + clean(cause.message) : '.');
        }
        const error = new Error(message);
        error.friendly = true;
        if (code) error.code = code;
        return error;
    }

    // Records how many times the request was tried so the final message is honest.
    function finalize(error, attempts) {
        const n = Math.max(1, Number(attempts) || 1);
        if (!error || n < 2 || error.tried) return error;
        error.tried = n;
        error.message = String(error.message || '').replace(/\s+$/, '') + ' Tried ' + n + ' times.';
        return error;
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            const done = () => {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve();
            };
            const onAbort = () => {
                clearTimeout(timer);
                reject(cancelled());
            };
            const timer = setTimeout(done, ms);
            if (signal) {
                if (signal.aborted) {
                    clearTimeout(timer);
                    reject(cancelled());
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    async function attempt(fn, options) {
        const o = options || {};
        const retries = Number(o.retries) > 0 ? Number(o.retries) : MAX_ATTEMPTS;
        for (let i = 0; ; i++) {
            try {
                return await fn();
            } catch (error) {
                const tries = i + 1;
                if (tries >= retries || !isRetryable(error) || (o.signal && o.signal.aborted)) throw finalize(error, tries);
                const waitMs = backoffMs(i, error.retryAfter);
                if (typeof o.onRetry === 'function') o.onRetry({ attempt: tries + 1, of: retries, waitMs, error });
                try {
                    await sleep(waitMs, o.signal);
                } catch (stop) {
                    throw stop && stop.cancelled ? stop : finalize(stop, tries);
                }
            }
        }
    }

    return {
        MAX_ATTEMPTS,
        RETRY_STATUS,
        isRetryable,
        retryAfterMs,
        backoffMs,
        formatWait,
        apiError,
        cancelled,
        transportError,
        retryMessage,
        outputError,
        outputReason,
        parseModelJson,
        limitError,
        preflight,
        fsError,
        finalize,
        attempt
    };
});
