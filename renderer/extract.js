// Pulls readable text out of non-image files so the model can name them.
// UMD for the same reason as naming.js: window.Extract in the renderer, require() in tests.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('jszip'));
    else root.Extract = factory(root.JSZip);
})(typeof self !== 'undefined' ? self : this, function (JSZip) {
    'use strict';

    // Prompts get expensive fast, so caps this well below anything a model needs.
    const MAX_TEXT = 12000;

    // Read straight through as UTF-8.
    const TEXT_EXT = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'srt', 'vtt'];
    // Read as markup and reduced to plain text.
    const MARKUP_EXT = ['html', 'htm', 'xml'];
    // Handled by a dedicated converter.
    const SPECIAL_EXT = ['rtf'];
    // ZIP containers with the content sitting in XML parts.
    const ZIP_EXT = ['docx', 'xlsx', 'pptx', 'odt', 'epub'];

    const OK_EXT = [...TEXT_EXT, ...MARKUP_EXT, ...SPECIAL_EXT, ...ZIP_EXT];

    // Elements whose *contents* are not prose and must not leak into the text.
    // HTML style blocks, scripts, and document heads are noise for naming purposes.
    const NOISE = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
    // Self-closing break elements each stand in for a line break.
    const VOID_TAG = /<(?:w:br|w:tab|a:br|a:tab|text:line-break|br)\b[^>]*\/?>/gi;
    // Only *closing* block tags become newlines. Treating the opening tag as one too
    // would double every paragraph break.
    const CLOSE_TAG = /<\/(?:w:p|w:tr|a:p|text:p|text:h|si|row|p|div|li|tr|h[1-6]|section)\s*>/gi;

    const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '\u00a9', reg: '\u00ae' };

    function decodeEntities(s) {
        return String(s).replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
            if (e[0] === '#') {
                const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(n) ? String.fromCodePoint(n) : m;
            }
            const hit = ENTITIES[e.toLowerCase()];
            return hit === undefined ? m : hit;
        });
    }

    // Reduce markup to readable plain text, keeping block boundaries as newlines.
    function xmlToText(xml) {
        return decodeEntities(
            String(xml)
                .replace(NOISE, ' ')
                .replace(VOID_TAG, '\n')
                .replace(CLOSE_TAG, '\n')
                .replace(/<[^>]*>/g, ' ')
        )
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // RTF is a brace-delimited control-word format, so strip the control words and unescape.
    function rtfToText(rtf) {
        return String(rtf)
            .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\u(-?\d+)\s?\??/g, (_, d) => String.fromCharCode(((Number(d) % 65536) + 65536) % 65536))
            .replace(/\{\\\*[^{}]*\}/g, '') // ignorable destination groups
            .replace(/\\par[d]?\b/gi, '\n')
            .replace(/\\[a-z]+-?\d* ?/gi, '')
            .replace(/[{}]/g, '')
            .replace(/[^\S\n]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    const decode = (buf) => new TextDecoder('utf-8', { fatal: false }).decode(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    const slideNo = (n) => Number((n.match(/(\d+)/) || [0, 0])[1]);

    async function zipText(ext, buf) {
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
        const read = (n) => (zip.files[n] ? zip.files[n].async('string') : Promise.resolve(''));
        // Callers pass an already-ordered list; sorting here would put slide10 before slide2.
        const join = async (list) => {
            const out = [];
            for (const n of list) out.push(xmlToText(await read(n)));
            return out.filter(Boolean).join('\n\n');
        };

        if (ext === 'docx') return xmlToText(await read('word/document.xml'));
        if (ext === 'odt') return xmlToText(await read('content.xml'));
        if (ext === 'pptx')
            return join(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b)));
        if (ext === 'epub') return join(names.filter((n) => /\.x?html?$/i.test(n)));
        if (ext === 'xlsx') {
            // Shared strings hold the labels; the sheet XML holds the numbers and formula results.
            const parts = [xmlToText(await read('xl/sharedStrings.xml'))];
            for (const n of names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b))) {
                parts.push(xmlToText(await read(n)));
            }
            return parts.filter(Boolean).join('\n\n');
        }
        return '';
    }

    async function extractText(ext, buf) {
        let text;
        if (ZIP_EXT.includes(ext)) text = await zipText(ext, buf);
        else {
            const raw = decode(buf);
            if (ext === 'rtf') text = rtfToText(raw);
            else if (MARKUP_EXT.includes(ext)) text = xmlToText(raw);
            else text = raw;
        }
        // eslint-disable-next-line no-control-regex -- stray NUL bytes survive some decoders and must go
        const clean = text.replace(/\u0000/g, '');
        return clean.trim().slice(0, MAX_TEXT);
    }

    return { extractText, xmlToText, rtfToText, decodeEntities, TEXT_EXT, MARKUP_EXT, SPECIAL_EXT, ZIP_EXT, OK_EXT, MAX_TEXT };
});
