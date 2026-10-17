const test = require('node:test');
const assert = require('node:assert/strict');
const { slug, build, clean, extOf, names, placeholders, isReserved, MAX_BASE, MAX_SLUG } = require('../renderer/naming.js');

test('slug: lowercases, strips accents, and joins words with the separator', () => {
    assert.equal(slug('March Service Call!', '-'), 'march-service-call');
    assert.equal(slug('Café Déjà Vu', '-'), 'cafe-deja-vu');
    assert.equal(slug('Acme  Corp', '_'), 'acme_corp');
});

test('slug: trims leading and trailing separators and collapses runs', () => {
    assert.equal(slug('  --Hello--World--  ', '-'), 'hello-world');
    assert.equal(slug('!!!a!!!b!!!', '-'), 'a-b');
});

test('slug: an empty separator runs the words together', () => {
    assert.equal(slug('Hello World', ''), 'helloworld');
    assert.equal(slug('a b c', ''), 'abc');
});

test('slug: caps length at MAX_SLUG', () => {
    assert.equal(slug('x'.repeat(200), '-').length, MAX_SLUG);
});

test('slug: returns an empty string when nothing usable remains', () => {
    assert.equal(slug('', '-'), '');
    assert.equal(slug('!!!', '-'), '');
    assert.equal(slug(null, '-'), '');
});

test('build: fills every placeholder from the model result', () => {
    const info = { date: '2026-03-01', entity: 'Acme', type: 'invoice', title: 'march service call' };
    assert.equal(build(info, '{date}-{entity}-{type}-{title}', '-'), '2026-03-01-acme-invoice-march-service-call');
    assert.equal(build(info, '{type}_{entity}', '_'), 'invoice_acme');
});

test('build: missing or empty values collapse without leaving stray separators', () => {
    assert.equal(build({ title: 'march service call' }, '{date}-{entity}-{type}-{title}', '-'), 'march-service-call');
    assert.equal(build({ date: '', entity: 'Acme', type: '', title: '' }, '{date}-{entity}', '-'), 'acme');
});

test('build: falls back to "unnamed" when nothing survives slugging', () => {
    assert.equal(build({}, '{title}', '-'), 'unnamed');
    assert.equal(build({}, '{date}-{entity}-{type}-{title}', '-'), 'unnamed');
    assert.equal(build({ title: '!!!' }, '{title}', '-'), 'unnamed');
});

test('build: fills user-defined fields alongside the built-in ones', () => {
    const info = { date: '2026-03-01', entity: 'Acme', amount: '1420.00 usd', title: 'march service call' };
    assert.equal(build(info, '{date}-{entity}-{amount}', '-'), '2026-03-01-acme-1420-00-usd');
});

test('build: an unknown placeholder fills empty rather than leaking its own name', () => {
    assert.equal(build({ title: 'march service call' }, '{title}-{nope}', '-'), 'march-service-call');
});

test('placeholders: lists distinct names in order of first appearance', () => {
    assert.deepEqual(placeholders('{date}-{title}-{date}'), ['date', 'title']);
    assert.deepEqual(placeholders('{amount}_{category}'), ['amount', 'category']);
    assert.deepEqual(placeholders('no placeholders here'), []);
    assert.deepEqual(placeholders(''), []);
});

test('clean: replaces characters that are illegal on Windows', () => {
    assert.equal(clean('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
    assert.equal(clean('a///b'), 'a-b');
});

test('clean: normalizes whitespace and trims', () => {
    assert.equal(clean('   spaced   out   '), 'spaced out');
    assert.equal(clean('\ta\tb\n'), 'a b');
});

test('clean: strips control characters', () => {
    assert.equal(clean('a\u0000b\u001fc\u007f'), 'abc');
});

test('clean: falls back to "unnamed" for empty input', () => {
    assert.equal(clean(''), 'unnamed');
    assert.equal(clean('   '), 'unnamed');
    assert.equal(clean('...'), 'unnamed');
    assert.equal(clean(null), 'unnamed');
    assert.equal(clean(undefined), 'unnamed');
});

test('clean: removes trailing dots and spaces, which Windows rejects', () => {
    assert.equal(clean('report.'), 'report');
    assert.equal(clean('report . '), 'report');
});

test('clean: prefixes Windows reserved device names', () => {
    for (const name of ['con', 'PRN', 'aux', 'NUL', 'com1', 'COM9', 'lpt1', 'LPT9']) {
        assert.equal(clean(name), '_' + name, name + ' should be prefixed');
    }
    // Reserved names stay reserved when they carry an extension.
    assert.equal(clean('con.txt'), '_con.txt');
});

test('clean: leaves lookalike names alone', () => {
    assert.equal(clean('console'), 'console');
    assert.equal(clean('com10'), 'com10');
    assert.equal(clean('null'), 'null');
    assert.equal(clean('my-con'), 'my-con');
});

test('isReserved: is case-insensitive and ignores extensions', () => {
    assert.ok(isReserved('CON'));
    assert.ok(isReserved('con.pdf'));
    assert.equal(isReserved('console'), false);
});

test('clean: caps the base name length', () => {
    assert.equal(clean('x'.repeat(500)).length, MAX_BASE);
    // The truncation must not leave a trailing dot or space behind.
    assert.equal(clean('x'.repeat(MAX_BASE - 1) + '. '), 'x'.repeat(MAX_BASE - 1));
});

test('extOf: lowercases and handles missing extensions', () => {
    assert.equal(extOf('a.PDF'), 'pdf');
    assert.equal(extOf('archive.tar.gz'), 'gz');
    assert.equal(extOf('noext'), 'noext');
});

test('names: appends a suffix when two rows collide', () => {
    assert.deepEqual(
        names([{ name: 'invoice', ext: 'pdf' }, { name: 'invoice', ext: 'pdf' }]),
        ['invoice.pdf', 'invoice-2.pdf']
    );
    assert.deepEqual(
        names([{ name: 'invoice', ext: 'pdf' }, { name: 'invoice', ext: 'pdf' }, { name: 'invoice', ext: 'pdf' }]),
        ['invoice.pdf', 'invoice-2.pdf', 'invoice-3.pdf']
    );
});

test('names: collision detection is case-insensitive', () => {
    assert.deepEqual(
        names([{ name: 'Invoice', ext: 'pdf' }, { name: 'invoice', ext: 'PDF' }]),
        ['Invoice.pdf', 'invoice-2.PDF']
    );
});

test('names: a name that already looks suffixed still resolves', () => {
    assert.deepEqual(
        names([{ name: 'x', ext: 'pdf' }, { name: 'x-2', ext: 'pdf' }, { name: 'x', ext: 'pdf' }]),
        ['x.pdf', 'x-2.pdf', 'x-3.pdf']
    );
});

test('names: different extensions do not collide', () => {
    assert.deepEqual(
        names([{ name: 'photo', ext: 'jpg' }, { name: 'photo', ext: 'png' }]),
        ['photo.jpg', 'photo.png']
    );
});

test('names: applies clean() to every row', () => {
    assert.deepEqual(names([{ name: 'a/b:c', ext: 'pdf' }]), ['a-b-c.pdf']);
});

test('names: handles an empty batch', () => {
    assert.deepEqual(names([]), []);
    assert.deepEqual(names(undefined), []);
});
