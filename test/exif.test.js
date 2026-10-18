const test = require('node:test');
const assert = require('node:assert/strict');
const { exifDate, formatDate, normalize } = require('../renderer/exif.js');

const enc = new TextEncoder();

// Builds a minimal TIFF block with the date tags the parser looks for.
function buildTiff({ le = true, original = '', digitized = '', modified = '', ifd0Original = '' }) {
    const text = (s) => {
        const b = new Uint8Array(20);
        b.set(enc.encode(s));
        return b;
    };
    const hasExif = !!(original || digitized);
    const ifd0Count = (modified ? 1 : 0) + (ifd0Original ? 1 : 0) + (hasExif ? 1 : 0);
    const exifCount = (original ? 1 : 0) + (digitized ? 1 : 0);
    const ifd0Off = 8;
    const exifOff = ifd0Off + 2 + ifd0Count * 12 + 4;
    let dataOff = hasExif ? exifOff + 2 + exifCount * 12 + 4 : ifd0Off + 2 + ifd0Count * 12 + 4;

    const reserve = () => {
        const at = dataOff;
        dataOff += 20;
        return at;
    };
    const modifiedAt = modified ? reserve() : 0;
    const ifd0OriginalAt = ifd0Original ? reserve() : 0;
    const originalAt = original ? reserve() : 0;
    const digitizedAt = digitized ? reserve() : 0;

    const buf = new Uint8Array(dataOff);
    const u16 = (p, v) => {
        if (le) {
            buf[p] = v & 255;
            buf[p + 1] = (v >> 8) & 255;
        } else {
            buf[p] = (v >> 8) & 255;
            buf[p + 1] = v & 255;
        }
    };
    const u32 = (p, v) => {
        if (le) {
            buf[p] = v & 255;
            buf[p + 1] = (v >> 8) & 255;
            buf[p + 2] = (v >> 16) & 255;
            buf[p + 3] = (v >>> 24) & 255;
        } else {
            buf[p] = (v >>> 24) & 255;
            buf[p + 1] = (v >> 16) & 255;
            buf[p + 2] = (v >> 8) & 255;
            buf[p + 3] = v & 255;
        }
    };
    const tag = (at, id, type, count, value) => {
        u16(at, id);
        u16(at + 2, type);
        u32(at + 4, count);
        u32(at + 8, value);
    };

    buf[0] = le ? 0x49 : 0x4d;
    buf[1] = buf[0];
    u16(2, 42);
    u32(4, ifd0Off);

    u16(ifd0Off, ifd0Count);
    let e = ifd0Off + 2;
    if (modified) {
        tag(e, 0x0132, 2, 20, modifiedAt);
        buf.set(text(modified), modifiedAt);
        e += 12;
    }
    if (ifd0Original) {
        tag(e, 0x9003, 2, 20, ifd0OriginalAt);
        buf.set(text(ifd0Original), ifd0OriginalAt);
        e += 12;
    }
    if (hasExif) {
        tag(e, 0x8769, 4, 1, exifOff);
        e += 12;
    }
    u32(e, 0);

    if (hasExif) {
        u16(exifOff, exifCount);
        let x = exifOff + 2;
        if (original) {
            tag(x, 0x9003, 2, 20, originalAt);
            buf.set(text(original), originalAt);
            x += 12;
        }
        if (digitized) {
            tag(x, 0x9004, 2, 20, digitizedAt);
            buf.set(text(digitized), digitizedAt);
            x += 12;
        }
        u32(x, 0);
    }
    return buf;
}

function jpegWith(tiff) {
    const app1 = new Uint8Array(6 + tiff.length);
    app1.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
    app1.set(tiff, 6);
    const len = app1.length + 2;
    return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 255, len & 255, ...app1, 0xff, 0xd9]);
}

function pngWith(tiff) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const n = tiff.length;
    const chunk = [
        (n >>> 24) & 255,
        (n >> 16) & 255,
        (n >> 8) & 255,
        n & 255,
        0x65,
        0x58,
        0x49,
        0x66, // "eXIf"
        ...tiff,
        0,
        0,
        0,
        0 // CRC, not validated by the parser
    ];
    return new Uint8Array([...sig, ...chunk]);
}

test('exifDate: reads DateTimeOriginal from a little-endian TIFF', () => {
    const tiff = buildTiff({ original: '2024:05:11 09:30:00' });
    assert.equal(exifDate(tiff), '2024-05-11');
});

test('exifDate: reads big-endian TIFFs', () => {
    const tiff = buildTiff({ le: false, original: '2021:12:03 18:02:59' });
    assert.equal(exifDate(tiff), '2021-12-03');
});

test('exifDate: prefers original over digitized over modified', () => {
    const all = buildTiff({
        original: '2019:01:02 03:04:05',
        digitized: '2020:02:03 04:05:06',
        modified: '2021:03:04 05:06:07'
    });
    assert.equal(exifDate(all), '2019-01-02');
    assert.equal(exifDate(buildTiff({ digitized: '2020:02:03 04:05:06', modified: '2021:03:04 05:06:07' })), '2020-02-03');
    assert.equal(exifDate(buildTiff({ modified: '2021:03:04 05:06:07' })), '2021-03-04');
});

test('exifDate: unwraps a JPEG APP1 Exif segment', () => {
    const tiff = buildTiff({ original: '2018:07:14 12:00:00' });
    assert.equal(exifDate(jpegWith(tiff)), '2018-07-14');
});

test('exifDate: finds date tags written directly in IFD0', () => {
    assert.equal(exifDate(buildTiff({ ifd0Original: '2018:07:14 12:00:00' })), '2018-07-14');
    // A nonstandard IFD0 DateTimeOriginal still beats the file-modified DateTime.
    assert.equal(exifDate(buildTiff({ ifd0Original: '2018:07:14 12:00:00', modified: '2020:01:01 00:00:00' })), '2018-07-14');
});

test('exifDate: reads a PNG eXIf chunk', () => {
    const tiff = buildTiff({ original: '2023:11:30 08:15:00' });
    assert.equal(exifDate(pngWith(tiff)), '2023-11-30');
});

test('exifDate: finds the marker inside other containers', () => {
    const tiff = buildTiff({ original: '2017:09:21 10:11:12' });
    const wrapped = new Uint8Array([1, 2, 3, 4, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]);
    assert.equal(exifDate(wrapped), '2017-09-21');
});

test('exifDate: returns an empty string when there is no usable date', () => {
    assert.equal(exifDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), '');
    assert.equal(exifDate(new Uint8Array(0)), '');
    assert.equal(exifDate(null), '');
    assert.equal(exifDate(buildTiff({ original: '0000:00:00 00:00:00' })), '');
    assert.equal(exifDate(buildTiff({ original: 'not a date' })), '');
});

test('normalize: accepts colon and dash separators but rejects impossible values', () => {
    assert.equal(normalize('2024:05:11 09:30:00'), '2024-05-11');
    assert.equal(normalize('2024-05-11T09:30:00'), '2024-05-11');
    assert.equal(normalize('2024:13:01 00:00:00'), '');
    assert.equal(normalize('2024:00:10 00:00:00'), '');
});

test('formatDate: renders every supported date format', () => {
    assert.equal(formatDate('2026-03-05', 'ymd'), '2026-03-05');
    assert.equal(formatDate('2026-03-05', 'mdy'), '03-05-2026');
    assert.equal(formatDate('2026-03-05', 'dmy'), '05-03-2026');
    assert.equal(formatDate('2026-03-05', 'compact'), '20260305');
    assert.equal(formatDate('2026-03-05', 'ym'), '2026-03');
    assert.equal(formatDate('2026-03-05', 'y'), '2026');
    assert.equal(formatDate('2026-03-05', 'unknown'), '2026-03-05');
    assert.equal(formatDate('', 'ymd'), '');
});
