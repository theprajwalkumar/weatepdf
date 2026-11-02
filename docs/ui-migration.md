# weatepdf UI Migration Audit

## App Stack Detection

- **Framework**: Vanilla JavaScript (no framework, no build tool)
- **Router**: Hash-based routing via `location.hash`
- **Styling**: CSS variables in `styles.css`, no preprocessor
- **State**: `state` object in `app.js` with properties: `files`, `tool`, `lastTool`, `busy`, `redact`, `scans`, `camera`, `formFields`
- **Workers**: `pdf.worker.min.js` in `vendor/`
- **Libraries**: pdf-lib 1.17.1, pdf.js 2.16.105, jsPDF 2.5.1, tesseract.js 5.1.1, html2canvas 1.4.1, JSZip 3.10.1 (all in `vendor/`)
- **WASM**: Tesseract runtime/CJK assets from CDN
- **Tests**: CDP test scripts in `/tmp/cdp-test*.mjs` (25/27 tools pass)

## Feature Inventory

Each tool maps: `route` (hash) → `tool` object → `handler` function → `toolPageHtml()` output

### All 77 Tools (route → handler → component):

Essentials (14):
- scan-to-pdf → scan handler → camera UI + file output
- merge-pdf → merge handler → dropzone + file list
- compress-pdf → compress handler → file output
- split-pdf → split handler → file output
- split-pdf-by-text → split-text handler → text input
- split-pdf-by-bookmarks → bookmarks handler → file output
- split-pdf-by-size → split-size handler → file output
- split-pdf-in-half → in-half handler → file output
- organize-pages → organize handler → reorder UI
- rotate-pdf → rotate handler → select degrees
- compress-pdf (duplicate listing) → compress handler
- delete-pdf-pages → delete handler → click-to-remove
- extract-pdf-pages → extract pages handler → select pages
- add-watermark → watermark handler → text/image input

Page Management (11):
- edit-pdf-metadata → metadata handler → form fields
- fill-pdf-form → form fill handler → form fields
- flatten-pdf → flatten handler → image flatten
- redact-pdf → redact handler → text redaction
- repair-pdf → repair handler → fix PDF
- bates-numbering → bates handler → page range
- headers-footers → headers handler → form
- page-numbers → numbers handler → select range
- invert-pdf → invert handler → color conversion
- ocr-pdf → OCR handler → upload + OCR
- compare-pdfs → compare handler → side-by-side

Edit & Annotate (10):
- edit-pdf-text → edit-text handler → text replacement UI
- sign-pdf → sign handler → signature UI
- fill-pdf-form (duplicate) → form fill
- redact-pdf (duplicate) → redaction UI
- redact-checker → redaction-checker handler → detection UI
- privacy-scanner → privacy-scanner handler → PII detection
- auto-redact-pii → auto-redact-pii handler → auto-detect + flatten
- fingerprint-pdf → fingerprint handler → hash + marker
- thumbmark-generator → thumbmark handler → generate thumbnail
- text-to-handwriting → text-to-handwriting → handwriting UI

Convert → PDF (8):
- word-to-pdf → word-to-pdf handler → docx → PDF
- png-to-pdf → png-to-pdf handler → images → PDF
- tiff-to-pdf → tiff-to-pdf handler → tiff → PDF
- excel-to-pdf → excel-to-pdf handler → xlsx → PDF
- pptx-to-pdf → pptx-to-pdf handler → pptx → PDF
- html-to-pdf → html-to-pdf handler → html → PDF
- markdown-to-pdf → markdown-to-pdf handler → md → PDF
- ebook-to-pdf → ebook-to-pdf handler → epub/txt → PDF

Convert → Other (7):
- pdf-to-word → pdf-to-word handler → PDF → docx
- pdf-to-jpg → pdf-to-jpg handler → PDF → JPG images
- pdf-to-tiff → pdf-to-tiff handler → PDF → multi-page TIFF
- extract-images → extract-images handler → extract embedded images
- pdf-to-excel → pdf-to-excel handler → PDF → XLSX
- pdf-to-powerpoint → pdf-to-pptx handler → PDF → PPTX
- pdf-to-epub → pdf-to-epub handler → PDF → EPUB

Security & Privacy (6):
- encrypt-pdf → encrypt handler → password protection
- remove-password → remove-password handler → unlock PDF
- unlock-pdf → unlock-pdf handler → remove restrictions
- auto-redact-pii → auto-redact-pii handler → PII detection + flatten
- privacy-scanner → privacy-scanner handler → detect + report
- redaction-checker → redaction-checker handler → check hidden text

AI Tools (5):
- chat-with-pdf → chat-with-pdf handler → on-device retrieval
- summarize-pdf → summarize-pdf handler → on-device summarization
- searchable-pdf (OCR) → OCR handler → upload + OCR
- compare-pdfs → compare-pdfs handler → side-by-side
- repair-pdf (duplicate) → repair handler

Business Tools (4):
- gst-invoice → gst-invoice handler → tax invoice generator
- pos-billing → pos-billing handler → POS receipt generator
- gst-filing-prep → gst-filing-prep handler → split + zip for portal
- latex-resume → latex-resume handler → PDF + TeX output

Collaborate & Share (2):
- p2p-share → p2p-share handler → WebRTC peer-to-peer
- collab-whiteboard → collab-whiteboard handler → BroadcastChannel whiteboard

## Routes & Pages

1. **Home** (`#/`): `homeHtml()` - hero, badges, featured tools
2. **Tool Pages** (`#/tool-id`): `toolPageHtml(tool)` - dropzone, options, run, results
3. **Search**: Ctrl+K focuses `#search-input`, filters tools by name/desc/id
4. **Sidebar**: Sticky list of categories with tool counts, active indicator via scroll-spy

## Key Functions

- `currentRoute()`: extracts hash, returns `'home'` if none
- `toolById(id)`: finds tool in `TOOLS` by id
- `render()`: main router - reads hash, renders tool page or home
- `navigateTo(hash)`: changes hash + calls `render()`
- `renderFiles()`: renders file list UI
- `wireDropzone()`: handles drag-and-drop + file input
- `afterFiles(toolId)`: post-upload setup for each tool
- `showResult(res)`: displays result with download links + text area
- `toast(msg, kind)`: transient feedback messages
- `setBusy(btn, label, on)`: busy state on run button

## File Handling Pipeline

1. User drops or selects files → `addFiles(list, t)` → `afterFiles(t.id)`
2. Each tool's handler runs `HANDLERS[id]()` → returns `{items, note, text}`
3. `showResult(res)` displays: download links, text area, toast
4. `renderFiles()` updates file list display
5. `wireDropzone()` re-binds after each tool change

## Tool Page Structure (toolPageHtml)

Each tool page includes:
- `.dropzone` with `#file-input` (accept per tool, multiple if applicable)
- `#file-list` - uploaded files display
- `optionsHtml(t)` - tool-specific options panel
- `#run` button → calls `HANDLERS[id]()`
- `#result` div - shows output with downloads + text

## Global State Flow

1. `state.files` → array of `{id, name, size, kind, file}` objects
2. `state.tool` → current tool's `tool.id` or `null`
3. `state.lastTool` → previous tool id for file-accept check
4. When tool changes: `if (prev !== tool.id && state.files.length && !filesMatchAccept(state.files, tool.accept)) state.files = []`
5. `render()` reads `location.hash`, calls `toolById()`, renders appropriate page

## Tests

25/27 CDP tests pass, covering: word-to-pdf, png-to-pdf, tiff-to-pdf, excel-to-pdf, pptx-to-pdf, ebook-to-pdf, pdf-to-csv, pdf-to-pptx, pdf-to-epub, chat-with-pdf, summarize-pdf, edit-pdf-text, auto-redact-pii, privacy-scanner, redaction-checker (clean+dirty), fingerprint-pdf, extract-images, p2p-share, collab-whiteboard, audio-to-pdf, gst-invoice, pos-billing, latex-resume, gst-filing-prep

---

## Phase 2 - Implement Plan

**Order of migration** (keep both themes working, preserve all functionality):

1. **Design tokens** - CSS variables for dark/light themes (define in `:root` and `[data-theme=light]`)
2. **Top bar** - fixed blurred header with logo, search (Ctrl+K), private pill, theme toggle with circular reveal
3. **Sidebar** - sticky left panel with category list, counts, sliding active indicator
4. **Hero section** - gradient headline, staggered reveal, aurora blobs background
5. **Dropzone** - conic-gradient border, floating upload icon, drag states
6. **Category chips** - filtered view with counts, sticky when scrolling past header
7. **Card grid** - 3-column desktop, 2-tablet, 1-mobile; cursor-following spotlight (--mx/--my); lift on hover; icon rotate/scale; arrow reveal; fade-in on scroll
8. **Why section** - styled with aurora accent, stats count-up
9. **Tool pages** - re-skin each tool's `toolPageHtml()` output while keeping all handler logic intact
10. **Footer** - "Developed by Prajwal" with gradient text
11. **Reduced-motion media query** - disable all transitions/animations
12. **Accessibility verification** - focus rings, contrast, labels, keyboard nav

**Migration safeguards**:
- Never delete, rename, or move logic files (`app.js`, handler functions)
- Keep all `TOOLS` entries, `HANDLERS` keys, `id` attributes, `data-` attributes
- Keep `navigateTo()`, `render()`, `currentRoute()` intact
- Keep `HANDLERS` all 77 async functions intact
- Keep `addFiles()`, `afterFiles()`, `wireDropzone()` pipelines intact
- Keep `showResult()`, `toast()`, `setBusy()` intact
- Keep `renderFiles()`, `renderOrganize()`, `renderRedactPage()`, etc. intact
- Only modify CSS/styles, index.html structure, and non-logic JS

## Phase 3 - Verify & Self-Heal

After each migrated section:
1. `node --check app.js` - syntax check
2. Run CDP test suites: `node /tmp/cdp-test11.mjs` (or relevant subset)
3. Verify every tool end-to-end with real PDF fixtures in `/tmp/fixture*.pdf`
4. Check `git diff` for any logic changes - revert any unintended modifications
5. Verify accessibility: focus rings, contrast ratios, keyboard navigation (Tab/Enter/Esc)
6. Verify dark theme `[data-theme=light]` toggle works and persists in localStorage
7. Verify `prefers-reduced-motion` disables all transitions

---

## Change Log

- All modifications confined to: `index.html`, `styles.css`, and non-logic JS in `app.js` only
- No new runtime dependencies added
- No server calls introduced
- Processing remains 100% client-side
- Files never uploaded