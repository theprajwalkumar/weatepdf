# weatepdf

**Free, client-side PDF toolkit — 77 tools. No uploads. No watermark. No sign-up.**

[![Tools](https://img.shields.io/badge/tools-77-6366f1)](https://github.com/theprajwalkumar/weatepdf)
[![Client-side](https://img.shields.io/badge/processing-100%25%20client--side-22d3ee)](https://github.com/theprajwalkumar/weatepdf)
[![Dependencies](https://img.shields.io/badge/build-none%20required-34d399)](https://github.com/theprajwalkumar/weatepdf)

weatepdf is a static web app that edits, merges, splits, compresses, converts, signs, redacts and analyses PDFs entirely inside the browser. There is no backend, no upload endpoint and no account system — documents are read with `File`/`Blob` APIs and processed with JavaScript and WebAssembly.


<img width="2940" height="1684" alt="image" src="https://github.com/user-attachments/assets/042d5209-f74b-46a7-bc30-d78625215c4d" />


**Repository:** https://github.com/theprajwalkumar/weatepdf

---

## Quick start

The app is plain HTML/CSS/JS — there is nothing to build.

```bash
git clone https://github.com/theprajwalkumar/weatepdf.git
cd weatepdf

# recommended: no-cache static server
python3 serve.py 8899

# or any static server
python3 -m http.server 8899
```

Open **http://localhost:8899/**.

> Serve over `http://` rather than opening `index.html` with `file://`. Browsers restrict Web Workers and WASM on `file://`, which several tools (OCR, PDF parsing, AI) depend on.

`serve.py` is a tiny wrapper around Python's `SimpleHTTPRequestHandler` that sends `Cache-Control: no-store`, so changes are never masked by a stale browser cache.

---

## Tool catalogue (77)

### Essentials — 28
Scan Document · Merge PDFs · Compress PDF · Split PDF · Split PDF by Text · Split PDF by Bookmarks · Split PDF in Half · Split PDF by Size · Organize Pages · Rotate PDF · Flip PDF · Multiple Pages Per Sheet · Crop & Resize · Alternate & Mix PDF · Delete PDF Pages · Extract PDF Pages · PDF Size Analyzer · Repair PDF · PDF to JPG · PDF to PNG · PDF to TIFF · PDF to Word · Word to PDF · Images to PDF · PNG to PDF · TIFF to PDF · PDF to ZIP · PDF Workflow Builder

### Edit & Organize — 18
Edit PDF & add Signature · Sign PDF · Fill PDF Form · Redact PDF · Add Watermark · Add Page Numbers · Bates Numbering · Headers & Footers · Flatten PDF · Invert PDF Colours · Edit PDF Metadata · Extract Text · Searchable PDF · PDF to Handwriting · Text to Handwriting · Handwriting to PDF · Thumbmark Maker · Resume Builder

### Security & Privacy — 7
Encrypt PDF · Remove Password · Unlock PDF · Auto-Redact PII · Privacy Risk Scanner · Redaction Checker · Fingerprint Generator

### Convert & Export — 16
Create PDF · Markdown to PDF · HTML to PDF · TXT to PDF · CSV ↔ PDF Converter · PDF to CSV · Excel to PDF · PowerPoint to PDF · PDF to PowerPoint · PDF to Excel · PDF to HTML · PDF to EPUB · PDF to Audio · eBook to PDF · Audio to PDF · Extract Images from PDF

### AI Tools — 3
Chat with PDF (AI) · AI PDF Summarizer · Compare PDFs

### Scan & Share — 2
P2P File Share · Collab Whiteboard

### Business Tools — 3
GST Invoice Generator · POS Bill Generator · GST Filing Prep

---

## Privacy model

- **Documents never leave the device.** Files are read locally and processed in-memory; there is no upload request anywhere in the app.
- **No accounts, no tracking, no watermark.** Output files are not stamped or restricted.
- **Network use is limited to loading code/assets**, never your documents:
  - OCR (Tesseract.js) downloads language data from jsDelivr on first use. The recognition itself runs locally.
  - The optional AI tools lazily load `@xenova/transformers` from jsDelivr and run the model in the browser. Your PDF is not sent to a server.
  - P2P File Share uses WebRTC with a manual offer/answer exchange and no signalling server — the two browsers connect directly, only when you choose to share.

Everything else works fully offline once the page is loaded.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| UI | Vanilla JavaScript, hash router, CSS custom properties |
| PDF read/render | [PDF.js](https://mozilla.github.io/pdf.js/) 2.16.105 |
| PDF write/edit | [pdf-lib](https://pdf-lib.js.org/) 1.17.1 |
| Generators | [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 |
| OCR | [Tesseract.js](https://tesseract.projectnaptha.com/) 5.1.1 |
| Screenshots | [html2canvas](https://html2canvas.hertzen.com/) 1.4.1 |
| Archives | [JSZip](https://stuk.github.io/jszip/) 3.10.1 |
| AI (optional) | Transformers.js loaded on demand |

All runtime libraries are vendored in `vendor/`; there is no bundler, package manager or build step.

---

## Project structure

```
.
├── index.html            # Static shell: header, sidebar mount, view, footer, modals
├── app.js                # Tool registry, router, templates and all 77 handlers
├── styles.css            # Design tokens + layout, dark/light themes
├── serve.py              # No-cache static server (dev convenience)
├── docs/
│   └── ui-migration.md   # UI audit + feature inventory
└── vendor/
    ├── pdf-lib.min.js
    ├── pdf.min.js
    ├── pdf.worker.min.js
    ├── jspdf.umd.min.js
    ├── tesseract.min.js
    ├── html2canvas.min.js
    └── jszip.min.js
```

## How it works

1. `index.html` provides a static shell with `#sidebar`, `#view`, `#search-modal` and `#toast-root`.
2. `app.js` holds the `TOOLS` registry (77 entries: `id`, `name`, `cat`, `icon`, `desc`, `accept`, `action`) and `CATEGORIES` (7 groups).
3. The hash router (`#/merge-pdf`, `#/split-pdf`, …) renders `homeHtml()` or `toolPageHtml(tool)` into `#view`, and `buildSidebar()` into `#sidebar`.
4. Each tool handler reads the selected `File` objects, runs the relevant library, and returns downloadable `Blob`s rendered into `#result`.
5. `styles.css` targets the classes emitted by those templates; `[data-theme="light"]` switches the token set.

To add a tool: append an entry to `TOOLS` in `app.js`, add its branch to `optionsHtml()` if it needs inputs, and register a handler in the tool's `run` switch.

---

## Browser support

Modern evergreen browsers: Chrome/Edge 111+, Firefox 113+, Safari 16.2+ (needed for `color-mix()`), and current mobile browsers.

Some tools require specific APIs and degrade gracefully when unavailable:

| Feature | Requirement |
| --- | --- |
| Scan Document | `getUserMedia` (camera) |
| P2P File Share | WebRTC |
| Collab Whiteboard | `BroadcastChannel` (same-origin tabs) |
| OCR / AI tools | WebAssembly + first-use network for assets |

When a capability is missing, the tool raises a clear error instead of failing silently.

---

## Notes & limitations

- This is a static client-side app: very large PDFs are limited by available browser memory.
- The AI tools run small local models; quality and speed depend on the device.
- Light theme is available via `data-theme="light"` on `<html>`; the current UI exposes dark by default.

---

## Contributing

Issues and pull requests are welcome at
https://github.com/theprajwalkumar/weatepdf/issues.

Please keep the project dependency-free and client-side: no uploads, no telemetry, no build step.

---

## Author

**Prajwal Kumar** — [@theprajwalkumar](https://github.com/theprajwalkumar)

Developed by Prajwal.
