const test = require('node:test');
const assert = require('node:assert/strict');
const { entryName, plan } = require('../renderer/zip.js');

test('entryName: keeps a plain filename unchanged', () => {
    assert.equal(entryName('invoice-acme.pdf'), 'invoice-acme.pdf');
    assert.equal(entryName('résumé-2026.docx'), 'résumé-2026.docx');
});

test('entryName: strips path components so entries stay flat', () => {
    assert.equal(entryName('/Users/m/receipts/invoice.pdf'), 'invoice.pdf');
    assert.equal(entryName('..\\..\\windows\\system32\\evil.pdf'), 'evil.pdf');
    assert.equal(entryName('../../etc/passwd'), 'passwd');
});

test('entryName: removes control and reserved characters', () => {
    assert.equal(entryName('a\u0000b\u001fc.pdf'), 'abc.pdf');
    assert.equal(entryName('a<b>c:d"e|f?g*h.pdf'), 'a_b_c_d_e_f_g_h.pdf');
});

test('entryName: trims leading dots and trailing dots or spaces', () => {
    assert.equal(entryName('.hidden.pdf'), 'hidden.pdf');
    assert.equal(entryName('report...'), 'report');
    assert.equal(entryName('report . . '), 'report');
});

test('entryName: falls back for empty or dot-only names', () => {
    assert.equal(entryName(''), 'unnamed');
    assert.equal(entryName('..'), 'unnamed');
    assert.equal(entryName('///'), 'unnamed');
});

test('entryName: caps very long names without leaving a trailing dot', () => {
    const long = 'a'.repeat(240) + '.pdf';
    const name = entryName(long);
    assert.equal(name.length, 180);
    assert.ok(!name.endsWith('.'));
});

test('plan: resolves duplicate names before the extension', () => {
    const entries = plan([
        { path: '/a/report.pdf', name: 'report.pdf' },
        { path: '/b/report.pdf', name: 'report.pdf' },
        { path: '/c/report.pdf', name: 'REPORT.pdf' }
    ]);
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ['report.pdf', 'report (2).pdf', 'REPORT (3).pdf']
    );
});

test('plan: a suffixed name that is already taken still resolves', () => {
    const entries = plan([
        { path: '/a/report.pdf', name: 'report.pdf' },
        { path: '/b/report.pdf', name: 'report (2).pdf' },
        { path: '/c/report.pdf', name: 'report.pdf' }
    ]);
    assert.deepEqual(
        entries.map((entry) => entry.name),
        ['report.pdf', 'report (2).pdf', 'report (3).pdf']
    );
});

test('plan: drops entries without a path', () => {
    const entries = plan([
        { path: '', name: 'a.pdf' },
        { path: '/b/b.pdf', name: 'b.pdf' }
    ]);
    assert.deepEqual(entries, [{ path: '/b/b.pdf', name: 'b.pdf' }]);
});
