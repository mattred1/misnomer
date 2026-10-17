const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { extractText, xmlToText, rtfToText, decodeEntities, OK_EXT, MAX_TEXT } = require('../renderer/extract.js');

const buf = (s) => new TextEncoder().encode(s).buffer;
const zipOf = async (entries) => {
    const z = new JSZip();
    for (const [name, content] of Object.entries(entries)) z.file(name, content);
    return z.generateAsync({ type: 'arraybuffer' });
};

test('decodeEntities: resolves named and numeric entities', () => {
    assert.equal(decodeEntities('a &amp; b'), 'a & b');
    assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
    assert.equal(decodeEntities('caf&#233;'), 'café');
    assert.equal(decodeEntities('caf&#xe9;'), 'café');
    // Unknown entities are left alone rather than mangled.
    assert.equal(decodeEntities('&notreal;'), '&notreal;');
});

test('xmlToText: strips tags and keeps block boundaries as newlines', () => {
    const xml = '<w:p><w:r><w:t>Invoice for March</w:t></w:r></w:p><w:p><w:r><w:t>Acme Corp</w:t></w:r></w:p>';
    assert.equal(xmlToText(xml), 'Invoice for March\nAcme Corp');
});

test('xmlToText: collapses runs of blank lines and stray whitespace', () => {
    assert.equal(xmlToText('<p>a</p><br/><br/><br/><p>b</p>'), 'a\n\nb');
    assert.equal(xmlToText('<p>  spaced   out  </p>'), 'spaced out');
});

test('xmlToText: returns an empty string for empty input', () => {
    assert.equal(xmlToText(''), '');
    assert.equal(xmlToText('<p></p>'), '');
});

test('rtfToText: strips control words and unescapes hex escapes', () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Invoice for March\\par Acme Corp}';
    const text = rtfToText(rtf);
    assert.match(text, /Invoice for March/);
    assert.match(text, /Acme Corp/);
    assert.ok(text.includes('\n'), '\\par should become a newline');
    assert.equal(rtfToText("{\\rtf1 caf\\'e9}"), 'café');
});

test('extractText: returns plain text files unchanged', async () => {
    assert.equal(await extractText('txt', buf('Meeting notes for Monday')), 'Meeting notes for Monday');
    assert.equal(await extractText('md', buf('# Heading\n\nBody text')), '# Heading\n\nBody text');
});

test('extractText: strips markup from html', async () => {
    assert.equal(await extractText('html', buf('<html><head><style>p{}</style></head><body><h1>March Report</h1><p>Revenue up</p></body></html>')), 'March Report\nRevenue up');
});

test('extractText: reads a docx through jszip', async () => {
    const docx = await zipOf({
        'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Invoice 2026-03</w:t></w:r></w:p><w:p><w:r><w:t>Acme Corp</w:t></w:r></w:p></w:body></w:document>'
    });
    const text = await extractText('docx', docx);
    assert.match(text, /Invoice 2026-03/);
    assert.match(text, /Acme Corp/);
    assert.ok(text.includes('\n'));
});

test('extractText: reads xlsx shared strings and sheet data', async () => {
    const xlsx = await zipOf({
        'xl/sharedStrings.xml': '<sst><si><t>Total Due</t></si><si><t>Acme Corp</t></si></sst>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c><v>1420</v></c></row></sheetData></worksheet>'
    });
    const text = await extractText('xlsx', xlsx);
    assert.match(text, /Total Due/);
    assert.match(text, /1420/);
});

test('extractText: orders pptx slides numerically, not lexicographically', async () => {
    const pptx = await zipOf({
        'ppt/slides/slide10.xml': '<p:sld><a:t>tenth slide</a:t></p:sld>',
        'ppt/slides/slide2.xml': '<p:sld><a:t>second slide</a:t></p:sld>'
    });
    const text = await extractText('pptx', pptx);
    assert.ok(text.indexOf('second slide') < text.indexOf('tenth slide'), 'slide2 should come before slide10');
});

test('extractText: reads odt content and epub pages', async () => {
    const odt = await zipOf({ 'content.xml': '<office:body><text:p>Quarterly Review</text:p></office:body>' });
    assert.match(await extractText('odt', odt), /Quarterly Review/);

    const epub = await zipOf({ 'OEBPS/ch1.xhtml': '<html><body><p>The Hobbit</p></body></html>' });
    assert.match(await extractText('epub', epub), /The Hobbit/);
});

test('extractText: returns an empty string when the expected part is missing', async () => {
    const docx = await zipOf({ 'word/styles.xml': '<w:styles/>' });
    assert.equal(await extractText('docx', docx), '');
});

test('extractText: caps output at MAX_TEXT', async () => {
    const long = await extractText('txt', buf('x'.repeat(MAX_TEXT + 5000)));
    assert.equal(long.length, MAX_TEXT);
});

test('extractText: strips NUL bytes and trims', async () => {
    assert.equal(await extractText('txt', buf('  a\u0000b  ')), 'ab');
});

test('OK_EXT: covers the advertised text and Office formats', () => {
    for (const ext of ['txt', 'md', 'csv', 'json', 'rtf', 'docx', 'xlsx', 'pptx', 'odt', 'epub']) {
        assert.ok(OK_EXT.includes(ext), ext + ' should be extractable');
    }
    // Images must not be routed through text extraction.
    for (const ext of ['png', 'jpg', 'pdf', 'svg']) {
        assert.equal(OK_EXT.includes(ext), false, ext + ' should not be in OK_EXT');
    }
});
