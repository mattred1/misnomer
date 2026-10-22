// Sidebar width is a view preference, so it lives in localStorage instead of the
// app settings file, and is applied at load to avoid a layout jump on launch.
window.Sidebar = (() => {
    const KEY = 'misnomer.sidebarWidth';
    const MIN = 180;
    const MAX = 460;
    const DEFAULT = 236;
    const root = document.documentElement;
    let width = DEFAULT;

    const clamp = (w) => Math.round(Math.min(MAX, Math.max(MIN, w)));

    function read() {
        try {
            const saved = Number(localStorage.getItem(KEY));
            if (Number.isFinite(saved) && saved >= MIN) return clamp(saved);
        } catch {
            /* storage unavailable */
        }
        return DEFAULT;
    }

    function apply(w, persist) {
        width = clamp(w);
        root.style.setProperty('--sb-w', width + 'px');
        const handle = document.getElementById('splitter');
        if (handle) handle.setAttribute('aria-valuenow', String(width));
        if (persist) {
            try {
                localStorage.setItem(KEY, String(width));
            } catch {
                /* storage unavailable */
            }
        }
    }

    apply(read());

    function init() {
        const handle = document.getElementById('splitter');
        if (!handle) return;
        handle.setAttribute('aria-valuemin', String(MIN));
        handle.setAttribute('aria-valuemax', String(MAX));
        handle.setAttribute('aria-valuenow', String(width));

        let startX = 0,
            startWidth = width,
            dragging = false;

        const start = (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startWidth = width;
            handle.classList.add('dragging');
            document.body.classList.add('resizing');
            handle.setPointerCapture(e.pointerId);
        };
        const move = (e) => {
            if (dragging) apply(startWidth + e.clientX - startX);
        };
        const end = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing');
            apply(width, true);
        };

        handle.addEventListener('pointerdown', start);
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        handle.addEventListener('lostpointercapture', end);

        handle.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const step = e.shiftKey ? 32 : 8;
            apply(width + (e.key === 'ArrowRight' ? step : -step), true);
        });

        // Double-click restores the default width, matching native splitters.
        handle.addEventListener('dblclick', () => apply(DEFAULT, true));
    }

    return { init };
})();
