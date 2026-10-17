# Misnomer

A small Electron desktop app that looks at your files and gives them meaningful, consistent names.

Drop in a batch of documents and images, pick a naming template, and the app reads each file with a vision model and proposes a name built from what it actually sees: an invoice from Acme dated 2026-03-01 becomes `2026-03-01-acme-invoice-march-service-call`.

Everything runs locally except the files you send to a cloud model. Your API key is stored encrypted in the OS keychain via Electron's `safeStorage`, never in plain text.

---

## Current features

- **Batch processing** — drop a folder's worth of files at once, watch per-file status, and fix any name inline before saving.
- **Two engines**
  - **Cloud API** — Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, OpenRouter, Groq, Mistral, or Together AI. Each provider keeps its own encrypted key and model choice.
  - **Local model** — runs on your Mac through `llama-server` (llama.cpp) with a vision GGUF model plus a matching `mmproj` projector. Nothing leaves the machine.
- **Live model list** — the model dropdown is populated from the selected provider's own catalogue, so only models your key can actually reach are offered.
- **Connection check** — Settings shows a green, amber, or red dot for the selected provider, with the reason when a key fails.
- **Structured output** — requests a JSON schema where the provider supports it, and falls back to plain JSON parsing where it does not.
- **Naming templates** — compose names from `{date}`, `{entity}`, `{type}`, and `{title}` with a configurable separator, plus any custom fields you define.
- **Live template preview** — see the filename your template produces, with unknown placeholders flagged before you run a batch.
- **Date formats** — `YYYY-MM-DD`, `MM-DD-YYYY`, `DD-MM-YYYY`, `YYYYMMDD`, `YYYY-MM`, or `YYYY`.
- **Custom fields** — define your own values (e.g. `amount`, `category`) and use them as template placeholders; the request schema is generated to match.
- **Custom instructions** — add free-text guidance per batch (e.g. "use the client name from the letterhead, not the sender").
- **Presets** — save and switch between template + separator + date format + instructions + fields combinations.
- **Safe output** — duplicate names within a batch are auto-suffixed (`-2`, `-3`) and illegal filename characters are stripped.
- **Export** — save a copy of a single row, or download the whole batch as a ZIP.
- **In-place rename** — rename files where they live. Collisions are resolved against what is already in each folder, so nothing is overwritten.
- **EXIF capture-date fallback** — when a photo has no visible date, the capture date written by the camera is read from EXIF metadata and formatted with your chosen date format.
- **Thumbnail previews** — every image and PDF row shows a thumbnail of the first page; click it for a larger view.
- **Undo** — every rename batch is recorded; walk the stack backwards to restore original names.
- **Folder support** — drop a folder or use **Choose a folder…** and it is scanned recursively.
- **Progress and cancel** — a running count of processed files, and a Cancel button that aborts the in-flight request.
- **Pause/resume** — an error pauses the batch so you can skip the offending file and continue.
- **Automatic retry** — rate limits and transient server errors (429, 5xx) are retried up to 3 times with exponential backoff and jitter before a row is marked failed.
- **Retry failed rows** — the **Retry failed** button re-queues only the rows that errored, leaving finished work untouched.

## Supported file types

| Type | Extensions | How it is read |
| --- | --- | --- |
| Documents | `.pdf` | Sent as a native document to Anthropic and Gemini. Providers that speak OpenAI chat completions cannot take a PDF, so the first 2 pages are rendered to JPEG images instead. |
| Images (native) | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | Sent to the model directly |
| Images (canvas) | `.bmp`, `.ico`, `.svg`, `.avif` | Chromium can decode these but the model APIs won't accept them, so they are re-encoded to JPEG in the app. The file on disk keeps its original format. |
| Images (sips) | `.tif`, `.tiff`, `.heic`, `.heif` | Chromium cannot decode these at all, so macOS `sips` converts them to JPEG in the main process. macOS only. |
| Text | `.txt`, `.md`, `.markdown`, `.csv`, `.tsv`, `.json`, `.log`, `.yml`, `.yaml`, `.srt`, `.vtt` | Read as UTF-8 and sent in the prompt |
| Markup | `.html`, `.htm`, `.xml`, `.rtf` | Tagged content is stripped down to readable text before being sent |
| Office / ebooks | `.docx`, `.xlsx`, `.pptx`, `.odt`, `.epub` | These are ZIP containers; the relevant XML parts are unzipped with `jszip` and reduced to text |

Text is capped at 12,000 characters per file before it goes into a prompt. Files with any other extension are skipped, and the drop zone lists what was rejected.

Photos with no printed or visible date fall back to the capture date stored in EXIF metadata. The reader handles JPEG, PNG, WebP, and TIFF directly, and scans other containers such as HEIC for the EXIF block. The model's date always wins when it can see one.

## Requirements

- macOS (packaging is currently configured for macOS `.dmg` only)
- Node.js 18+ and npm (for development)
- **For the cloud engine:** an API key for whichever provider you choose
- **For the local engine:** `brew install llama.cpp`, then a vision `.gguf` model and its matching `mmproj` `.gguf`

## Getting started

```bash
git clone <your-repo-url>
cd misnomer
npm install
npm start
```

### Configure an engine

1. Click **Settings**.
2. Under **Engine**, choose **Cloud API** or **Local model**. Only the section for the engine you picked is shown.
3. For **Cloud API**:
   - Pick a **Provider**.
   - Paste that provider's API key and click **Save**. The key is encrypted with the OS keychain and stored per provider.
   - Watch the status dot: amber while it checks, green when the key works, red with the provider's message when it does not.
   - Choose a **Model** from the dropdown. The list is fetched from the provider, so it only shows models your key can reach. **Refresh** re-fetches it.
4. For **Local model**, choose the model `.gguf`, the `mmproj` `.gguf`, and (optionally) the `llama-server` binary. If the binary lives in Homebrew's standard location, it is auto-detected.
5. Click **Done**. Settings persist to your Electron `userData` directory.

## Supported providers

| Provider | API family |
| --- | --- |
| Anthropic | Messages API |
| Google Gemini | `generateContent` |
| OpenAI | OpenAI chat completions |
| xAI | OpenAI chat completions |
| DeepSeek | OpenAI chat completions |
| OpenRouter | OpenAI chat completions |
| Groq | OpenAI chat completions |
| Mistral | OpenAI chat completions |
| Together AI | OpenAI chat completions |

Most providers expose an OpenAI-compatible endpoint, so adding one is a single entry in `renderer/providers.js`.

> Upgrading from a single-provider build? Your existing key and model are migrated to Anthropic automatically on first launch.

### Using it

1. Drop files or a folder onto the drop zone, click it to browse, or use **Choose a folder…**. Folders are scanned recursively.
2. Adjust the template, separator, date format, and any custom instructions.
3. Click **Generate names**. Each row updates as it finishes.
4. Edit any name you don't like.
5. Click **Rename in place** to rename the files where they are, or use **Save copy** / **Download all (ZIP)** to export instead.

Renames are confirmed before anything happens and never overwrite an existing file: if the name is already taken in that folder, it gets a `-2`, `-3` suffix. **Undo rename** reverts the most recent batch and can be pressed repeatedly to walk back through the session.

## Naming template reference

| Placeholder | Fills with |
| --- | --- |
| `{title}` | A 2–5 word description of what the file is |
| `{entity}` | The vendor, company, or person tied to the document, if any |
| `{date}` | The document's date, formatted per the date-format setting |
| `{type}` | The document type, e.g. `invoice`, `receipt`, `screenshot`, `photo` |
| `{whatever}` | Any custom field you defined in Settings |

Values are lowercased, accent-stripped, and separated by the chosen separator. Empty placeholders collapse cleanly, so a missing date never leaves a stray `--` in the name, and an unknown placeholder fills empty rather than leaking its own name into the filename.

## Development

```bash
npm test      # unit tests for the naming logic (node --test)
npm run lint  # ESLint
npm run format # Prettier, writes changes in place
```

The logic worth testing lives in five dependency-free UMD modules that work in both the renderer and Node:

- `renderer/naming.js` — slugging, template filling, filename sanitizing, duplicate resolution
- `renderer/extract.js` — pulling text out of Office/ebook/HTML/RTF files
- `renderer/rename.js` — path handling, collision-aware rename planning, and undo replay
- `renderer/providers.js` — the provider registry, request shapes, model-catalogue parsing, and settings migration
- `renderer/exif.js` — EXIF capture-date parsing and date-format rendering

Each is covered by its own test file. Run the tests before changing any of them.

## Building a distributable

```bash
npm run dist
```

This runs `electron-builder --mac` and produces a DMG in `dist/`. The build is **unsigned**, so Gatekeeper will warn first-time users. See the roadmap.

## Project layout

```
main.js                Electron main process: IPC handlers, model calls, settings, file I/O
preload.js             contextBridge surface exposed to the renderer as window.api
renderer/
  index.html           Markup and all styling
  naming.js            Pure naming logic: slug, template fill, sanitizing, dedupe
  extract.js           Text extraction from text, markup, and Office/ebook containers
  providers.js         Provider registry, request shapes, model parsing, settings migration
  exif.js              EXIF capture-date reader and date-format rendering
  rename.js            Path handling, rename planning, and undo replay
  app.js               UI state, drag-and-drop, PDF prep, batching, format conversion
 test/
  naming.test.js       Unit tests for naming.js
  extract.test.js      Unit tests for extract.js
  providers.test.js    Unit tests for providers.js
  rename.test.js       Unit tests for rename.js
  exif.test.js         Unit tests for exif.js
eslint.config.js       ESLint flat config
```

The renderer has no Node access (`contextIsolation: true`, `nodeIntegration: false`); it talks to the main process only through the narrow `window.api` bridge.

---

## Roadmap / TODO

Ordered so that each tier is safe to build on the previous one. Tier 1 items are low-risk and fix active failure modes; Tier 2 delivers the biggest user-visible wins; Tier 3 is polish and distribution.

### Tier 1 — Foundation

- [x] **Extract naming logic into a testable module** — `renderer/naming.js`, loaded as a UMD script so Node can also `require` it
- [x] **Add unit tests** for the naming logic using the built-in `node --test` runner (24 tests, zero new runtime dependencies)
- [x] **Add ESLint + Prettier** with `lint` and `format` npm scripts
- [x] **Add a LICENSE file** (MIT)
- [ ] **Add a screenshot/GIF** of the UI to this README — needs a capture from a running instance
- [x] **Support more image formats** — WebP natively, plus BMP/ICO/SVG/AVIF via in-app JPEG conversion
- [x] **Report rejected files** instead of skipping unsupported extensions silently
- [x] **Retry failed files individually** with a **Retry failed** button
- [x] **Retry with exponential backoff** (and jitter) on HTTP 429/5xx, up to 3 attempts
- [x] **Windows-safe filenames** — reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) are prefixed, and trailing dots/spaces are stripped
- [x] **Length guard** — base names are capped at 120 characters without leaving a trailing dot or space

### Tier 2 — Capability

- [x] **Text-based formats** — `.txt`, `.md`, `.csv`, `.json`, and friends are read as UTF-8 and sent in the prompt
- [x] **Office formats via the existing `jszip` dependency** — `.docx`, `.xlsx`, `.pptx`, `.odt`, `.epub` are unzipped and their XML parts reduced to text
- [x] **HTML/XML/RTF** — markup is stripped to readable text, with `<script>`/`<style>`/`<head>` contents discarded
- [x] **TIFF and HEIC/HEIF support** via macOS `sips` — Chromium cannot decode these, so the canvas conversion path can't reach them
- [x] **Arbitrary template fields** — user-defined placeholders such as `{amount}` or `{category}`, with the request schema and prompt generated to match
- [x] **Template preview + validation** — shows the resulting filename and flags unknown `{placeholders}`
- [x] **Progress indicator and cancel** — a "3 of 20" counter plus a Cancel button that aborts the in-flight request
- [ ] **RAW camera formats** — the `sips` conversion path could cover `.cr2`, `.nef`, `.arw`, etc. on macOS
- [x] **True in-place rename** with `fs.rename`, preserving the source folder, plus collision handling
- [x] **Folder drag-and-drop** (recursive) — dropped folders and **Choose a folder…** are walked by the main process
- [x] **Undo** — a session stack of rename batches, replayed in reverse with conflicts reported

### Tier 3 — Polish and distribution

- [x] **Disk-aware dedupe** — renames consult the target folder, so an existing file is never overwritten (exported copies still go through the OS save dialog)
- [x] **EXIF capture-date fallback** for photos with no visible date
- [x] **Thumbnail previews** in the results table
- [ ] **Token/cost display** per batch for the Anthropic path
- [ ] **Accessibility pass** — `aria-live` on status updates, focus trap in the settings dialog
- [ ] **Keyboard shortcuts**
- [ ] **Export/import presets and settings** to JSON for sharing and version control
- [ ] **Code signing + notarization** for the macOS DMG (unsigned builds trigger Gatekeeper warnings)
- [ ] **Windows and Linux build targets**
- [ ] **Auto-update** via `electron-updater`
- [ ] **GitHub Actions CI** — run tests on PR and publish signed releases on tag
- [ ] **Internationalization** of the prompt and UI
- [ ] **Headless CLI / watch-folder mode** for scripting and scheduled runs
- [ ] **Network-aware concurrency** — the current worker count is hardcoded (1 local, 2 cloud) and should be configurable

---

## License

MIT — see [LICENSE](LICENSE).
