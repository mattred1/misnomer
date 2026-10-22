const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

if (!electron.app || typeof electron.nativeImage?.createFromPath !== 'function') {
    throw new Error('Run this script with `npm run icons`; it uses Electron to compose the macOS icon grid.');
}

const { app, nativeImage } = electron;

const root = path.resolve(__dirname, '..');
const iconSource = path.join(root, 'build', 'icon.icon');
const icnsOutput = path.join(root, 'build', 'icon.icns');
const dockIconOutput = path.join(root, 'build', 'icon-512.png');
const sidebarDir = path.join(root, 'renderer', 'assets');
const SIDEBAR_SIZE = 128;

// macOS keeps app artwork inside roughly 824 of 1024 pixels. Without this inset the icon
// renders visibly larger than its neighbors in the Dock.
const CONTENT_RATIO = 824 / 1024;

// Every size iconutil accepts, rendered from the vector source instead of scaled in place.
const ICONSET = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
];

function findIctool() {
    if (process.env.ICTOOL) return process.env.ICTOOL;
    const bundled = '/Applications/Icon Composer.app/Contents/Executables/ictool';
    if (process.platform !== 'darwin') throw new Error('Icon Composer is only available on macOS.');
    if (fs.existsSync(bundled)) return bundled;
    try {
        const found = execFileSync('mdfind', ['kMDItemCFBundleIdentifier == "com.apple.IconComposer"'], {
            encoding: 'utf8'
        })
            .split('\n')
            .find(Boolean);
        if (found) return path.join(found, 'Contents', 'Executables', 'ictool');
    } catch {
        // Spotlight may be unavailable; fall through to the actionable error below.
    }
    throw new Error('Icon Composer was not found. Install it from the App Store or set ICTOOL to its ictool executable.');
}

function exportPng(ictool, output, size, rendition) {
    execFileSync(
        ictool,
        [
            iconSource,
            '--export-image',
            '--output-file',
            output,
            '--platform',
            'macOS',
            '--rendition',
            rendition,
            '--width',
            String(size),
            '--height',
            String(size),
            '--scale',
            '1'
        ],
        { stdio: 'ignore' }
    );
}

function exportDockPng(ictool, tmpDir, output, size, rendition) {
    const content = Math.max(1, Math.round(size * CONTENT_RATIO));
    const inset = Math.round((size - content) / 2);
    const raw = path.join(tmpDir, `raw-${size}-${rendition}.png`);
    exportPng(ictool, raw, content, rendition);

    const image = nativeImage.createFromPath(raw);
    const { width, height } = image.getSize();
    const source = image.toBitmap();
    const canvas = Buffer.alloc(size * size * 4);
    for (let y = 0; y < height; y++) {
        source.copy(canvas, ((y + inset) * size + inset) * 4, y * width * 4, (y + 1) * width * 4);
    }
    fs.writeFileSync(output, nativeImage.createFromBitmap(canvas, { width: size, height: size }).toPNG());
}

function main() {
    if (!fs.existsSync(path.join(iconSource, 'icon.json'))) {
        throw new Error(`Missing Icon Composer document at ${iconSource}`);
    }

    const ictool = findIctool();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misnomer-icons-'));
    const iconset = path.join(tmpDir, 'icon.iconset');
    fs.mkdirSync(iconset);
    try {
        for (const [name, size] of ICONSET) exportDockPng(ictool, tmpDir, path.join(iconset, name), size, 'Default');
        execFileSync('iconutil', ['--convert', 'icns', iconset, '--output', icnsOutput], { stdio: 'inherit' });

        exportDockPng(ictool, tmpDir, dockIconOutput, 512, 'Default');
        fs.mkdirSync(sidebarDir, { recursive: true });
        // The sidebar shows the artwork edge to edge inside its own tile.
        exportPng(ictool, path.join(sidebarDir, 'icon-light.png'), SIDEBAR_SIZE, 'Default');
        exportPng(ictool, path.join(sidebarDir, 'icon-dark.png'), SIDEBAR_SIZE, 'Dark');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log(`Wrote ${path.relative(root, icnsOutput)}, ${path.relative(root, dockIconOutput)}, and renderer/assets icons.`);
}

app.whenReady().then(() => {
    app.dock?.hide();
    try {
        main();
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
