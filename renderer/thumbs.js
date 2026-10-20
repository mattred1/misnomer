// Lazy thumbnails and the full-size preview dialog. Rows only request a
// thumbnail when they scroll near the viewport, and a small worker pool keeps
// large batches from launching hundreds of decodes at once.
window.Thumbs = (() => {
    const $ = (s) => document.querySelector(s);
    const THUMB_MAX = 120,
        THUMB_WORKERS = 3;

    let deps = null,
        observer = null,
        active = 0,
        previewUrl = '';
    const cache = new Map(),
        jobs = new Map(),
        queue = [];

    function init(options) {
        deps = options;
        observer =
            typeof IntersectionObserver === 'function'
                ? new IntersectionObserver(
                      (entries) => {
                          for (const entry of entries) {
                              if (!entry.isIntersecting) continue;
                              const f = jobs.get(entry.target);
                              observer.unobserve(entry.target);
                              jobs.delete(entry.target);
                              if (f) queueThumb(f);
                          }
                      },
                      { rootMargin: '200px' }
                  )
                : null;
        $('#imgclose').onclick = () => $('#imgdlg').close();
        $('#imgdlg').addEventListener('close', () => {
            if (previewUrl) {
                URL.revokeObjectURL(previewUrl);
                previewUrl = '';
            }
            $('#imgview').removeAttribute('src');
            $('#imgview').alt = '';
        });
    }

    // A thumbnail is drawn from the file itself: PDFs render page one, sips formats
    // are converted first, and everything else is decoded by Chromium.
    function observe(f, box) {
        if (f.ext !== 'pdf' && !deps.imageExt.includes(f.ext)) return;
        if (!observer) {
            queueThumb(f);
            return;
        }
        jobs.set(box, f);
        observer.observe(box);
    }
    function queueThumb(f) {
        queue.push(f);
        pumpThumbs();
    }
    function pumpThumbs() {
        while (active < THUMB_WORKERS && queue.length) {
            const f = queue.shift();
            active++;
            thumbFor(f)
                .then((src) => {
                    const box = document.querySelector('#r' + f.id + ' .thumb');
                    if (!box || !src) return;
                    box.textContent = '';
                    const img = document.createElement('img');
                    img.alt = '';
                    img.src = src;
                    box.append(img);
                    box.classList.add('has');
                    box.dataset.label = f.original;
                    box.setAttribute('role', 'button');
                    box.setAttribute('aria-label', 'Preview ' + f.original);
                    box.tabIndex = 0;
                    box.onclick = () => showPreview(f);
                    box.onkeydown = (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            showPreview(f);
                        }
                    };
                })
                .catch(() => {
                    /* leave the extension badge in place */
                })
                .finally(() => {
                    active--;
                    pumpThumbs();
                });
        }
    }
    async function thumbFor(f) {
        if (cache.has(f.path)) return cache.get(f.path);
        let src = '';
        const r = await deps.api.readFile(f.path);
        if (r.ok) {
            if (f.ext === 'pdf') src = await pdfPreview(r.bytes, THUMB_MAX);
            else if (deps.sips.includes(f.ext)) {
                const c = await deps.api.convert(r.bytes, THUMB_MAX);
                if (c.ok) src = await imagePreview(new Blob([c.bytes], { type: 'image/jpeg' }), THUMB_MAX);
            } else src = await imagePreview(new Blob([r.bytes], { type: deps.blobType[f.ext] || 'image/' + f.ext }), THUMB_MAX);
        }
        cache.set(f.path, src);
        return src;
    }
    function pdfPreview(buf, max) {
        let pdf;
        return (async () => {
            pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
            const page = await pdf.getPage(1);
            const base = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: Math.min(1, max / Math.max(base.width, base.height)) });
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(vp.width));
            c.height = Math.max(1, Math.round(vp.height));
            await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            return c.toDataURL('image/jpeg', 0.8);
        })()
            .catch(() => '')
            .finally(() => {
                if (pdf) pdf.destroy();
            });
    }
    async function imagePreview(blob, max) {
        let bmp;
        try {
            // Asking for one dimension preserves the aspect ratio. This also avoids
            // decoding a full-size bitmap just to shrink a phone photo.
            bmp = await createImageBitmap(blob, { resizeWidth: max, resizeQuality: 'high' });
        } catch {
            return elementPreview(blob, max);
        }
        try {
            const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(bmp.width * scale));
            c.height = Math.max(1, Math.round(bmp.height * scale));
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', 0.8);
        } finally {
            if (bmp.close) bmp.close();
        }
    }
    // Some decoders (SVG in particular) only work through an <img> element.
    function elementPreview(blob, max) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(blob),
                img = new Image();
            img.onload = () => {
                try {
                    const w = img.naturalWidth || max,
                        h = img.naturalHeight || max;
                    const scale = Math.min(1, max / Math.max(w, h));
                    const c = document.createElement('canvas');
                    c.width = Math.max(1, Math.round(w * scale));
                    c.height = Math.max(1, Math.round(h * scale));
                    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                    resolve(c.toDataURL('image/jpeg', 0.8));
                } catch {
                    resolve('');
                } finally {
                    URL.revokeObjectURL(url);
                }
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve('');
            };
            img.src = url;
        });
    }
    // Clicking a thumbnail opens a larger view of the same first page.
    async function showPreview(f) {
        const img = $('#imgview'),
            opener = document.activeElement;
        $('#imgname').textContent = f.original;
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            previewUrl = '';
        }
        img.removeAttribute('src');
        const r = await deps.api.readFile(f.path);
        if (!r.ok) {
            deps.message('Could not read ' + f.original + ': ' + r.error);
            return;
        }
        let src = '';
        if (f.ext === 'pdf') src = await pdfPreview(r.bytes, 1100);
        else if (deps.sips.includes(f.ext)) {
            const c = await deps.api.convert(r.bytes, 1100);
            if (c.ok) {
                previewUrl = URL.createObjectURL(new Blob([c.bytes], { type: 'image/jpeg' }));
                src = previewUrl;
            }
        } else {
            previewUrl = URL.createObjectURL(new Blob([r.bytes], { type: deps.blobType[f.ext] || 'image/' + f.ext }));
            src = previewUrl;
        }
        if (!src) {
            deps.message('Could not preview ' + f.original + '.');
            return;
        }
        img.alt = f.original;
        img.src = src;
        if (!$('#imgdlg').open) deps.openDialog($('#imgdlg'), opener);
    }

    function clear() {
        cache.clear();
        queue.length = 0;
        jobs.clear();
        if (observer) observer.disconnect();
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            previewUrl = '';
        }
    }

    return { init, observe, clear };
})();
