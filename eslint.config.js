const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    js.configs.recommended,
    { ignores: ['node_modules/**', 'dist/**', 'release/**'] },
    {
        files: ['main.js', 'preload.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js', 'renderer/zip-archive.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
        }
    },
    {
        files: ['renderer/*.js'],
        ignores: ['renderer/zip-archive.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: {
                ...globals.browser,
                // Exposed by preload.js through contextBridge.
                api: 'readonly',
                // Classic renderer modules loaded before app.js.
                Thumbs: 'readonly',
                Table: 'readonly',
                Preview: 'readonly',
                Settings: 'readonly',
                Sidebar: 'readonly',
                // pdfjs and jszip are loaded as classic scripts from node_modules.
                pdfjsLib: 'readonly',
                JSZip: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
        }
    },
    {
        // UMD files: Node must be able to require() them directly for tests.
        files: [
            'renderer/naming.js',
            'renderer/extract.js',
            'renderer/rename.js',
            'renderer/providers.js',
            'renderer/exif.js',
            'renderer/zip.js',
            'renderer/errors.js'
        ],
        languageOptions: {
            globals: { ...globals.browser, module: 'readonly', require: 'readonly' }
        }
    }
];
