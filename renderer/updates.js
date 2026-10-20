// Auto-update UI. The main process owns the update state; this module only
// reflects it in the banner and the Settings dialog.
(() => {
    const $ = (s) => document.querySelector(s);
    const banner = $('#updatebanner'),
        bannerTitle = $('#updatetitle'),
        bannerMsg = $('#updatemsg'),
        bannerWrap = $('#updatebannerprog'),
        bannerFill = $('#updatebannerfill'),
        installBtn = $('#updateinstall'),
        laterBtn = $('#updatelater'),
        appVer = $('#appver'),
        checkBtn = $('#updatecheck'),
        status = $('#updatestat'),
        settingsWrap = $('#updateprog'),
        settingsFill = $('#updateprogfill');

    let current = null,
        dismissed = '';

    function setBar(wrap, fill, percent) {
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        fill.style.width = value + '%';
        wrap.classList.toggle('active', value > 0 && value < 100);
    }

    function render(s) {
        if (!s) return;
        current = s;
        appVer.textContent = s.currentVersion || '';
        checkBtn.disabled = !s.supported || ['checking', 'downloading', 'downloaded'].includes(s.state);
        const text = {
            unsupported: 'Update checks run in the packaged app.',
            idle: 'Updates are checked automatically.',
            checking: 'Checking for updates…',
            'up-to-date': 'You are up to date.',
            downloading: s.percent ? 'Downloading update… ' + s.percent + '%' : 'Downloading update…',
            downloaded: s.version
                ? 'Version ' + s.version + ' is ready to install. Restart now, or it installs when you quit.'
                : 'An update is ready to install.',
            error: s.message || 'Update check failed.'
        }[s.state];
        status.textContent = text || '';
        setBar(settingsWrap, settingsFill, s.state === 'downloading' ? s.percent : 0);

        const show = s.state === 'downloaded' && dismissed !== (s.version || 'update');
        banner.hidden = !show;
        if (!show) return;
        bannerTitle.textContent = 'Update ready';
        bannerMsg.textContent = s.version
            ? 'Misnomer ' + s.version + ' is ready. It also installs when you quit.'
            : 'The update installs when you quit.';
        installBtn.hidden = s.state !== 'downloaded';
        laterBtn.hidden = s.state !== 'downloaded';
        setBar(bannerWrap, bannerFill, s.state === 'downloading' ? s.percent : 100);
        bannerWrap.classList.toggle('active', true);
    }

    checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        try {
            render(await api.checkForUpdates());
        } catch (e) {
            render({ ...(current || {}), state: 'error', message: e.message });
        }
    };
    installBtn.onclick = () => api.installUpdate();
    laterBtn.onclick = () => {
        dismissed = current?.version || 'update';
        banner.hidden = true;
    };

    async function init() {
        if (typeof api === 'undefined') return;
        try {
            render(await api.getUpdateState());
            api.onUpdateStatus(render);
        } catch {
            /* preload unavailable (for example, opening index.html directly) */
        }
    }
    init();
})();
