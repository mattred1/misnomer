// Minimal EXIF reader used as a fallback when the model cannot see a date in a photo.
// No dependencies: it walks the JPEG/PNG/WebP containers to the TIFF block and reads
// the three date tags cameras write. UMD so Node tests can require() it directly.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Exif = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const TAG_EXIF_IFD = 0x8769;
    const TAG_DATE_TIME = 0x0132;
    const TAG_DATE_ORIGINAL = 0x9003;
    const TAG_DATE_DIGITIZED = 0x9004;

    // EXIF writes "YYYY:MM:DD HH:MM:SS"; some tools use dashes instead. Anything
    // outside a plausible range (including the "0000:00:00" placeholder) is rejected.
    function normalize(value) {
        const m = /^(\d{4})[:\-/](\d{2})[:\-/](\d{2})/.exec(String(value == null ? '' : value).trim());
        if (!m) return '';
        const year = Number(m[1]),
            month = Number(m[2]),
            day = Number(m[3]);
        if (year < 1826 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return '';
        return m[1] + '-' + m[2] + '-' + m[3];
    }

    // Renders an ISO date for the same format ids used by the UI's date-format picker.
    function formatDate(iso, format) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
        if (!m) return '';
        const y = m[1],
            mo = m[2],
            d = m[3];
        if (format === 'mdy') return mo + '-' + d + '-' + y;
        if (format === 'dmy') return d + '-' + mo + '-' + y;
        if (format === 'compact') return y + mo + d;
        if (format === 'ym') return y + '-' + mo;
        if (format === 'y') return y;
        return y + '-' + mo + '-' + d;
    }

    const isTiff = (buf, p) =>
        p + 8 <= buf.length &&
        ((buf[p] === 0x49 && buf[p + 1] === 0x49 && buf[p + 2] === 0x2a && buf[p + 3] === 0x00) ||
            (buf[p] === 0x4d && buf[p + 1] === 0x4d && buf[p + 2] === 0x00 && buf[p + 3] === 0x2a));

    const hasMarker = (buf, p) =>
        p + 6 <= buf.length &&
        buf[p] === 0x45 &&
        buf[p + 1] === 0x78 &&
        buf[p + 2] === 0x69 &&
        buf[p + 3] === 0x66 &&
        buf[p + 4] === 0x00 &&
        buf[p + 5] === 0x00;

    // Returns the offset of the TIFF header, or -1 when there is no EXIF block.
    function tiffStart(buf) {
        // JPEG: walk marker segments to the Exif APP1.
        if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i + 4 <= buf.length) {
                if (buf[i] !== 0xff) {
                    i++;
                    continue;
                }
                const marker = buf[i + 1];
                if (marker === 0xff) {
                    i++;
                    continue;
                }
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                    i += 2;
                    continue;
                }
                if (marker === 0xda || marker === 0xd9) break; // image data starts here
                const len = (buf[i + 2] << 8) | buf[i + 3];
                if (len < 2) break;
                if (marker === 0xe1 && hasMarker(buf, i + 4) && isTiff(buf, i + 10)) return i + 10;
                i += 2 + len;
            }
        }

        // TIFF/TIFF-derived files (including many RAW formats).
        if (isTiff(buf, 0)) return 0;

        // PNG eXIf chunk, which holds a bare TIFF block.
        if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            let i = 8;
            while (i + 12 <= buf.length) {
                const len = ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];
                const type = String.fromCharCode(buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7]);
                if (type === 'eXIf') {
                    if (isTiff(buf, i + 8)) return i + 8;
                    if (hasMarker(buf, i + 8) && isTiff(buf, i + 14)) return i + 14;
                }
                if (type === 'IEND') break;
                i += 12 + len;
            }
        }

        // WebP EXIF chunk.
        if (
            buf.length > 12 &&
            String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'RIFF' &&
            String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) === 'WEBP'
        ) {
            let i = 12;
            while (i + 8 <= buf.length) {
                const type = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
                const len = (buf[i + 4] + (buf[i + 5] << 8) + (buf[i + 6] << 16) + (buf[i + 7] << 24)) >>> 0;
                if (type === 'EXIF') {
                    if (isTiff(buf, i + 8)) return i + 8;
                    if (hasMarker(buf, i + 8) && isTiff(buf, i + 14)) return i + 14;
                }
                i += 8 + len + (len % 2);
            }
        }

        // HEIC/HEIF and anything else: the marker is unambiguous, so scan for it
        // rather than parse the container. Cap the search so huge files stay fast.
        const end = Math.min(buf.length - 14, 4 * 1024 * 1024);
        for (let i = 0; i < end; i++) if (hasMarker(buf, i) && isTiff(buf, i + 6)) return i + 6;
        return -1;
    }

    function readDates(buf, start) {
        const le = buf[start] === 0x49;
        const u16 = (p) => (le ? buf[p] | (buf[p + 1] << 8) : (buf[p] << 8) | buf[p + 1]);
        const u32 = (p) =>
            le
                ? (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0
                : ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;

        const ifd0 = start + u32(start + 4);
        const read = (base) => {
            const out = {};
            if (base + 2 > buf.length) return out;
            const count = u16(base);
            if (count > 1000) return out; // clearly corrupt
            for (let i = 0; i < count; i++) {
                const entry = base + 2 + i * 12;
                if (entry + 12 > buf.length) break;
                const tag = u16(entry),
                    type = u16(entry + 2),
                    n = u32(entry + 4);
                if (tag === TAG_EXIF_IFD && type === 4) out.exifOffset = u32(entry + 8);
                // ASCII values of 4 bytes or fewer are stored inline in the entry itself.
                if (type !== 2 || n < 5 || n > 64) continue;
                const at = start + u32(entry + 8);
                if (at + n > buf.length) continue;
                let s = '';
                for (let j = 0; j < n; j++) {
                    const c = buf[at + j];
                    if (c === 0) break;
                    s += String.fromCharCode(c);
                }
                out[tag] = s;
            }
            return out;
        };

        const zero = read(ifd0);
        const exif = zero.exifOffset ? read(start + zero.exifOffset) : {};
        // DateTimeOriginal belongs in the Exif sub-IFD, but some writers (Pillow
        // among them) put it in IFD0, so check both places.
        return {
            original: normalize(exif[TAG_DATE_ORIGINAL] || zero[TAG_DATE_ORIGINAL]),
            digitized: normalize(exif[TAG_DATE_DIGITIZED] || zero[TAG_DATE_DIGITIZED]),
            modified: normalize(zero[TAG_DATE_TIME])
        };
    }

    // Returns the best capture date as YYYY-MM-DD, or '' when the file has none.
    // Original (when the shot was taken) wins over digitized, then file modified.
    function exifDate(bytes) {
        if (!bytes || !bytes.length) return '';
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const start = tiffStart(buf);
        if (start < 0) return '';
        try {
            const dates = readDates(buf, start);
            return dates.original || dates.digitized || dates.modified || '';
        } catch {
            return '';
        }
    }

    return { exifDate, formatDate, normalize };
});
