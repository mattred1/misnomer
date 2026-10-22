const test = require('node:test');
const assert = require('node:assert/strict');
const Errors = require('../renderer/errors.js');
const { providerById } = require('../renderer/providers.js');

test('isRetryable: only transient statuses are retried', () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 529]) assert.equal(Errors.isRetryable({ status }), true, String(status));
    for (const status of [400, 401, 402, 403, 404, 413]) assert.equal(Errors.isRetryable({ status }), false, String(status));
    // A mapper can override the status-based decision in either direction.
    assert.equal(Errors.isRetryable({ status: 429, retryable: false }), false);
    assert.equal(Errors.isRetryable({ retryable: true }), true);
});

test('retryAfterMs: accepts seconds and HTTP dates', () => {
    assert.equal(Errors.retryAfterMs('8'), 8000);
    assert.equal(Errors.retryAfterMs('0.5'), 500);
    assert.equal(Errors.retryAfterMs('not a date'), null);
    assert.equal(Errors.retryAfterMs(''), null);
    assert.equal(Errors.retryAfterMs(null), null);
    const now = Date.parse('2026-03-01T00:00:00Z');
    assert.equal(Errors.retryAfterMs('Sun, 01 Mar 2026 00:00:05 GMT', now), 5000);
    // Dates in the past do not produce a negative wait.
    assert.equal(Errors.retryAfterMs('Sun, 01 Mar 2026 00:00:00 GMT', now + 10000), 0);
});

test('backoffMs: honors Retry-After, then backs off exponentially within limits', () => {
    assert.equal(Errors.backoffMs(0, '12'), 12000);
    // A long Retry-After is capped so a batch cannot sit idle indefinitely.
    assert.equal(Errors.backoffMs(0, '600'), 30000);
    // No header: 1s, 2s, 4s with the injected jitter.
    assert.equal(
        Errors.backoffMs(0, undefined, () => 0),
        1000
    );
    assert.equal(
        Errors.backoffMs(1, undefined, () => 0),
        2000
    );
    assert.equal(
        Errors.backoffMs(2, undefined, () => 0),
        4000
    );
    assert.equal(
        Errors.backoffMs(10, undefined, () => 0),
        20000
    );
    assert.ok(Errors.backoffMs(0, undefined, () => 0.999) < 1250);
});

test('formatWait: keeps short waits in seconds', () => {
    assert.equal(Errors.formatWait(800), '1s');
    assert.equal(Errors.formatWait(12000), '12s');
    assert.equal(Errors.formatWait(60000), '1 min');
});

test('apiError: authentication failures point at Settings', () => {
    const e = Errors.apiError({
        provider: 'Anthropic',
        status: 401,
        body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
    });
    assert.match(e.message, /Anthropic rejected the API key/);
    assert.match(e.message, /Settings/);
    assert.equal(e.status, 401);
    assert.equal(e.retryable, false);
});

test('apiError: rate limits keep the status, Retry-After, and request id', () => {
    const e = Errors.apiError({
        provider: 'Anthropic',
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your per-minute rate limit' } },
        headers: { 'retry-after': '14', 'request-id': 'req_123' }
    });
    assert.match(e.message, /Anthropic is rate limiting this account/);
    assert.equal(e.status, 429);
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfter, '14');
    assert.equal(e.requestId, 'req_123');
});

test('apiError: oversized requests are explained without the raw API path', () => {
    const e = Errors.apiError({
        provider: 'Anthropic',
        status: 413,
        body: { error: { type: 'request_too_large', message: 'Request exceeds 32MB' } }
    });
    assert.match(e.message, /too large for Anthropic/);
    assert.doesNotMatch(e.message, /32MB/);
});

test('apiError: 400 detail is mapped to a concrete next step', () => {
    const image = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: {
            error: {
                type: 'invalid_request_error',
                message: 'messages.0.content.0.image.source.base64.data: image exceeds 5 MB maximum: 12582912 bytes > 5242880 bytes'
            }
        }
    });
    assert.match(image.message, /image size limit/);
    assert.doesNotMatch(image.message, /messages\.0\.content/);

    const model = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'model: claude-nope is not a valid model ID' } }
    });
    assert.match(model.message, /not available/);
    assert.match(model.message, /Settings/);

    const other = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'something unexpected' } }
    });
    assert.match(other.message, /something unexpected/);
    assert.match(other.message, /Retrying will not help/);

    const pdf = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'PDF page count exceeds 100 pages' } }
    });
    assert.match(pdf.message, /PDF is too large/);

    const schema = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } }
    });
    assert.match(schema.message, /structured output/);

    const locked = Errors.apiError({
        provider: 'Anthropic',
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'The PDF is password protected' } }
    });
    assert.match(locked.message, /password protected/);
});

test('apiError: HTML error pages never leak into the message', () => {
    const e = Errors.apiError({
        provider: 'Anthropic',
        status: 502,
        text: '<!doctype html><html><body><h1>502 Bad Gateway</h1></body></html>'
    });
    assert.match(e.message, /temporarily unavailable/);
    assert.doesNotMatch(e.message, /</);
    assert.doesNotMatch(e.message, /doctype/);
});

test('apiError: unknown statuses still explain the HTTP status', () => {
    const e = Errors.apiError({ provider: 'Anthropic', status: 418, text: 'teapot' });
    assert.match(e.message, /HTTP 418/);
    assert.match(e.message, /teapot/);
});

test('transportError: network failures are retryable and actionable', () => {
    const e = Errors.transportError(new Error('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.anthropic.com') }), {
        provider: 'Anthropic'
    });
    assert.match(e.message, /Could not reach Anthropic/);
    assert.match(e.message, /internet connection/);
    assert.equal(e.retryable, true);
});

test('transportError: timeouts and cancellation are different failures', () => {
    const timeout = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const timed = Errors.transportError(timeout, { provider: 'Anthropic', label: 'API request', timeoutMs: 120000 });
    assert.match(timed.message, /timed out after 120 seconds/);
    assert.equal(timed.retryable, true);
    assert.equal(timed.timeout, true);

    const stop = Errors.transportError(timeout, { provider: 'Anthropic', cancelled: true });
    assert.equal(stop.message, 'Cancelled.');
    assert.equal(stop.cancelled, true);
    assert.equal(stop.retryable, false);
});

test('transportError: certificate problems are not retried', () => {
    const e = Errors.transportError(new Error('unable to verify the first certificate'), { provider: 'Anthropic' });
    assert.match(e.message, /secure connection/);
    assert.equal(e.retryable, false);
});

test('transportError: unexpected internal failures are not retried', () => {
    const e = Errors.transportError(new TypeError('The first argument must be of type string'), { provider: 'Anthropic' });
    assert.match(e.message, /Could not complete the request to Anthropic/);
    assert.equal(e.retryable, false);
});

test('retryMessage: describes the wait and the attempt number', () => {
    const e = Errors.apiError({ provider: 'Anthropic', status: 429, body: { error: { message: 'slow down' } } });
    assert.equal(
        Errors.retryMessage(e, { attempt: 2, of: 4, waitMs: 8000 }),
        'Anthropic is rate limiting requests. Retrying in 8s (attempt 2 of 4).'
    );
    const offline = Errors.transportError(new Error('fetch failed'), { provider: 'Anthropic' });
    assert.match(Errors.retryMessage(offline, { attempt: 2, of: 4, waitMs: 1000 }), /^Could not reach Anthropic\. Retrying in 1s/);
});

test('outputReason: maps provider stop/finish reasons', () => {
    assert.equal(Errors.outputReason('max_tokens'), 'truncated');
    assert.equal(Errors.outputReason('length'), 'truncated');
    assert.equal(Errors.outputReason('MAX_TOKENS'), 'truncated');
    assert.equal(Errors.outputReason('refusal'), 'blocked');
    assert.equal(Errors.outputReason('SAFETY'), 'blocked');
    assert.equal(Errors.outputReason('end_turn'), '');
    assert.equal(Errors.outputReason(undefined), '');
});

test('outputError: bad model replies are not retried automatically', () => {
    const truncated = Errors.outputError({ provider: 'Anthropic', reason: 'truncated', stopReason: 'max_tokens' });
    assert.match(truncated.message, /cut off/);
    assert.equal(truncated.retryable, false);
    assert.equal(truncated.stopReason, 'max_tokens');

    const blocked = Errors.outputError({ provider: 'Anthropic', reason: 'blocked' });
    assert.match(blocked.message, /declined to describe/);

    const empty = Errors.outputError({ provider: 'Anthropic', reason: 'empty' });
    assert.match(empty.message, /empty answer/);

    const invalid = Errors.outputError({ provider: 'Anthropic', reason: 'invalid' });
    assert.match(invalid.message, /isn't valid JSON/);
});

test('limitError: names the file size, the provider limit, and the way out', () => {
    const image = Errors.limitError({ provider: 'Anthropic', kind: 'image', bytes: 12 * 1024 * 1024, limit: 5 * 1024 * 1024 });
    assert.match(image.message, /12 MB/);
    assert.match(image.message, /5 MB image limit/);
    assert.match(image.message, /smaller copy/);
    assert.equal(image.retryable, false);

    const request = Errors.limitError({ provider: 'Anthropic', kind: 'request', bytes: 30 * 1024 * 1024, limit: 32 * 1024 * 1024 });
    assert.match(request.message, /30 MB/);
    assert.match(request.message, /32 MB/);
});

test('preflight: rejects an oversized image for Anthropic', () => {
    const anthropic = providerById('anthropic');
    assert.throws(
        () => Errors.preflight(anthropic, { kind: 'image', bytes: { length: 6 * 1024 * 1024 } }),
        /6 MB, over Anthropic's 5 MB image limit/
    );
    assert.doesNotThrow(() => Errors.preflight(anthropic, { kind: 'image', bytes: { length: 4 * 1024 * 1024 } }));
});

test('preflight: accounts for base64 growth on a native PDF', () => {
    const anthropic = providerById('anthropic');
    // 30 MB raw becomes 40 MB once encoded, over the 32 MB request limit.
    assert.throws(
        () => Errors.preflight(anthropic, { kind: 'document', bytes: { length: 30 * 1024 * 1024 } }),
        /rejects requests larger than 32 MB/
    );
    assert.doesNotThrow(() => Errors.preflight(anthropic, { kind: 'document', bytes: { length: 20 * 1024 * 1024 } }));
});

test('preflight: page images are measured instead of the original PDF', () => {
    const anthropic = providerById('anthropic');
    assert.doesNotThrow(() =>
        Errors.preflight(anthropic, {
            kind: 'document',
            bytes: { length: 40 * 1024 * 1024 },
            pages: [{ length: 200 * 1024 }, { length: 200 * 1024 }]
        })
    );
});

test('preflight: providers without documented limits are not blocked', () => {
    assert.doesNotThrow(() => Errors.preflight(providerById('xai'), { kind: 'image', bytes: { length: 200 * 1024 * 1024 } }));
});

test('fsError: maps errno codes to plain language', () => {
    assert.match(
        Errors.fsError({ code: 'EACCES', message: 'EACCES: permission denied, rename ...' }, { name: 'a.pdf', action: 'rename' }).message,
        /did not allow the app to rename "a\.pdf"/
    );
    assert.match(Errors.fsError({ code: 'ENOENT' }, { name: 'a.pdf' }).message, /no longer there/);
    assert.match(Errors.fsError({ code: 'EEXIST' }, { name: 'a.pdf' }).message, /already uses the name/);
    assert.match(Errors.fsError({ code: 'ENAMETOOLONG' }, { name: 'a.pdf' }).message, /too long/);
    assert.match(Errors.fsError({ code: 'EROFS' }, { name: 'a.pdf', action: 'rename' }).message, /read-only/);
    assert.match(Errors.fsError({ code: 'EBUSY' }, { name: 'a.pdf' }).message, /Another app is using/);
    // Unknown codes keep the useful part of the original message.
    assert.match(Errors.fsError(new Error('weird failure'), { name: 'a.pdf', action: 'read' }).message, /Could not read "a\.pdf": weird/);
});

test('parseModelJson: extracts the object from a normal reply', () => {
    const info = Errors.parseModelJson('Here you go:\n{"title":"March invoice","entity":"Acme","date":"","type":"invoice"}\n', [
        'title',
        'entity',
        'date',
        'type'
    ]);
    assert.deepEqual(info, { title: 'March invoice', entity: 'Acme', date: '', type: 'invoice' });
});

test('parseModelJson: every unusable reply gets a concrete explanation', () => {
    assert.throws(() => Errors.parseModelJson('', ['title']), /empty answer/);
    assert.throws(() => Errors.parseModelJson('{"title": "cut off', ['title']), /isn't valid JSON/);
    assert.throws(() => Errors.parseModelJson('[1,2,3]', ['title']), /isn't valid JSON/);
    assert.throws(
        () => Errors.parseModelJson('{"title":"x"}', ['title'], { stopReason: 'max_tokens', provider: 'Anthropic' }),
        /cut off before it finished/
    );
    assert.throws(
        () => Errors.parseModelJson('{"title":"x"}', ['title'], { stopReason: 'refusal', provider: 'Anthropic' }),
        /declined to describe/
    );
});

test('parseModelJson: missing fields become empty strings', () => {
    assert.deepEqual(Errors.parseModelJson('{"title":"Receipt"}', ['title', 'entity']), { title: 'Receipt', entity: '' });
});

test('finalize: mentions the attempt count once', () => {
    const e = new Error('Rate limited.');
    assert.equal(Errors.finalize(e, 1).message, 'Rate limited.');
    const final = Errors.finalize(e, 4);
    assert.equal(final.message, 'Rate limited. Tried 4 times.');
    // Calling it again must not stack another sentence.
    assert.equal(Errors.finalize(final, 4).message, 'Rate limited. Tried 4 times.');
});

test('attempt: retries a transient failure, then returns the result', async () => {
    const seen = [];
    let calls = 0;
    const result = await Errors.attempt(
        () => {
            calls++;
            if (calls < 3) throw Errors.apiError({ provider: 'Anthropic', status: 503, headers: { 'retry-after': '0' } });
            return 'ok';
        },
        { onRetry: (info) => seen.push(info.attempt) }
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(seen, [2, 3]);
});

test('attempt: stops on a non-retryable failure without waiting', async () => {
    let calls = 0;
    await assert.rejects(
        Errors.attempt(() => {
            calls++;
            throw Errors.apiError({ provider: 'Anthropic', status: 401, body: { error: { message: 'bad key' } } });
        }),
        /rejected the API key/
    );
    assert.equal(calls, 1);
});

test('attempt: final failure reports how many attempts were made', async () => {
    let calls = 0;
    await assert.rejects(
        Errors.attempt(
            () => {
                calls++;
                throw Errors.apiError({ provider: 'Anthropic', status: 529, headers: { 'retry-after': '0' } });
            },
            { retries: 3 }
        ),
        /overloaded right now \(529\).* Tried 3 times\./
    );
    assert.equal(calls, 3);
});

test('attempt: an already-cancelled signal does not make another request', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    await assert.rejects(
        Errors.attempt(
            () => {
                calls++;
                throw Errors.apiError({ provider: 'Anthropic', status: 429, headers: { 'retry-after': '0' } });
            },
            { signal: ctl.signal }
        ),
        /rate limiting/
    );
    assert.equal(calls, 1);
});
