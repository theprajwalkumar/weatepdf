'use strict';

/* ============================================================
   ihatepdf.cv — client-side PDF toolkit (local clone)
   All processing happens in the browser. No uploads.
   ============================================================ */

const PDFJS_WORKER = 'vendor/pdf.worker.min.js';

const state = {
  files: [],
  tool: null,
  lastTool: null,
  pageOps: null,
  busy: false,
  redact: null,
  scans: [],
  camera: null,
  formFields: null,
  edit: null,
  p2p: null,
  wb: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / Math.pow(1024, i);
  return (i === 0 ? String(Math.round(v)) : v.toFixed(2)) + ' ' + units[i];
}

function toast(msg, kind) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'err' ? 'toast-err' : '');
  el.textContent = msg;
  root.appendChild(el);
  window.setTimeout(() => el.remove(), 3600);
}

/* ---------------- binary helpers ---------------- */

async function bytesOf(f) {
  const buf = await f.file.arrayBuffer();
  return new Uint8Array(buf);
}

function pdfBlob(bytes) {
  return new Blob([bytes], { type: 'application/pdf' });
}

function dataUrlToUint8(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

async function loadDoc(f) {
  const bytes = await bytesOf(f);
  return await window.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
}

/* ---------------- pdf.js helpers ---------------- */

function pdfjs() {
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return lib;
}

async function openPdfjs(bytes) {
  return await pdfjs().getDocument({ data: bytes }).promise;
}

async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale: scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: viewport }).promise;
  return canvas;
}

async function imageToPngBytes(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read image: ' + file.name));
      el.src = url;
    });
    const w = img.naturalWidth || img.width || 1000;
    const h = img.naturalHeight || img.height || 1000;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await canvasToBlob(canvas, 'image/png');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------- ranges ---------------- */

function parseRanges(text, max) {
  const parts = String(text || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const out = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    let a;
    let b;
    if (m) { a = parseInt(m[1], 10); b = parseInt(m[2], 10); }
    else { a = parseInt(p, 10); b = a; }
    if (isNaN(a) || isNaN(b)) continue;
    a = Math.max(1, a);
    b = Math.min(max, b);
    if (b < a) continue;
    const indices = [];
    for (let i = a; i <= b; i++) indices.push(i - 1);
    out.push({ start: a, end: b, indices: indices });
  }
  return out;
}

/* ---------------- tool registry ---------------- */

const TOOLS = [
  /* Essentials */
  { id: 'scan-to-pdf', cat: 'essentials', icon: '📷', name: 'Scan Document', desc: 'Use your camera to scan any document and export it as a PDF. 100% on-device.', accept: 'image', multiple: true, action: 'Create Scanned PDF' },
  { id: 'merge-pdf', cat: 'essentials', icon: '🧩', name: 'Merge PDFs', desc: 'Combine multiple PDFs into one document with drag & drop. Unlimited files, no watermark.', accept: 'pdf', multiple: true, action: 'Merge PDFs' },
  { id: 'compress-pdf', cat: 'essentials', icon: '🗜️', name: 'Compress PDF', desc: 'Reduce PDF file size while maintaining quality. Light, Medium and Heavy presets.', accept: 'pdf', action: 'Compress PDF' },
  { id: 'split-pdf', cat: 'essentials', icon: '✂️', name: 'Split PDF', desc: 'Separate a PDF into individual pages or extract specific page ranges. Free and instant.', accept: 'pdf', action: 'Split PDF' },
  { id: 'split-pdf-by-text', cat: 'essentials', icon: '🔤', name: 'Split PDF by Text', desc: 'Start a new file at every page containing a phrase you choose. 100% local.', accept: 'pdf', action: 'Split by Text' },
  { id: 'split-pdf-by-bookmarks', cat: 'essentials', icon: '🔖', name: 'Split PDF by Bookmarks', desc: 'Turn each chapter or bookmarked section into its own PDF file.', accept: 'pdf', action: 'Split by Bookmarks' },
  { id: 'split-pdf-in-half', cat: 'essentials', icon: '➕', name: 'Split PDF in Half', desc: 'Cut a PDF into two files, or slice every page down the middle for book scanning.', accept: 'pdf', action: 'Split in Half' },
  { id: 'split-pdf-by-size', cat: 'essentials', icon: '⚖️', name: 'Split PDF by Size', desc: 'Break a large PDF into parts that each stay under a file size limit.', accept: 'pdf', action: 'Split by Size' },
  { id: 'organize-pages', cat: 'essentials', icon: '🗃️', name: 'Organize Pages', desc: 'Rotate, delete, reorder or rearrange PDF pages easily.', accept: 'pdf', action: 'Save organized PDF' },
  { id: 'rotate-pdf', cat: 'essentials', icon: '🔄', name: 'Rotate PDF', desc: 'Rotate individual pages or the entire PDF — 90°, 180°, 270° — 100% local.', accept: 'pdf', action: 'Rotate PDF' },
  { id: 'flip-pdf', cat: 'essentials', icon: '🪞', name: 'Flip PDF', desc: 'Mirror every page horizontally, vertically or both. 100% local.', accept: 'pdf', action: 'Flip PDF' },
  { id: 'multiple-pages-per-sheet', cat: 'essentials', icon: '🗞️', name: 'Multiple Pages Per Sheet', desc: 'Place 2, 4, 6 or 9 PDF pages on a single sheet to save paper.', accept: 'pdf', action: 'Create N-up PDF' },
  { id: 'crop-resize-pdf', cat: 'essentials', icon: '🔲', name: 'Crop & Resize', desc: 'Trim white margins or resize pages to A4, Letter or A5 — locally.', accept: 'pdf', action: 'Apply Crop & Resize' },
  { id: 'alternate-mix-pdf', cat: 'essentials', icon: '🔀', name: 'Alternate & Mix PDF', desc: 'Interleave the pages of two or more PDFs, one page from each in turn.', accept: 'pdf', multiple: true, action: 'Mix PDFs' },
  { id: 'delete-pdf-pages', cat: 'essentials', icon: '🗑️', name: 'Delete PDF Pages', desc: 'Remove pages by clicking them or typing a range — no upload required.', accept: 'pdf', action: 'Delete Pages' },
  { id: 'extract-pdf-pages', cat: 'essentials', icon: '📤', name: 'Extract PDF Pages', desc: 'Pick pages by clicking them and save them as a new PDF.', accept: 'pdf', action: 'Extract Selected Pages' },
  { id: 'pdf-size-analyzer', cat: 'essentials', icon: '📊', name: 'PDF Size Analyzer', desc: 'See what takes up the space in a PDF — file size, page count and page dimensions.', accept: 'pdf', action: 'Analyze PDF' },
  { id: 'repair-pdf', cat: 'essentials', icon: '🛠️', name: 'Repair PDF', desc: 'Rebuild a damaged PDF file and recover everything that can be read.', accept: 'pdf', action: 'Repair PDF' },
  { id: 'pdf-to-jpg', cat: 'essentials', icon: '🖼️', name: 'PDF to JPG', desc: 'Convert PDF pages to high-quality JPG images — up to 600 DPI.', accept: 'pdf', action: 'Convert to JPG' },
  { id: 'pdf-to-png', cat: 'essentials', icon: '🏞️', name: 'PDF to PNG', desc: 'Render every PDF page as a crisp PNG image at up to 600 DPI.', accept: 'pdf', action: 'Convert to PNG' },
  { id: 'pdf-to-tiff', cat: 'essentials', icon: '🗎', name: 'PDF to TIFF', desc: 'Export PDF pages as a multi-page TIFF image with PackBits compression.', accept: 'pdf', action: 'Convert to TIFF' },
  { id: 'pdf-to-word', cat: 'essentials', icon: '📝', name: 'PDF to Word', desc: 'Convert PDF text into an editable Word (.docx) document. No upload.', accept: 'pdf', action: 'Convert to Word' },
  { id: 'word-to-pdf', cat: 'essentials', icon: '📘', name: 'Word to PDF', desc: 'Convert .doc and .docx files to PDF with formatting, headings and lists preserved.', accept: 'docx', action: 'Convert Word' },
  { id: 'images-to-pdf', cat: 'essentials', icon: '🖼️', name: 'Images to PDF', desc: 'Convert JPG and PNG images to a single PDF. Batch convert multiple images at once.', accept: 'image', multiple: true, action: 'Create PDF from Images' },
  { id: 'png-to-pdf', cat: 'essentials', icon: '🏞️', name: 'PNG to PDF', desc: 'Turn PNG images into a single PDF, one image per page. 100% private.', accept: 'image', multiple: true, action: 'Create PDF from PNGs' },
  { id: 'tiff-to-pdf', cat: 'essentials', icon: '🗎', name: 'TIFF to PDF', desc: 'Convert single or multi-page TIFF images into a PDF document.', accept: 'image', multiple: true, action: 'Convert TIFF to PDF' },
  { id: 'pdf-to-zip', cat: 'essentials', icon: '🗂️', name: 'PDF to ZIP', desc: 'Bundle multiple PDFs into a single compressed ZIP archive — fully local, zero upload.', accept: 'pdf', multiple: true, action: 'Create ZIP' },
  { id: 'workflow', cat: 'essentials', icon: '🔗', name: 'PDF Workflow Builder', desc: 'Upload once, chain multiple operations in sequence — compress, watermark, rotate, number and more.', accept: 'pdf', multiple: true, action: 'Run Workflow' },

  /* Edit & Organize */
  { id: 'edit-pdf-text', cat: 'edit', icon: '✏️', name: 'Edit PDF & add Signature', desc: 'Click any text to edit it in place, add custom text, and insert a signature on any page.', accept: 'pdf', action: 'Apply Edits' },
  { id: 'sign-pdf', cat: 'edit', icon: '✍️', name: 'Sign PDF', desc: 'Draw, type or photograph your signature and place it on any page.', accept: 'pdf', action: 'Sign PDF' },
  { id: 'fill-pdf-form', cat: 'edit', icon: '📋', name: 'Fill PDF Form', desc: 'Fill in AcroForm text fields, checkboxes, dropdowns and radio buttons — right in the browser.', accept: 'pdf', action: 'Save Filled PDF' },
  { id: 'redact-pdf', cat: 'edit', icon: '⬛', name: 'Redact PDF', desc: 'Permanently remove sensitive text and information from PDFs.', accept: 'pdf', action: 'Redact PDF' },
  { id: 'add-watermark', cat: 'edit', icon: '💧', name: 'Add Watermark', desc: 'Protect documents with custom text watermarks. Control opacity and rotation.', accept: 'pdf', action: 'Add Watermark' },
  { id: 'page-numbers', cat: 'edit', icon: '🔢', name: 'Add Page Numbers', desc: 'Automatically number PDF pages with custom formatting, position and start number.', accept: 'pdf', action: 'Add Page Numbers' },
  { id: 'bates-numbering', cat: 'edit', icon: '🔖', name: 'Bates Numbering', desc: 'Stamp sequential Bates numbers across a whole document production.', accept: 'pdf', action: 'Add Bates Numbers' },
  { id: 'headers-footers', cat: 'edit', icon: '📑', name: 'Headers & Footers', desc: 'Add custom headers and footers with text and page numbers.', accept: 'pdf', action: 'Add Headers & Footers' },
  { id: 'flatten-pdf', cat: 'edit', icon: '🧱', name: 'Flatten PDF', desc: 'Make PDFs permanently non-editable by flattening every page into an image.', accept: 'pdf', action: 'Flatten PDF' },
  { id: 'invert-pdf', cat: 'edit', icon: '🌓', name: 'Invert PDF Colours', desc: 'Dark mode, sepia and grayscale colour conversion. 100% local, no upload.', accept: 'pdf', action: 'Apply Colour Mode' },
  { id: 'edit-pdf-metadata', cat: 'edit', icon: '🏷️', name: 'Edit PDF Metadata', desc: 'Read and rewrite the title, author, subject and keywords stored inside a PDF.', accept: 'pdf', action: 'Save Metadata' },
  { id: 'extract-text', cat: 'edit', icon: '📝', name: 'Extract Text', desc: 'Copy text from PDF documents without formatting issues. Works on any PDF with a text layer.', accept: 'pdf', action: 'Extract Text' },
  { id: 'ocr-pdf', cat: 'edit', icon: '🔍', name: 'Searchable PDF', desc: 'Extract text from scanned or image-based PDFs using on-device optical character recognition.', accept: 'pdf', action: 'Run OCR' },
  { id: 'pdf-to-handwriting', cat: 'edit', icon: '🖋️', name: 'PDF to Handwriting', desc: 'Turn a PDF or typed text into realistic handwritten notes.', accept: 'pdf', action: 'Convert to Handwriting' },
  { id: 'text-to-handwriting', cat: 'edit', icon: '📝', name: 'Text to Handwriting', desc: 'Type or paste text and get realistic handwritten notes on ruled paper.', accept: 'none', action: 'Create Handwriting' },
  { id: 'handwriting-to-pdf', cat: 'edit', icon: '🔎', name: 'Handwriting to PDF', desc: 'Convert handwritten pages to typed text with OCR, keeping the original layout.', accept: 'image', multiple: true, action: 'Recognise Handwriting' },
  { id: 'thumbmark-generator', cat: 'edit', icon: '👍', name: 'Thumbmark Maker', desc: 'Photograph your thumbprint and get a clean transparent PNG for forms.', accept: 'image', action: 'Make Thumbmark' },
  { id: 'latex-resume', cat: 'edit', icon: '📄', name: 'Resume Builder', desc: 'Build a resume from a finished template, then take away a PDF or the LaTeX source.', accept: 'none', action: 'Build Resume' },

  /* Security & Privacy */
  { id: 'encrypt-pdf', cat: 'security', icon: '🔐', name: 'Encrypt PDF', desc: 'Password-protect PDFs with strong encryption. 100% free and fully local.', accept: 'pdf', action: 'Encrypt PDF' },
  { id: 'remove-password', cat: 'security', icon: '🔓', name: 'Remove Password', desc: 'Unlock password-protected PDFs and remove encryption securely.', accept: 'pdf', action: 'Remove Password' },
  { id: 'unlock-pdf', cat: 'security', icon: '🔓', name: 'Unlock PDF', desc: 'Remove printing, copying and editing restrictions from a PDF you own.', accept: 'pdf', action: 'Unlock PDF' },
  { id: 'auto-redact-pii', cat: 'security', icon: '🕵️', name: 'Auto-Redact PII', desc: 'Find and permanently remove Aadhaar, PAN, cards, emails and phone numbers.', accept: 'pdf', action: 'Auto-Redact PII' },
  { id: 'privacy-scanner', cat: 'security', icon: '🛡️', name: 'Privacy Risk Scanner', desc: 'Detect Aadhaar, PAN, card numbers and hidden metadata, then export a redacted copy.', accept: 'pdf', action: 'Scan Privacy Risks' },
  { id: 'redaction-checker', cat: 'security', icon: '🔎', name: 'Redaction Checker', desc: 'Check whether blacked-out text in a PDF is really gone or still recoverable.', accept: 'pdf', action: 'Check Redactions' },
  { id: 'fingerprint-pdf', cat: 'security', icon: '🧬', name: 'Fingerprint Generator', desc: 'Add invisible tracking fingerprints and generate SHA-256, SHA-1 and MD5 hashes.', accept: 'pdf', action: 'Fingerprint PDF' },

  /* Convert & Export */
  { id: 'create-pdf', cat: 'convert', icon: '✨', name: 'Create PDF', desc: 'Write rich text with formatting, images and styles — export directly as PDF.', accept: 'none', action: 'Create PDF' },
  { id: 'markdown-to-pdf', cat: 'convert', icon: '⬇️', name: 'Markdown to PDF', desc: 'Convert Markdown documents into beautifully formatted PDFs.', accept: 'text', action: 'Convert Markdown' },
  { id: 'html-to-pdf', cat: 'convert', icon: '🌐', name: 'HTML to PDF', desc: 'Convert HTML files or raw HTML code into professional PDF documents.', accept: 'text', action: 'Convert HTML' },
  { id: 'txt-to-pdf', cat: 'convert', icon: '📄', name: 'TXT to PDF', desc: 'Convert plain-text files to PDF with selectable text in any language.', accept: 'text', action: 'Convert to PDF' },
  { id: 'csv-to-pdf', cat: 'convert', icon: '📊', name: 'CSV ↔ PDF Converter', desc: 'Convert CSV data files into clean, formatted PDF tables. Auto-detects headers.', accept: 'text', action: 'Convert CSV' },
  { id: 'pdf-to-csv', cat: 'convert', icon: '📊', name: 'PDF to CSV', desc: 'Extract tables from PDF text back into a CSV file. Runs entirely locally.', accept: 'pdf', action: 'Convert to CSV' },
  { id: 'excel-to-pdf', cat: 'convert', icon: '📗', name: 'Excel to PDF', desc: 'Convert spreadsheets to PDF — preserves colours, merged cells and formatting.', accept: 'xlsx', action: 'Convert Excel' },
  { id: 'pptx-to-pdf', cat: 'convert', icon: '📙', name: 'PowerPoint to PDF', desc: 'Convert .pptx presentations to PDF — no upload, 100% private.', accept: 'pptx', action: 'Convert PowerPoint' },
  { id: 'pdf-to-pptx', cat: 'convert', icon: '📽️', name: 'PDF to PowerPoint', desc: 'Convert PDF pages into editable .pptx slides. Pixel-perfect, 100% local.', accept: 'pdf', action: 'Convert to PowerPoint' },
  { id: 'pdf-to-excel', cat: 'convert', icon: '📈', name: 'PDF to Excel', desc: 'Extract tables from PDF into editable XLSX spreadsheets — 100% local, no upload.', accept: 'pdf', action: 'Convert to Excel' },
  { id: 'pdf-to-html', cat: 'convert', icon: '🌐', name: 'PDF to HTML', desc: 'Convert PDF text into a clean, semantic HTML document. No upload.', accept: 'pdf', action: 'Convert to HTML' },
  { id: 'pdf-to-epub', cat: 'convert', icon: '📚', name: 'PDF to EPUB', desc: 'Convert PDFs into portable eBook files for any e-reader.', accept: 'pdf', action: 'Convert to EPUB' },
  { id: 'pdf-to-audio', cat: 'convert', icon: '🔊', name: 'PDF to Audio', desc: "Listen to any PDF read aloud using your browser's built-in speech engine.", accept: 'pdf', action: 'Read Aloud' },
  { id: 'ebook-to-pdf', cat: 'convert', icon: '📖', name: 'eBook to PDF', desc: 'Convert EPUB, TXT and HTML eBooks to beautifully typeset PDFs.', accept: 'epub', action: 'Convert eBook' },
  { id: 'audio-to-pdf', cat: 'convert', icon: '🎙️', name: 'Audio to PDF', desc: 'Transcribe audio recordings to a PDF transcript. MP3, WAV and M4A supported.', accept: 'audio', action: 'Transcribe Audio' },
  { id: 'extract-images', cat: 'convert', icon: '🏞️', name: 'Extract Images from PDF', desc: 'Pull the embedded photos and graphics out of a PDF at their original size.', accept: 'pdf', action: 'Extract Images' },

  /* AI Tools */
  { id: 'chat-with-pdf', cat: 'ai', icon: '💬', name: 'Chat with PDF (AI)', desc: 'Ask questions and get answers from your PDF with on-device retrieval — no upload.', accept: 'pdf', action: 'Ask' },
  { id: 'summarize-pdf', cat: 'ai', icon: '🤖', name: 'AI PDF Summarizer', desc: 'Summarize any PDF on-device — bullet points, detailed summary or quick overview.', accept: 'pdf', action: 'Summarize' },
  { id: 'compare-pdfs', cat: 'ai', icon: '🔬', name: 'Compare PDFs', desc: 'View two PDFs side-by-side with sync-scroll and a line-by-line difference report.', accept: 'pdf', multiple: true, action: 'Compare PDFs' },

  /* Scan & Share */
  { id: 'p2p-share', cat: 'share', icon: '📡', name: 'P2P File Share', desc: 'Send any file directly to another browser — no server, no upload, 100% private.', accept: 'any', action: 'Start Sharing' },
  { id: 'collab-whiteboard', cat: 'share', icon: '🎨', name: 'Collab Whiteboard', desc: 'Real-time shared drawing canvas. Share a link and draw together instantly.', accept: 'none', action: 'Open Whiteboard' },

  /* Business Tools */
  { id: 'gst-invoice', cat: 'business', icon: '🧾', name: 'GST Invoice Generator', desc: 'Create legally compliant GST Tax Invoices — CGST, SGST, IGST, HSN codes and totals.', accept: 'none', action: 'Create Invoice' },
  { id: 'pos-billing', cat: 'business', icon: '🛒', name: 'POS Bill Generator', desc: 'Point-of-sale billing for any shop — products, cart, GST and printable receipts.', accept: 'none', action: 'Create Receipt' },
  { id: 'gst-filing-prep', cat: 'business', icon: '🏛️', name: 'GST Filing Prep', desc: 'Compress and split compiled PDFs to meet GST portal upload limits.', accept: 'pdf', action: 'Prepare Upload Files' },
];

const CATEGORIES = [
  { id: 'essentials', title: 'Essentials', icon: '⭐' },
  { id: 'edit', title: 'Edit & Organize', icon: '✏️' },
  { id: 'security', title: 'Security & Privacy', icon: '🔐' },
  { id: 'convert', title: 'Convert & Export', icon: '🔄' },
  { id: 'ai', title: 'AI Tools', icon: '🤖' },
  { id: 'share', title: 'Scan & Share', icon: '📡' },
  { id: 'business', title: 'Business Tools', icon: '🧾' },
];

const categoryOf = (tool) => CATEGORIES.find((c) => c.id === (tool && tool.cat)) || null;

const toolById = (id) => TOOLS.find((t) => t.id === id) || null;

/* ---------------- routing ---------------- */

function currentRoute() {
  const h = (location.hash || '#/').replace(/^#\/?/, '');
  return h || 'home';
}

/* ---------------- home ---------------- */

function homeHtml() {
  return `
    <section class="hero">
      <h1>Free Online PDF Editor<br /><span class="hl">Without Watermark</span></h1>
      <p class="tagline">Edit, merge, split, compress, and convert PDFs instantly in your browser.
        <strong>100% free, no watermark, no sign-up required</strong> — your files never leave your device.</p>
      <ul class="badges">
        <li><span class="dot"></span>No watermark ever</li>
        <li><span class="dot"></span>Files stay on your device</li>
        <li><span class="dot"></span>Works offline</li>
        <li><span class="dot"></span>No sign-up required</li>
        <li><span class="dot"></span>100% free forever</li>
        <li><span class="dot"></span>${TOOLS.length}+ tools</li>
      </ul>
    </section>

    <div class="home-upload">
      <div class="dropzone" id="dz">
        <input type="file" id="file-input" class="dz-input" multiple accept="application/pdf,.pdf" />
        <div class="dz-icon">📄</div>
        <p class="dz-title">Upload PDF files</p>
        <p class="dz-sub">Drag &amp; drop files here, or <span class="link">click to browse</span></p>
        <p class="dz-hint">Opens the Merge tool · 100% private · no file size limits</p>
      </div>
    </div>

    <div class="tool-tabs" id="tool-tabs" role="tablist">
      <button class="tab active" data-cat="all" role="tab">All <span class="tab-count">${TOOLS.length}</span></button>
      ${CATEGORIES.map((cat) => `
        <button class="tab" data-cat="${cat.id}" role="tab">${cat.title} <span class="tab-count">${TOOLS.filter((t) => t.cat === cat.id).length}</span></button>
      `).join('')}
    </div>

    ${CATEGORIES.map((cat) => `
      <section class="category" id="cat-${cat.id}" data-cat="${cat.id}">
        <h2>${cat.title}</h2>
        <div class="grid">
          ${TOOLS.filter((t) => t.cat === cat.id).map((t) => `
            <a class="card" href="#/${t.id}">
              <p class="c-name"><span class="c-ic">${t.icon}</span><span>${t.name}</span></p>
              <p class="c-desc">${t.desc}</p>
            </a>
          `).join('')}
        </div>
      </section>
    `).join('')}

    <section class="why">
      <h2>Why weatepdf?</h2>
      <p>Most “free” online PDF editors add watermarks to your output files or lock useful features behind a paid subscription.
        <strong>weatepdf is different.</strong> Every tool is 100% free, forever, with no watermark added to any file you produce.</p>
      <p>There are no daily limits, no file size caps, and no account required. All PDF processing happens locally in your
        web browser using JavaScript and WebAssembly. <strong>Your files are never uploaded to any server</strong> — they never leave your device.</p>
    </section>
  `;
}

/* ---------------- tool page ---------------- */

function dropzoneAccept(t) {
  if (t.accept === 'image') return 'image/*,.tif,.tiff';
  if (t.accept === 'text') return '.md,.markdown,.txt,.csv,.html,.htm,text/*';
  if (t.accept === 'docx') return '.docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword';
  if (t.accept === 'xlsx') return '.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
  if (t.accept === 'pptx') return '.pptx,.ppt,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint';
  if (t.accept === 'epub') return '.epub,.txt,.html,.htm,application/epub+zip';
  if (t.accept === 'audio') return 'audio/*,.mp3,.wav,.m4a,.ogg,.webm';
  if (t.accept === 'any') return '';
  return 'application/pdf,.pdf';
}

function dropzoneTitle(t) {
  if (t.accept === 'image') return 'Upload images';
  if (t.accept === 'text') return 'Upload ' + (t.id === 'markdown-to-pdf' ? 'a Markdown file' : t.id === 'csv-to-pdf' ? 'a CSV file' : t.id === 'html-to-pdf' ? 'an HTML file' : 'a text file');
  if (t.accept === 'docx') return 'Upload a Word document';
  if (t.accept === 'xlsx') return 'Upload a spreadsheet';
  if (t.accept === 'pptx') return 'Upload a presentation';
  if (t.accept === 'epub') return 'Upload an eBook';
  if (t.accept === 'audio') return 'Upload an audio file';
  if (t.accept === 'any') return 'Upload a file to share';
  const map = {
    'merge-pdf': 'Upload PDFs to Merge',
    'compress-pdf': 'Upload PDF to Compress',
    'split-pdf': 'Upload PDF to Split',
    'pdf-to-jpg': 'Upload PDF to convert to JPG',
    'pdf-to-png': 'Upload PDF to convert to PNG',
    'pdf-to-html': 'Upload PDF to convert to HTML',
    'pdf-to-word': 'Upload PDF to convert to Word',
    'pdf-to-tiff': 'Upload PDF to convert to TIFF',
    'pdf-to-excel': 'Upload PDF to convert to Excel',
    'pdf-to-zip': 'Upload PDFs to bundle into one ZIP',
    'organize-pages': 'Upload PDF to organize',
    'rotate-pdf': 'Upload PDF to rotate',
    'extract-pdf-pages': 'Upload PDF to extract pages',
    'delete-pdf-pages': 'Upload PDF to delete pages',
    'add-watermark': 'Upload PDF to watermark',
    'page-numbers': 'Upload PDF to number pages',
    'headers-footers': 'Upload PDF to add headers & footers',
    'bates-numbering': 'Upload PDF to add Bates numbers',
    'edit-pdf-metadata': 'Upload PDF to edit its metadata',
    'extract-text': 'Upload PDF to extract text',
    'ocr-pdf': 'Upload scanned PDF for OCR',
    'invert-pdf': 'Upload PDF to recolour',
    'flatten-pdf': 'Upload PDF to flatten',
    'pdf-size-analyzer': 'Upload PDF to analyze its size',
    'alternate-mix-pdf': 'Upload PDFs to alternate & mix',
    'flip-pdf': 'Upload PDF to flip',
    'repair-pdf': 'Upload PDF to repair',
    'crop-resize-pdf': 'Upload PDF to crop or resize',
    'sign-pdf': 'Upload PDF to sign',
    'fill-pdf-form': 'Upload a PDF with form fields',
    'compare-pdfs': 'Upload the two PDFs to compare',
    'scan-to-pdf': 'Upload photos or start your camera',
    'split-pdf-by-text': 'Upload PDF to split by text',
    'split-pdf-by-bookmarks': 'Upload a PDF with bookmarks',
    'split-pdf-in-half': 'Upload PDF to split in half',
    'split-pdf-by-size': 'Upload PDF to split by size',
    'word-to-pdf': 'Upload a Word document (.docx)',
    'png-to-pdf': 'Upload PNG images',
    'tiff-to-pdf': 'Upload TIFF images',
    'workflow': 'Upload PDFs to process',
    'edit-pdf-text': 'Upload PDF to edit text',
    'pdf-to-handwriting': 'Upload PDF to convert to handwriting',
    'handwriting-to-pdf': 'Upload photos of handwritten pages',
    'thumbmark-generator': 'Upload a thumbprint photo',
    'encrypt-pdf': 'Upload PDF to encrypt',
    'unlock-pdf': 'Upload a restricted PDF',
    'auto-redact-pii': 'Upload PDF to auto-redact PII',
    'privacy-scanner': 'Upload PDF to scan for private data',
    'redaction-checker': 'Upload PDF to check redactions',
    'fingerprint-pdf': 'Upload PDF to fingerprint',
    'pdf-to-csv': 'Upload PDF to convert to CSV',
    'excel-to-pdf': 'Upload a spreadsheet (.xlsx)',
    'pptx-to-pdf': 'Upload a presentation (.pptx)',
    'pdf-to-pptx': 'Upload PDF to convert to PowerPoint',
    'pdf-to-epub': 'Upload PDF to convert to EPUB',
    'pdf-to-audio': 'Upload PDF to read aloud',
    'ebook-to-pdf': 'Upload an eBook (.epub, .txt, .html)',
    'audio-to-pdf': 'Upload an audio recording',
    'extract-images': 'Upload PDF to extract its images',
    'chat-with-pdf': 'Upload PDF to ask questions',
    'summarize-pdf': 'Upload PDF to summarize',
    'p2p-share': 'Choose a file to send',
    'gst-filing-prep': 'Upload the compiled GST PDF',
    'redact-pdf': 'Upload PDF to redact',
    'remove-password': 'Upload a password-protected PDF',
  };
  return map[t.id] || 'Upload PDF';
}

function optionsHtml(t) {
  switch (t.id) {
    case 'scan-to-pdf':
      return `
        <div class="panel">
          <div class="scan-actions">
            <button class="btn" id="scan-camera" type="button">📷 Start camera</button>
            <button class="btn hidden" id="scan-capture" type="button">⬤ Capture page</button>
            <button class="btn hidden" id="scan-stop" type="button">Stop camera</button>
          </div>
          <video id="scan-video" class="scan-video hidden" playsinline muted></video>
          <div class="row" style="margin-top:14px;">
            <div class="field">
              <label for="opt-scan-filter">Colour mode</label>
              <select id="opt-scan-filter">
                <option value="colour">Colour</option>
                <option value="grayscale">Grayscale</option>
                <option value="bw" selected>Black &amp; white (document)</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-scan-size">Page size</label>
              <select id="opt-scan-size">
                <option value="a4" selected>A4 — fit image to page</option>
                <option value="fit">Page matches the image</option>
              </select>
            </div>
          </div>
          <div id="scan-thumbs" class="scan-thumbs"></div>
        </div>`;
    case 'crop-resize-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-cr-mode">Mode</label>
              <select id="opt-cr-mode">
                <option value="crop">Crop margins</option>
                <option value="resize">Resize pages</option>
              </select>
            </div>
          </div>
          <div class="row" id="cr-crop-opts" style="margin-top:12px;">
            <div class="field"><label for="opt-cr-top">Top (mm)</label><input type="number" id="opt-cr-top" value="10" min="0" max="150" /></div>
            <div class="field"><label for="opt-cr-right">Right (mm)</label><input type="number" id="opt-cr-right" value="10" min="0" max="150" /></div>
            <div class="field"><label for="opt-cr-bottom">Bottom (mm)</label><input type="number" id="opt-cr-bottom" value="10" min="0" max="150" /></div>
            <div class="field"><label for="opt-cr-left">Left (mm)</label><input type="number" id="opt-cr-left" value="10" min="0" max="150" /></div>
          </div>
          <div class="row hidden" id="cr-resize-opts" style="margin-top:12px;">
            <div class="field">
              <label for="opt-cr-size">Target page size</label>
              <select id="opt-cr-size">
                <option value="a4">A4 (595 × 842 pt)</option>
                <option value="letter">Letter (612 × 792 pt)</option>
                <option value="a5">A5 (420 × 595 pt)</option>
              </select>
            </div>
            <div class="field">
              <label class="check-row"><input type="checkbox" id="opt-cr-keep" checked /> Keep aspect ratio and centre the content</label>
            </div>
          </div>
        </div>`;
    case 'sign-pdf':
      return `
        <div class="panel">
          <label class="field-label">Draw your signature</label>
          <div class="sig-wrap"><canvas id="sig-pad" width="560" height="180"></canvas></div>
          <div class="row" style="margin-top:12px;">
            <div class="field">
              <label for="opt-sig-typed">…or type your name</label>
              <input type="text" id="opt-sig-typed" placeholder="Ada Lovelace" autocomplete="off" />
            </div>
            <div class="field" style="flex:0 0 auto;">
              <label>&nbsp;</label>
              <button class="btn" id="sig-clear" type="button">Clear signature</button>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-sig-page">Place on</label>
              <select id="opt-sig-page">
                <option value="last">Last page</option>
                <option value="first">First page</option>
                <option value="all">Every page</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-sig-pos">Position</label>
              <select id="opt-sig-pos">
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-center">Bottom centre</option>
                <option value="top-right">Top right</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-sig-width">Signature width (pt)</label>
              <input type="number" id="opt-sig-width" value="170" min="40" max="500" />
            </div>
          </div>
        </div>`;
    case 'fill-pdf-form':
      return `
        <div class="panel">
          <div id="form-fields"><p class="muted" style="margin:0;">Upload a PDF with form fields to fill it in.</p></div>
          <label class="check-row" style="padding-top:14px;"><input type="checkbox" id="opt-form-flatten" /> Flatten the form so the values can no longer be edited</label>
        </div>`;
    case 'compare-pdfs':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Add exactly two PDFs — the first is treated as the “before” document and the second as the “after”. The comparison works on the extracted text, line by line, and produces an HTML report plus a plain-text diff.</p></div>`;
    case 'redact-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-redact-terms">Also redact these words (comma separated)</label>
              <input type="text" id="opt-redact-terms" placeholder="John Smith, 123-45-6789" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-redact-flatten" checked /> Flatten pages — removes the hidden text underneath</label>
            </div>
          </div>
        </div>
        <div class="panel">
          <div class="redact-head">
            <span class="muted">Drag on the page to draw a redaction box.</span>
            <span class="redact-nav">
              <button class="icon-btn" id="redact-prev" type="button" title="Previous page">←</button>
              <span id="redact-page-label">Page 1</span>
              <button class="icon-btn" id="redact-next" type="button" title="Next page">→</button>
              <button class="btn btn-sm" id="redact-clear" type="button">Clear page</button>
            </span>
          </div>
          <div id="redact-stage" class="redact-stage"><p class="muted">Upload a PDF to preview pages.</p></div>
        </div>`;
    case 'remove-password':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-pw-password">Document password</label>
              <input type="password" id="opt-pw-password" placeholder="Leave blank if there is no open password" autocomplete="off" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-pw-rasterize" /> Always rebuild pages as images</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">The password stays in this tab and is never sent anywhere. Encrypted pages are rebuilt as images, so the text layer is not preserved.</p>
        </div>`;
    case 'pdf-to-word':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Creates an editable .docx with one paragraph per line of PDF text. Complex layouts, tables and images are not reproduced.</p></div>`;
    case 'pdf-to-tiff':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-tiff-dpi">Resolution</label>
              <select id="opt-tiff-dpi">
                <option value="150" selected>150 DPI — balanced</option>
                <option value="300">300 DPI — maximum (large file)</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'pdf-to-excel':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-xlsx-mode">Cell layout</label>
              <select id="opt-xlsx-mode">
                <option value="items" selected>One cell per text item</option>
                <option value="lines">Whole line in one cell</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'pdf-size-analyzer':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Reports the file size, page count and page dimensions. Nothing is changed.</p></div>`;
    case 'alternate-mix-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Add two or more PDFs. Pages are taken one at a time from each file — front 1, back 1, front 2, back 2…</p></div>`;
    case 'flip-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-flip-direction">Direction</label>
              <select id="opt-flip-direction">
                <option value="horizontal">Horizontal — mirror left ↔ right</option>
                <option value="vertical">Vertical — mirror top ↕ bottom</option>
                <option value="both">Both</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'multiple-pages-per-sheet':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-nup">Pages per sheet</label>
              <select id="opt-nup">
                <option value="2">2 pages</option>
                <option value="4" selected>4 pages</option>
                <option value="6">6 pages</option>
                <option value="9">9 pages</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-nup-size">Sheet size</label>
              <select id="opt-nup-size">
                <option value="a4">A4 landscape</option>
                <option value="letter">Letter landscape</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'repair-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Rebuilds the PDF structure and cross-reference table. Works best on files that still open partially.</p></div>`;
    case 'flatten-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Every page is rendered into a high-resolution image, so text and annotations can no longer be edited.</p></div>`;
    case 'pdf-to-html':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Exports a semantic HTML document with the text from each page. This is not a pixel-perfect layout copy.</p></div>`;
    case 'edit-pdf-metadata':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-meta-title">Title</label>
              <input type="text" id="opt-meta-title" placeholder="Document title" />
            </div>
            <div class="field">
              <label for="opt-meta-author">Author</label>
              <input type="text" id="opt-meta-author" placeholder="Author name" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field">
              <label for="opt-meta-subject">Subject</label>
              <input type="text" id="opt-meta-subject" placeholder="Subject" />
            </div>
            <div class="field">
              <label for="opt-meta-keywords">Keywords</label>
              <input type="text" id="opt-meta-keywords" placeholder="comma, separated, keywords" />
            </div>
          </div>
        </div>`;
    case 'headers-footers':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-hf-header">Header text</label>
              <input type="text" id="opt-hf-header" placeholder="Company name" />
            </div>
            <div class="field">
              <label for="opt-hf-footer">Footer text</label>
              <input type="text" id="opt-hf-footer" placeholder="Internal use only" />
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field">
              <label for="opt-hf-size">Font size</label>
              <input type="number" id="opt-hf-size" value="9" min="6" max="24" />
            </div>
            <div class="field">
              <label class="check-row"><input type="checkbox" id="opt-hf-numbers" checked /> Include page numbers in the footer</label>
            </div>
          </div>
        </div>`;
    case 'bates-numbering':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-bates-prefix">Prefix</label>
              <input type="text" id="opt-bates-prefix" placeholder="ABC-" />
            </div>
            <div class="field">
              <label for="opt-bates-start">Start at</label>
              <input type="number" id="opt-bates-start" value="1" min="0" />
            </div>
            <div class="field">
              <label for="opt-bates-digits">Digits</label>
              <input type="number" id="opt-bates-digits" value="6" min="1" max="12" />
            </div>
            <div class="field">
              <label for="opt-bates-pos">Position</label>
              <select id="opt-bates-pos">
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-center">Bottom center</option>
                <option value="bottom-left">Bottom left</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'compress-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-preset">Compression preset</label>
              <select id="opt-preset">
                <option value="light">Light — keeps quality (re-save)</option>
                <option value="medium">Medium — balanced</option>
                <option value="heavy">Heavy — smallest file</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'split-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-mode">Split mode</label>
              <select id="opt-mode">
                <option value="pages">Split into single pages</option>
                <option value="ranges">Split by page ranges</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-ranges">Page ranges (e.g. 1-3, 5, 8-11)</label>
              <input type="text" id="opt-ranges" placeholder="1-3, 5, 8-11" />
            </div>
          </div>
        </div>`;
    case 'pdf-to-jpg':
    case 'pdf-to-png':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-dpi">Resolution</label>
              <select id="opt-dpi">
                <option value="150">150 DPI — fast</option>
                <option value="300" selected>300 DPI — high quality</option>
                <option value="600">600 DPI — maximum (slow)</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'pdf-to-zip':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">All selected PDFs are packed into one ZIP archive on your device.</p></div>`;
    case 'rotate-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-angle">Rotation</label>
              <select id="opt-angle">
                <option value="90">90° clockwise</option>
                <option value="180">180°</option>
                <option value="270">270° clockwise</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'organize-pages':
    case 'extract-pdf-pages':
      return `
        <div class="panel">
          <label style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">
            ${t.id === 'organize-pages' ? 'Pages — reorder, rotate or delete' : 'Select pages to keep'}
          </label>
          <div id="${t.id === 'organize-pages' ? 'page-ops' : 'page-checks'}" class="page-grid">
            <p class="muted">Upload a PDF to list its pages.</p>
          </div>
        </div>`;
    case 'delete-pdf-pages':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-del-ranges">Pages to delete (e.g. 2, 5-7)</label>
              <input type="text" id="opt-del-ranges" placeholder="2, 5-7" />
            </div>
          </div>
        </div>`;
    case 'add-watermark':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-wm-text">Watermark text</label>
              <input type="text" id="opt-wm-text" placeholder="CONFIDENTIAL" value="CONFIDENTIAL" />
            </div>
            <div class="field">
              <label for="opt-wm-angle">Rotation</label>
              <select id="opt-wm-angle"><option value="-45">Diagonal (-45°)</option><option value="0">Horizontal</option><option value="90">Vertical</option></select>
            </div>
            <div class="field">
              <label for="opt-wm-opacity">Opacity</label>
              <input type="range" id="opt-wm-opacity" min="0.05" max="0.6" step="0.05" value="0.2" />
            </div>
          </div>
        </div>`;
    case 'page-numbers':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-pn-pos">Position</label>
              <select id="opt-pn-pos">
                <option value="bottom-center">Bottom center</option>
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-center">Top center</option>
                <option value="top-right">Top right</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-pn-start">Start at</label>
              <input type="number" id="opt-pn-start" value="1" min="1" />
            </div>
          </div>
        </div>`;
    case 'invert-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-invert">Colour mode</label>
              <select id="opt-invert">
                <option value="invert">Dark mode (invert)</option>
                <option value="grayscale">Grayscale</option>
                <option value="sepia">Sepia</option>
              </select>
            </div>
          </div>
        </div>`;
    case 'ocr-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Pages are rendered locally and recognised with Tesseract OCR (English). You'll get a text transcript to download.</p></div>`;
    case 'extract-text':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Reads the text layer of the PDF locally and returns a plain-text transcript.</p></div>`;
    case 'create-pdf':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">Your content</label><textarea id="text-input" placeholder="Write anything — this becomes a paginated A4 PDF."></textarea></div>`;
    case 'markdown-to-pdf':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">Markdown</label><textarea id="text-input" placeholder="# Hello&#10;&#10;Some **bold** and *italic* text.&#10;&#10;- item one&#10;- item two"></textarea></div>`;
    case 'csv-to-pdf':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">CSV data</label><textarea id="text-input" placeholder="Name,Role,Score&#10;Ada,Engineer,98&#10;Linus,Maintainer,95"></textarea></div>`;
    case 'txt-to-pdf':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">Plain text</label><textarea id="text-input" placeholder="Paste your text here…"></textarea></div>`;
    case 'html-to-pdf':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">HTML</label><textarea id="text-input" placeholder="<h1>Hello</h1>&#10;<p>Your HTML here…</p>"></textarea></div>`;
    case 'split-pdf-by-text':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-sbt-text">Start a new file at pages containing</label>
              <input type="text" id="opt-sbt-text" placeholder="Chapter, Invoice #, Name…" />
            </div>
            <div class="field">
              <label for="opt-sbt-mode">Split behaviour</label>
              <select id="opt-sbt-mode">
                <option value="before">The matching page starts the new file</option>
                <option value="after">The matching page ends the current file</option>
              </select>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Matching is case-insensitive and ignores extra spaces. If nothing matches, you get the original PDF back.</p>
        </div>`;
    case 'split-pdf-by-bookmarks':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-bookmarks-top" checked /> Top-level bookmarks only</label>
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-bookmarks-merge" /> Put all chapters in one PDF with a page break</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Uses the PDF’s own outline (bookmarks). A PDF without bookmarks cannot be split this way.</p>
        </div>`;
    case 'split-pdf-in-half':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-half-mode">Mode</label>
              <select id="opt-half-mode">
                <option value="two">Two files — first half and second half</option>
                <option value="slice">Slice every page down the middle</option>
              </select>
            </div>
            <div class="field" id="half-slice-opts">
              <label for="opt-half-dir">Slice direction</label>
              <select id="opt-half-dir">
                <option value="vertical">Vertical — left and right halves</option>
                <option value="horizontal">Horizontal — top and bottom halves</option>
              </select>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Slicing rebuilds each half on its own page, which is ideal for scanned book spreads.</p>
        </div>`;
    case 'split-pdf-by-size':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-size-limit">Maximum size per part (MB)</label>
              <input type="number" id="opt-size-limit" value="5" min="0.1" step="0.1" />
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-size-compress" /> Compress pages as images first (smaller, no text layer)</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Pages are packed into sequential parts until the limit is reached. A single page larger than the limit becomes its own part.</p>
        </div>`;
    case 'word-to-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Reads .docx locally and keeps headings, paragraphs and bullet lists. Complex layouts, text boxes and embedded objects may look simpler than in Word. Legacy .doc files must be saved as .docx first.</p></div>`;
    case 'png-to-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Each PNG becomes one page at its native size, in the order shown above.</p></div>`;
    case 'tiff-to-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Supports multi-page TIFF with uncompressed, PackBits or LZW data. Each TIFF page becomes one PDF page.</p></div>`;
    case 'workflow':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-wf-merge" checked /> Merge all uploaded PDFs first</label>
            </div>
            <div class="field">
              <label for="opt-wf-rotate">Rotate</label>
              <select id="opt-wf-rotate">
                <option value="0">No rotation</option>
                <option value="90">90° clockwise</option>
                <option value="180">180°</option>
                <option value="270">270° clockwise</option>
              </select>
            </div>
            <div class="field">
              <label for="opt-wf-watermark">Watermark text (optional)</label>
              <input type="text" id="opt-wf-watermark" placeholder="CONFIDENTIAL" />
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-wf-numbers" checked /> Add page numbers</label>
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-wf-flatten" /> Flatten to images</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Steps run in this order: merge → rotate → watermark → page numbers → flatten. Everything happens on this device.</p>
        </div>`;
    case 'edit-pdf-text':
      return `
        <div class="panel">
          <div class="redact-head">
            <span class="muted">Click a highlighted line to replace its text.</span>
            <span class="redact-nav">
              <button class="icon-btn" id="et-prev" type="button" title="Previous page">←</button>
              <span id="et-page-label">Page 1</span>
              <button class="icon-btn" id="et-next" type="button" title="Next page">→</button>
              <button class="btn btn-sm" id="et-clear" type="button">Reset edits</button>
            </span>
          </div>
          <div id="et-stage" class="redact-stage"><p class="muted">Upload a PDF to preview pages.</p></div>
          <div id="et-editor" class="et-editor"></div>
        </div>
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-et-add">Add new text</label>
              <input type="text" id="opt-et-add" placeholder="Text to add to the last page" />
            </div>
            <div class="field">
              <label for="opt-et-add-pos">Position</label>
              <select id="opt-et-add-pos">
                <option value="bottom">Bottom of the last page</option>
                <option value="top">Top of the last page</option>
              </select>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Edited lines are covered with a white patch and redrawn with Helvetica. Complex fonts, colours and multi-column layouts may shift slightly.</p>
        </div>`;
    case 'pdf-to-handwriting':
      return handwritingOptions();
    case 'text-to-handwriting':
      return `<div class="panel"><label for="text-input" style="display:block;font-size:13px;font-weight:650;color:var(--muted);margin-bottom:8px;">Text to write out</label><textarea id="text-input" placeholder="Type or paste the notes you want in handwriting…"></textarea></div>${handwritingOptions()}`;
    case 'handwriting-to-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-hw-lang">OCR language</label>
              <select id="opt-hw-lang">
                <option value="eng" selected>English</option>
                <option value="hin">Hindi</option>
                <option value="spa">Spanish</option>
                <option value="fra">French</option>
                <option value="deu">German</option>
              </select>
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-hw-image" /> Include the original photo alongside the text</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Handwriting recognition quality depends on the photo. You get a typed PDF transcript plus a plain-text copy.</p>
        </div>`;
    case 'thumbmark-generator':
      return `
        <div class="panel">
          <div class="row">
            <div class="field">
              <label for="opt-thumb-threshold">Background removal threshold</label>
              <input type="range" id="opt-thumb-threshold" min="40" max="230" step="1" value="150" />
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-thumb-invert" /> White ink (for dark forms)</label>
            </div>
            <div class="field">
              <label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-thumb-bg" checked /> Remove background (transparent PNG)</label>
            </div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">The image is cropped to the print and exported as a transparent PNG you can place over a form.</p>
        </div>`;
    case 'latex-resume':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-cv-name">Full name</label><input type="text" id="opt-cv-name" placeholder="Ada Lovelace" /></div>
            <div class="field"><label for="opt-cv-role">Headline / role</label><input type="text" id="opt-cv-role" placeholder="Software Engineer" /></div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label for="opt-cv-email">Email</label><input type="text" id="opt-cv-email" placeholder="ada@example.com" /></div>
            <div class="field"><label for="opt-cv-phone">Phone</label><input type="text" id="opt-cv-phone" placeholder="+91 90000 00000" /></div>
            <div class="field"><label for="opt-cv-location">Location</label><input type="text" id="opt-cv-location" placeholder="Bengaluru, India" /></div>
          </div>
          <div class="field" style="margin-top:12px;"><label for="opt-cv-summary">Summary</label><textarea id="opt-cv-summary" placeholder="Two or three lines about you…"></textarea></div>
          <div class="field" style="margin-top:12px;"><label for="opt-cv-experience">Experience — one per line: Company | Role | Dates | Achievement</label><textarea id="opt-cv-experience" placeholder="Acme | Senior Engineer | 2022–Now | Led the PDF platform&#10;Globex | Engineer | 2019–2022 | Built the billing pipeline"></textarea></div>
          <div class="field" style="margin-top:12px;"><label for="opt-cv-education">Education — one per line: School | Degree | Dates</label><textarea id="opt-cv-education" placeholder="IIT | B.Tech Computer Science | 2015–2019"></textarea></div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label for="opt-cv-skills">Skills (comma separated)</label><input type="text" id="opt-cv-skills" placeholder="JavaScript, TypeScript, Python" /></div>
            <div class="field"><label for="opt-cv-template">Template</label><select id="opt-cv-template"><option value="classic">Classic LaTeX</option><option value="modern">Modern sidebar-free</option></select></div>
          </div>
        </div>`;
    case 'encrypt-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-enc-user">Open password (required)</label><input type="password" id="opt-enc-user" placeholder="Password to open the PDF" autocomplete="new-password" /></div>
            <div class="field"><label for="opt-enc-owner">Owner password (optional)</label><input type="password" id="opt-enc-owner" placeholder="Defaults to the open password" autocomplete="new-password" /></div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-enc-print" checked /> Allow printing</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-enc-copy" /> Allow copying text</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-enc-modify" /> Allow editing</label></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Pages are rebuilt as images, then encrypted with AES-capable PDF encryption from jsPDF. The text layer is not preserved.</p>
        </div>`;
    case 'unlock-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-unlock-password">Open password (leave blank if none)</label><input type="password" id="opt-unlock-password" placeholder="Password" autocomplete="off" /></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Removes printing, copying and editing restrictions from files you own. If the file is encrypted, pages are rebuilt as images.</p>
        </div>`;
    case 'auto-redact-pii':
    case 'privacy-scanner':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="aadhaar" checked /> Aadhaar numbers</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="pan" checked /> PAN numbers</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="card" checked /> Card numbers</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="email" checked /> Email addresses</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="phone" checked /> Phone numbers</label></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" data-pii="ifsc" /> IFSC / bank codes</label></div>
          </div>
          <div class="field" style="margin-top:12px;"><label for="opt-pii-extra">Extra words to find (comma separated)</label><input type="text" id="opt-pii-extra" placeholder="Project Falcon, 10.0.0.42" /></div>
          ${t.id === 'privacy-scanner' ? '<div class="field" style="margin-top:12px;"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-pii-export" checked /> Export a redacted copy as well as the report</label></div>' : '<p class="muted" style="margin:12px 0 0;font-size:12.5px;">Matched text is covered and the page is flattened, so the original characters cannot be recovered.</p>'}
        </div>`;
    case 'redaction-checker':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Looks for text that is still present underneath opaque black boxes. A clean redaction should leave no recoverable text.</p></div>`;
    case 'fingerprint-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-fp-label">Recipient / copy label</label><input type="text" id="opt-fp-label" placeholder="Copy for Legal" /></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-fp-hidden" checked /> Embed an invisible fingerprint on every page</label></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Adds a unique invisible marker plus metadata, then returns SHA-256, SHA-1 and MD5 hashes of the output so you can verify the copy later.</p>
        </div>`;
    case 'pdf-to-csv':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-csv-mode">Layout</label><select id="opt-csv-mode"><option value="lines">One row per text line</option><option value="items">One cell per text item</option></select></div>
            <div class="field"><label for="opt-csv-delim">Delimiter</label><select id="opt-csv-delim"><option value=",">Comma</option><option value=";">Semicolon</option><option value="\t">Tab</option></select></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Text is grouped by its vertical position. Scanned PDFs need OCR first.</p>
        </div>`;
    case 'excel-to-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-xlsx-orient">Page orientation</label><select id="opt-xlsx-orient"><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-xlsx-grid" checked /> Include grid lines</label></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Reads every sheet from the .xlsx and renders the used cells as tables. Formulas are shown as their last saved values.</p>
        </div>`;
    case 'pptx-to-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Extracts the text from every .pptx slide and lays it out as a 16:9 PDF page. Images and animations are not reproduced.</p></div>`;
    case 'pdf-to-pptx':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-pptx-dpi">Slide resolution</label><select id="opt-pptx-dpi"><option value="150" selected>150 DPI — balanced</option><option value="300">300 DPI — sharp (large file)</option></select></div>
            <div class="field"><label for="opt-pptx-ratio">Slide size</label><select id="opt-pptx-ratio"><option value="16:9" selected>16:9 widescreen</option><option value="4:3">4:3 classic</option></select></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Each PDF page becomes a picture slide at its original aspect ratio, centred on the slide.</p>
        </div>`;
    case 'pdf-to-epub':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-epub-title">Book title</label><input type="text" id="opt-epub-title" placeholder="Defaults to the PDF name" /></div>
            <div class="field"><label for="opt-epub-author">Author</label><input type="text" id="opt-epub-author" placeholder="Author" /></div>
          </div>
        </div>`;
    case 'pdf-to-audio':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-audio-voice">Voice</label><select id="opt-audio-voice"><option value="">System default</option></select></div>
            <div class="field"><label for="opt-audio-rate">Speed</label><select id="opt-audio-rate"><option value="0.85">Slower</option><option value="1" selected>Normal</option><option value="1.25">Faster</option><option value="1.5">Fast</option></select></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-audio-speak" checked /> Start reading as soon as it is ready</label></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Uses the speech voices built into your browser. Only the first 20,000 characters are spoken; the full transcript is downloaded.</p>
        </div>`;
    case 'ebook-to-pdf':
      return `<div class="panel"><p class="muted" style="margin:0;font-size:13.5px;">Reads EPUB, HTML and TXT books and typesets them as a paginated PDF. EPUB styles, images and DRM are not reproduced.</p></div>`;
    case 'audio-to-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-audio-lang">Spoken language</label><select id="opt-audio-lang"><option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option></select></div>
            <div class="field"><label for="opt-audio-title">Transcript title</label><input type="text" id="opt-audio-title" placeholder="Meeting transcript" /></div>
          </div>
          <div class="field" style="margin-top:12px;"><label for="opt-audio-manual">Already have a transcript? Paste it here to skip transcription</label><textarea id="opt-audio-manual" placeholder="Optional — paste a transcript…"></textarea></div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Transcription uses the Whisper tiny model downloaded on demand (about 40 MB) and runs entirely in this tab. Your audio is never uploaded.</p>
        </div>`;
    case 'extract-images':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-img-min">Ignore images smaller than (px)</label><input type="number" id="opt-img-min" value="40" min="0" /></div>
            <div class="field"><label for="opt-img-format">Format</label><select id="opt-img-format"><option value="png">PNG</option><option value="jpg">JPG</option></select></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Images are exported at their embedded resolution. When more than one image is found you get a ZIP archive.</p>
        </div>`;
    case 'chat-with-pdf':
      return `
        <div class="panel">
          <div class="field"><label for="opt-chat-question">Your question</label><textarea id="opt-chat-question" placeholder="What does the document say about refunds?"></textarea></div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label for="opt-chat-passages">Passages to return</label><select id="opt-chat-passages"><option value="2">2</option><option value="3" selected>3</option><option value="5">5</option></select></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Answers are extractive: the closest passages in your PDF are quoted locally. No remote AI service is called.</p>
        </div>`;
    case 'summarize-pdf':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-sum-style">Summary style</label><select id="opt-sum-style"><option value="bullets">Bullet points</option><option value="detailed">Detailed paragraphs</option><option value="overview">Quick overview</option></select></div>
            <div class="field"><label for="opt-sum-length">Length</label><select id="opt-sum-length"><option value="5">Short</option><option value="9" selected>Medium</option><option value="15">Long</option></select></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Ranks sentences by how often their important words appear in the document, then keeps the highest-scoring ones in reading order.</p>
        </div>`;
    case 'p2p-share':
      return `
        <div class="panel">
          <p class="muted" style="margin:0 0 12px;font-size:13.5px;">Direct browser-to-browser transfer. No server and no upload — the two browsers exchange a short connection code.</p>
          <div class="row">
            <button class="btn" id="p2p-create" type="button">1 · Create invite</button>
            <button class="btn" id="p2p-accept" type="button">2 · Accept an invite</button>
          </div>
          <div class="field" style="margin-top:12px;"><label for="p2p-local">Your code (send this to the other person)</label><textarea id="p2p-local" readonly placeholder="Your invite or reply code appears here"></textarea></div>
          <div class="row"><button class="btn btn-sm" id="p2p-copy" type="button">Copy my code</button></div>
          <div class="field" style="margin-top:12px;"><label for="p2p-remote">Their code (paste it here)</label><textarea id="p2p-remote" placeholder="Paste the other person's code…"></textarea></div>
          <div class="row"><button class="btn" id="p2p-connect" type="button">3 · Connect</button><button class="btn btn-sm" id="p2p-reset" type="button">Reset</button></div>
          <div id="p2p-log" class="p2p-log"></div>
          <div id="p2p-downloads" class="p2p-downloads"></div>
        </div>`;
    case 'collab-whiteboard':
      return `
        <div class="panel">
          <div class="wb-toolbar">
            <input type="color" id="wb-color" value="#111111" title="Ink colour" />
            <input type="range" id="wb-size" min="1" max="24" value="4" title="Brush size" />
            <button class="btn btn-sm" id="wb-undo" type="button">Undo</button>
            <button class="btn btn-sm" id="wb-clear" type="button">Clear</button>
            <button class="btn btn-sm" id="wb-save" type="button">Download PNG</button>
          </div>
          <div class="wb-wrap"><canvas id="wb-canvas" width="1200" height="720"></canvas></div>
          <p class="muted" style="margin:10px 0 0;font-size:12.5px;">Draw with a mouse, pen or finger. Tabs of this site on this device share the board instantly. Nothing is saved to a server.</p>
        </div>`;
    case 'gst-invoice':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-gst-seller">Seller name</label><input type="text" id="opt-gst-seller" placeholder="Acme Traders" /></div>
            <div class="field"><label for="opt-gst-seller-gstin">Seller GSTIN</label><input type="text" id="opt-gst-seller-gstin" placeholder="29ABCDE1234F1Z5" /></div>
            <div class="field"><label for="opt-gst-invoice-no">Invoice no.</label><input type="text" id="opt-gst-invoice-no" value="INV-001" /></div>
            <div class="field"><label for="opt-gst-date">Date</label><input type="date" id="opt-gst-date" /></div>
          </div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label for="opt-gst-buyer">Buyer name</label><input type="text" id="opt-gst-buyer" placeholder="Beta Industries" /></div>
            <div class="field"><label for="opt-gst-buyer-gstin">Buyer GSTIN</label><input type="text" id="opt-gst-buyer-gstin" placeholder="27ABCDE1234F1Z5" /></div>
            <div class="field"><label for="opt-gst-state">Supply type</label><select id="opt-gst-state"><option value="intra">Intra-state (CGST + SGST)</option><option value="inter">Inter-state (IGST)</option></select></div>
          </div>
          <div class="field" style="margin-top:12px;"><label for="opt-gst-items">Items — one per line: Description | HSN | Qty | Rate | GST %</label><textarea id="opt-gst-items" placeholder="Consulting | 998314 | 10 | 2500 | 18&#10;Software licence | 998314 | 1 | 12000 | 18"></textarea></div>
          <div class="field" style="margin-top:12px;"><label for="opt-gst-notes">Notes</label><input type="text" id="opt-gst-notes" placeholder="Payment due within 15 days" /></div>
        </div>`;
    case 'pos-billing':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-pos-shop">Shop name</label><input type="text" id="opt-pos-shop" placeholder="Corner Store" /></div>
            <div class="field"><label for="opt-pos-address">Address / phone</label><input type="text" id="opt-pos-address" placeholder="MG Road · 98765 43210" /></div>
            <div class="field"><label for="opt-pos-gstin">GSTIN (optional)</label><input type="text" id="opt-pos-gstin" placeholder="29ABCDE1234F1Z5" /></div>
          </div>
          <div class="field" style="margin-top:12px;"><label for="opt-pos-items">Cart — one per line: Item | Qty | Unit price | GST %</label><textarea id="opt-pos-items" placeholder="Coffee | 2 | 150 | 5&#10;Sandwich | 1 | 220 | 5"></textarea></div>
          <div class="row" style="margin-top:12px;">
            <div class="field"><label for="opt-pos-discount">Discount (%)</label><input type="number" id="opt-pos-discount" value="0" min="0" max="100" step="0.5" /></div>
            <div class="field"><label for="opt-pos-payment">Payment</label><select id="opt-pos-payment"><option value="Cash">Cash</option><option value="UPI">UPI</option><option value="Card">Card</option></select></div>
            <div class="field"><label for="opt-pos-note">Footer note</label><input type="text" id="opt-pos-note" value="Thank you! Visit again." /></div>
          </div>
        </div>`;
    case 'gst-filing-prep':
      return `
        <div class="panel">
          <div class="row">
            <div class="field"><label for="opt-gstf-limit">Portal size limit (MB per file)</label><input type="number" id="opt-gstf-limit" value="5" min="0.5" step="0.5" /></div>
            <div class="field"><label class="check-row" style="padding-top:0;"><input type="checkbox" id="opt-gstf-compress" checked /> Compress pages as images before splitting</label></div>
          </div>
          <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Produces a ZIP containing numbered PDF parts that each fit the GST portal limit.</p>
        </div>`;
    default:
      return '';
  }
}

function handwritingOptions() {
  return `
    <div class="panel">
      <div class="row">
        <div class="field"><label for="opt-hw-style">Handwriting style</label><select id="opt-hw-style"><option value="neat">Neat notes</option><option value="casual">Casual cursive</option><option value="compact">Compact revision notes</option></select></div>
        <div class="field"><label for="opt-hw-paper">Paper</label><select id="opt-hw-paper"><option value="ruled">Ruled paper</option><option value="plain">Plain paper</option><option value="grid">Squared paper</option></select></div>
        <div class="field"><label for="opt-hw-ink">Ink</label><input type="color" id="opt-hw-ink" value="#1a2a6c" /></div>
      </div>
      <p class="muted" style="margin:12px 0 0;font-size:12.5px;">Text is drawn with a handwriting typeface and a little baseline jitter. The result is an image-based PDF.</p>
    </div>`;
}

function toolPageHtml(t) {
  const showDz = t.accept !== 'none';
  const cat = categoryOf(t);
  return `
    <div class="tool-page">
      <nav class="crumbs">
        <a href="#/">Dashboard</a><span>/</span>${cat ? cat.title : 'PDF Tools'}<span>/</span><span>${t.name}</span>
      </nav>
      <h1>${t.name}</h1>
      <p class="lede">${t.desc}</p>
      ${showDz ? `
        <div class="dropzone" id="dz">
          <input type="file" id="file-input" class="dz-input" ${t.multiple ? 'multiple' : ''} accept="${dropzoneAccept(t)}" />
          <div class="dz-icon">${t.icon}</div>
          <p class="dz-title">${dropzoneTitle(t)}</p>
          <p class="dz-sub">Click to browse or drag files here</p>
          <p class="dz-hint">100% private — files never leave your device</p>
        </div>
      ` : ''}
      <div id="file-list"></div>
      ${optionsHtml(t)}
      ${t.id === 'collab-whiteboard' ? '' : `<button class="btn btn-primary btn-lg" id="run">${t.action}</button>`}
      <div id="result" class="result hidden"></div>
      <div class="assurances">
        <div class="assurance"><strong>100% Private</strong><span>Your files never leave your device. Everything processes in your browser.</span></div>
        <div class="assurance"><strong>No Limits</strong><span>No file size restrictions, no daily limits, completely free.</span></div>
        <div class="assurance"><strong>No Watermark</strong><span>Every output file is clean — no branding or watermarks added.</span></div>
      </div>
    </div>
  `;
}

/* ---------------- file handling ---------------- */

function fileKind(f) {
  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') return 'pdf';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|tiff?|avif)$/i.test(f.name) || /^image\//.test(f.type)) return 'image';
  if (/\.(docx?|odt)$/i.test(f.name) || /wordprocessingml|msword|opendocument\.text/.test(f.type)) return 'docx';
  if (/\.(xlsx?|ods)$/i.test(f.name) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(f.type)) return 'xlsx';
  if (/\.(pptx?|odp)$/i.test(f.name) || /presentationml|ms-powerpoint|opendocument\.presentation/.test(f.type)) return 'pptx';
  if (/\.epub$/i.test(f.name) || f.type === 'application/epub+zip') return 'epub';
  if (/\.(mp3|wav|m4a|ogg|oga|webm|aac|flac)$/i.test(f.name) || /^audio\//.test(f.type)) return 'audio';
  if (/\.(txt|md|markdown|csv|html?|xhtml)$/i.test(f.name) || /^text\//.test(f.type)) return 'text';
  return 'other';
}

function allowedKinds(accept) {
  if (accept === 'pdf') return ['pdf'];
  if (accept === 'image') return ['image'];
  if (accept === 'text') return ['text'];
  if (accept === 'docx') return ['docx'];
  if (accept === 'xlsx') return ['xlsx'];
  if (accept === 'pptx') return ['pptx'];
  if (accept === 'epub') return ['epub', 'text'];
  if (accept === 'audio') return ['audio'];
  if (accept === 'any') return ['pdf', 'image', 'text', 'docx', 'xlsx', 'pptx', 'epub', 'audio', 'other'];
  return ['pdf', 'image', 'text'];
}

function filesMatchAccept(files, accept) {
  const allowed = allowedKinds(accept);
  return files.every((f) => allowed.includes(f.kind));
}

async function addFiles(list, t) {
  const allowed = allowedKinds(t.accept);
  let added = 0;
  for (const file of Array.from(list || [])) {
    const kind = fileKind(file);
    if (!allowed.includes(kind)) continue;
    if (kind === 'text') {
      const ta = document.getElementById('text-input');
      if (ta) ta.value = await file.text();
      added++;
      continue;
    }
    if (!t.multiple) state.files = [];
    const dup = state.files.find((x) => x.name === file.name && x.size === file.size);
    if (dup) continue;
    state.files.push({ id: uid(), name: file.name, size: file.size, kind: kind, file: file });
    added++;
  }
  if (added) {
    toast(added + ' file' + (added > 1 ? 's' : '') + ' added');
    renderFiles();
    await afterFiles(t.id);
  }
}

function renderFiles() {
  const box = document.getElementById('file-list');
  if (!box) return;
  const t = toolById(state.tool || '');
  if (!state.files.length) { box.innerHTML = ''; return; }
  const reorder = t && (t.id === 'merge-pdf' || t.id === 'images-to-pdf' || t.id === 'png-to-pdf' || t.id === 'tiff-to-pdf' || t.id === 'alternate-mix-pdf' || t.id === 'workflow' || t.id === 'handwriting-to-pdf');
  box.innerHTML = '<ul class="files">' + state.files.map((f, i) => `
    <li>
      <span class="f-name">${escHtml(f.name)}</span>
      <span class="f-size">${fmtBytes(f.size)}</span>
      <span class="f-tools">
        ${reorder ? `
          <button class="icon-btn" data-move="up" data-i="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-move="down" data-i="${i}" title="Move down" ${i === state.files.length - 1 ? 'disabled' : ''}>↓</button>
        ` : ''}
        <button class="icon-btn danger" data-remove="${f.id}" title="Remove">✕</button>
      </span>
    </li>
  `).join('') + '</ul>';
}

function moveFile(i, dir) {
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= state.files.length) return;
  const tmp = state.files[i];
  state.files[i] = state.files[j];
  state.files[j] = tmp;
  renderFiles();
}

async function afterFiles(toolId) {
  if (toolId === 'organize-pages') await prepareOrganize();
  if (toolId === 'extract-pdf-pages') await preparePageChecks();
  if (toolId === 'edit-pdf-metadata') await prepareMetadata();
  if (toolId === 'fill-pdf-form') await prepareFormFields();
  if (toolId === 'redact-pdf') await prepareRedact();
  if (toolId === 'sign-pdf') wireSignaturePad();
  if (toolId === 'scan-to-pdf') wireScanControls();
  if (toolId === 'crop-resize-pdf') wireCropResize();
  if (toolId === 'edit-pdf-text') await prepareEditText();
  if (toolId === 'collab-whiteboard') wireWhiteboard();
  if (toolId === 'p2p-share') wireP2P();
  if (toolId === 'pdf-to-audio') fillVoiceList();
}

function wireCropResize() {
  const mode = document.getElementById('opt-cr-mode');
  if (!mode || mode.dataset.wired) return;
  mode.dataset.wired = '1';
  const sync = () => {
    document.getElementById('cr-crop-opts')?.classList.toggle('hidden', mode.value !== 'crop');
    document.getElementById('cr-resize-opts')?.classList.toggle('hidden', mode.value === 'crop');
  };
  mode.addEventListener('change', sync);
  sync();
}

function wireScanControls() {
  const cam = document.getElementById('scan-camera');
  const capture = document.getElementById('scan-capture');
  const stop = document.getElementById('scan-stop');
  if (cam && !cam.dataset.wired) {
    cam.dataset.wired = '1';
    cam.addEventListener('click', () => {
      startCamera().catch((e) => toast('Camera unavailable: ' + e.message, 'err'));
    });
  }
  if (capture && !capture.dataset.wired) {
    capture.dataset.wired = '1';
    capture.addEventListener('click', captureScan);
  }
  if (stop && !stop.dataset.wired) {
    stop.dataset.wired = '1';
    stop.addEventListener('click', stopCamera);
  }
  renderScanThumbs();
}

async function prepareMetadata() {
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) return;
  try {
    const doc = await loadDoc(f);
    const fill = (sel, value) => {
      const el = document.querySelector(sel);
      if (el) el.value = value === undefined || value === null ? '' : String(value);
    };
    fill('#opt-meta-title', doc.getTitle());
    fill('#opt-meta-author', doc.getAuthor());
    fill('#opt-meta-subject', doc.getSubject());
    fill('#opt-meta-keywords', doc.getKeywords());
  } catch (e) {
    console.error(e);
  }
}

async function prepareOrganize() {
  const box = document.getElementById('page-ops');
  if (!box) return;
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) { box.innerHTML = '<p class="muted">Upload a PDF to list its pages.</p>'; return; }
  try {
    const doc = await loadDoc(f);
    state.pageOps = doc.getPages().map((p, i) => ({ src: i, rot: 0, del: false }));
    renderOrganize();
  } catch (e) {
    box.innerHTML = '<p class="muted">Could not read pages: ' + escHtml(e.message) + '</p>';
  }
}

function renderOrganize() {
  const box = document.getElementById('page-ops');
  if (!box || !state.pageOps) return;
  box.innerHTML = state.pageOps.map((op, i) => `
    <div class="op-row ${op.del ? 'deleted' : ''}">
      <span class="op-label">Page ${op.src + 1}${op.rot ? ' · ' + op.rot + '°' : ''}</span>
      <span class="op-tools">
        <button class="icon-btn" data-op="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
        <button class="icon-btn" data-op="down" data-i="${i}" ${i === state.pageOps.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
        <button class="icon-btn" data-op="rot" data-i="${i}" title="Rotate 90°">↻</button>
        <button class="icon-btn danger" data-op="del" data-i="${i}" title="Toggle delete">${op.del ? '↺' : '🗑'}</button>
      </span>
    </div>
  `).join('');
}

function organizeOp(i, op) {
  if (!state.pageOps || !state.pageOps[i]) return;
  if (op === 'up' && i > 0) { const t = state.pageOps[i - 1]; state.pageOps[i - 1] = state.pageOps[i]; state.pageOps[i] = t; }
  if (op === 'down' && i < state.pageOps.length - 1) { const t = state.pageOps[i + 1]; state.pageOps[i + 1] = state.pageOps[i]; state.pageOps[i] = t; }
  if (op === 'rot') state.pageOps[i].rot = (state.pageOps[i].rot + 90) % 360;
  if (op === 'del') state.pageOps[i].del = !state.pageOps[i].del;
  renderOrganize();
}

async function preparePageChecks() {
  const box = document.getElementById('page-checks');
  if (!box) return;
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) { box.innerHTML = '<p class="muted">Upload a PDF to list its pages.</p>'; return; }
  try {
    const doc = await loadDoc(f);
    const n = doc.getPageCount();
    let html = '';
    for (let i = 0; i < n; i++) html += `<label><input type="checkbox" class="page-check" value="${i}" checked /> Page ${i + 1}</label>`;
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<p class="muted">Could not read pages: ' + escHtml(e.message) + '</p>';
  }
}

/* ---------------- run pipeline ---------------- */

function needPdf() {
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) throw new Error('Add a PDF file first');
  return f;
}

function val(sel) {
  const el = document.querySelector(sel);
  return el ? el.value : '';
}

function writeTextToPdf(doc, text) {
  const lines = String(text || '').split('\n');
  let y = 80;
  doc.setFontSize(12);
  for (const raw of lines) {
    const wrapped = doc.splitTextToSize(raw, 515);
    for (const line of wrapped) {
      if (y > 780) { doc.addPage(); y = 80; }
      doc.text(line, 40, y);
      y += 18;
    }
    if (raw.trim() === '') y += 6;
  }
  return doc;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim().length > 0));
}

async function htmlToPdfBlob(html, orientation) {
  const landscape = orientation === 'landscape';
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:' + (landscape ? 1123 : 794) + 'px;background:#fff;color:#000;padding:24px;font-family:Arial,sans-serif;';
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    const canvas = await window.html2canvas(host, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: landscape ? 'landscape' : 'portrait' });
    const pageW = landscape ? 841.89 : 595.28;
    const pageH = landscape ? 595.28 : 841.89;
    const imgW = pageW;
    const imgH = canvas.height * (pageW / canvas.width);
    if (imgH <= pageH) {
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, imgW, imgH);
    } else {
      const sliceHpx = canvas.width * (pageH / pageW);
      let y = 0;
      let first = true;
      while (y < canvas.height) {
        const h = Math.min(sliceHpx, canvas.height - y);
        const slice = document.createElement('canvas');
        slice.width = canvas.width;
        slice.height = Math.ceil(h);
        slice.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
        if (!first) pdf.addPage();
        first = false;
        pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, imgW, h * (pageW / canvas.width));
        y += h;
      }
    }
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

/* Layout a small subset of HTML as real PDF text. Used for conversions where
   selectable text matters more than pixel-perfect styling. */
async function htmlToTextPdfBlob(html, orientation) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const landscape = orientation === 'landscape';
  const W = landscape ? 841.89 : 595.28;
  const H = landscape ? 595.28 : 841.89;
  const M = 48;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
  const ensure = (h) => { if (y - h < M) newPage(); };
  const drawBlock = (text, opts) => {
    opts = opts || {};
    const size = opts.size || 11;
    const font = opts.font || regular;
    const color = opts.color || rgb(0.08, 0.09, 0.11);
    const indent = opts.indent || 0;
    const gap = opts.gap === undefined ? 6 : opts.gap;
    const align = opts.align || 'left';
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const lines = wrapLines(clean, font, size, W - M * 2 - indent);
    const lh = size * 1.45;
    for (const line of lines) {
      if (y - lh < M) newPage();
      const w = font.widthOfTextAtSize(line, size);
      const x = align === 'center' ? Math.max(M, (W - w) / 2) : M + indent;
      page.drawText(line, { x: x, y: y - size * 0.84, size: size, font: font, color: color });
      y -= lh;
    }
    y -= gap;
  };
  const drawTable = (table) => {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.children)
      .filter((c) => /^(TD|TH)$/i.test(c.tagName))
      .map((td) => String(td.textContent || '').replace(/\s+/g, ' ').trim()));
    const usable = rows.filter((r) => r.length);
    if (!usable.length) return;
    const cols = Math.max.apply(null, usable.map((r) => r.length));
    const weights = [];
    for (let c = 0; c < cols; c++) {
      let longest = 5;
      for (const r of usable) longest = Math.max(longest, String(r[c] || '').length);
      weights.push(Math.min(34, Math.max(5, longest)));
    }
    const totalW = W - M * 2;
    const wsum = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => Math.max(40, totalW * (w / wsum)));
    const norm = totalW / widths.reduce((a, b) => a + b, 0);
    for (let i = 0; i < widths.length; i++) widths[i] *= norm;
    const pad = 5;
    const size = 9.2;
    const lh = size * 1.35;
    const drawRow = (cells, isHeader) => {
      const wrapped = widths.map((w, c) => wrapLines(String(cells[c] || ''), isHeader ? bold : regular, size, w - pad * 2));
      const lines = Math.max(1, Math.max.apply(null, wrapped.map((x) => x.length)));
      const h = lines * lh + pad * 2;
      if (y - h < M) newPage();
      let x = M;
      for (let c = 0; c < cols; c++) {
        const style = { x: x, y: y - h, width: widths[c], height: h, borderColor: rgb(0.72, 0.75, 0.8), borderWidth: 0.6 };
        if (isHeader) style.color = rgb(0.94, 0.95, 0.97);
        page.drawRectangle(style);
        let ty = y - pad - size;
        for (const line of wrapped[c]) {
          page.drawText(line, { x: x + pad, y: ty, size: size, font: isHeader ? bold : regular, color: rgb(0.08, 0.09, 0.11) });
          ty -= lh;
        }
        x += widths[c];
      }
      y -= h + 2;
    };
    usable.forEach((r, i) => drawRow(r, i === 0));
    y -= 8;
  };
  const walk = (node, indent) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'style' || tag === 'script' || tag === 'head' || tag === 'title' || tag === 'meta' || tag === 'link') continue;
      if (/^h[1-6]$/.test(tag)) {
        const lvl = parseInt(tag[1], 10);
        drawBlock(child.textContent, { size: [22, 17, 14, 12, 11, 11][lvl - 1], font: bold, gap: lvl === 1 ? 14 : 10 });
        continue;
      }
      if (tag === 'p') {
        const cls = String(child.className || '');
        const style = String(child.getAttribute('style') || '');
        const center = /center/.test(style) || /doc-title|book-title/.test(cls);
        drawBlock(child.textContent, { size: 11, gap: 7, align: center ? 'center' : 'left' });
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        let n = 0;
        for (const li of Array.from(child.children)) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          n++;
          drawBlock((tag === 'ol' ? n + '. ' : '• ') + li.textContent, { size: 11, indent: indent + 14, gap: 3 });
        }
        y -= 4;
        continue;
      }
      if (tag === 'table') { drawTable(child); continue; }
      if (tag === 'pre') { drawBlock(child.textContent, { size: 9.5, font: mono, gap: 8 }); continue; }
      if (tag === 'hr') {
        ensure(8);
        page.drawLine({ start: { x: M, y: y }, end: { x: W - M, y: y }, thickness: 0.6, color: rgb(0.8, 0.82, 0.86) });
        y -= 14;
        continue;
      }
      if (tag === 'br') { y -= 8; continue; }
      walk(child, indent);
    }
  };
  const host = document.createElement('div');
  host.innerHTML = html;
  try {
    walk(host, 0);
    return await doc.save();
  } finally {
    host.innerHTML = '';
  }
}

function mdToHtml(md) {
  const inline = (s) => escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const out = [];
  let inList = false;
  for (const line of String(md || '').split('\n')) {
    if (/^\s*[-*] /.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(line.replace(/^\s*[-*] /, '')) + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (/^### /.test(line)) out.push('<h3>' + inline(line.slice(4)) + '</h3>');
    else if (/^## /.test(line)) out.push('<h2>' + inline(line.slice(3)) + '</h2>');
    else if (/^# /.test(line)) out.push('<h1>' + inline(line.slice(2)) + '</h1>');
    else if (/^---+$/.test(line.trim())) out.push('<hr />');
    else if (line.trim() === '') out.push('');
    else out.push('<p>' + inline(line) + '</p>');
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/* ============================================================
   Signatures
   ============================================================ */

function trimCanvas(canvas, pad) {
  pad = pad || 6;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function drawTypedSignature(text) {
  const pad = document.getElementById('sig-pad');
  if (!pad) return;
  const ctx = pad.getContext('2d');
  ctx.clearRect(0, 0, pad.width, pad.height);
  if (!text.trim()) return;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 72;
  ctx.font = 'italic ' + size + 'px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive';
  while (ctx.measureText(text).width > pad.width - 50 && size > 20) {
    size -= 4;
    ctx.font = 'italic ' + size + 'px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive';
  }
  ctx.fillText(text, pad.width / 2, pad.height / 2);
  pad.dataset.hasInk = '1';
}

function wireSignaturePad() {
  const pad = document.getElementById('sig-pad');
  if (!pad || pad.dataset.wired) return;
  pad.dataset.wired = '1';
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111111';
  let drawing = false;
  let last = null;
  const point = (e) => {
    const rect = pad.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (pad.width / rect.width),
      y: (e.clientY - rect.top) * (pad.height / rect.height),
    };
  };
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    last = point(e);
    pad.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    pad.dataset.hasInk = '1';
  });
  const stop = () => { drawing = false; last = null; };
  pad.addEventListener('pointerup', stop);
  pad.addEventListener('pointercancel', stop);
  pad.addEventListener('pointerleave', stop);

  const typed = document.getElementById('opt-sig-typed');
  if (typed) typed.addEventListener('input', () => drawTypedSignature(typed.value));
  const clear = document.getElementById('sig-clear');
  if (clear) clear.addEventListener('click', () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    pad.dataset.hasInk = '';
    if (typed) typed.value = '';
  });
}

function readSignatureCanvas() {
  const pad = document.getElementById('sig-pad');
  if (!pad) return null;
  return trimCanvas(pad, 8);
}

/* ============================================================
   PDF forms
   ============================================================ */

async function prepareFormFields() {
  const box = document.getElementById('form-fields');
  if (!box) return;
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) {
    box.innerHTML = '<p class="muted" style="margin:0;">Upload a PDF with form fields to fill it in.</p>';
    state.formFields = null;
    return;
  }
  const L = window.PDFLib;
  try {
    const doc = await loadDoc(f);
    const form = doc.getForm();
    const fields = form.getFields();
    state.formFields = fields.map((fd) => fd.getName());
    if (!fields.length) {
      box.innerHTML = '<p class="muted" style="margin:0;">This PDF has no fillable form fields (no AcroForm). You can still edit it with Create PDF, Watermark or Sign PDF.</p>';
      return;
    }
    let html = '';
    let rendered = 0;
    for (const fd of fields) {
      const name = fd.getName();
      const safe = escHtml(name);
      if (fd instanceof L.PDFTextField) {
        rendered++;
        html += '<div class="field form-field"><label>' + safe + '</label><input type="text" data-form="' + safe + '" value="' + escHtml(fd.getText() || '') + '" /></div>';
      } else if (fd instanceof L.PDFCheckBox) {
        rendered++;
        html += '<div class="field form-field"><label>' + safe + '</label><label class="check-row" style="padding-top:0;"><input type="checkbox" data-form="' + safe + '" ' + (fd.isChecked() ? 'checked' : '') + ' /> Checked</label></div>';
      } else if (fd instanceof L.PDFDropdown || fd instanceof L.PDFRadioGroup || fd instanceof L.PDFOptionList) {
        rendered++;
        const opts = fd.getOptions() || [];
        let current = [];
        try { const sel = fd.getSelected(); current = Array.isArray(sel) ? sel : (sel ? [sel] : []); } catch (e) { current = []; }
        const options = opts.map((o) => '<option value="' + escHtml(o) + '"' + (current.includes(o) ? ' selected' : '') + '>' + escHtml(o) + '</option>').join('');
        html += '<div class="field form-field"><label>' + safe + '</label><select data-form="' + safe + '">' + options + '</select></div>';
      }
    }
    if (!rendered) {
      box.innerHTML = '<p class="muted" style="margin:0;">This PDF has ' + fields.length + ' form field(s), but none are text, checkbox or choice fields this tool can fill.</p>';
      return;
    }
    box.innerHTML = '<div class="row">' + html + '</div><p class="muted" style="margin:12px 0 0;font-size:12.5px;">' + rendered + ' fillable field(s) found.</p>';
  } catch (e) {
    console.error(e);
    box.innerHTML = '<p class="muted" style="margin:0;">Could not read the form: ' + escHtml(e.message) + '</p>';
  }
}

/* ============================================================
   Redaction
   ============================================================ */

async function prepareRedact() {
  const host = document.getElementById('redact-stage');
  if (!host) return;
  const f = state.files.find((x) => x.kind === 'pdf');
  if (!f) {
    if (state.redact && state.redact.src && typeof state.redact.src.destroy === 'function') {
      try { state.redact.src.destroy(); } catch (e) { /* already gone */ }
    }
    state.redact = null;
    host.innerHTML = '<p class="muted">Upload a PDF to preview pages.</p>';
    return;
  }
  if (!state.redact || state.redact.fileId !== f.id) {
    if (state.redact && state.redact.src && typeof state.redact.src.destroy === 'function') {
      try { state.redact.src.destroy(); } catch (e) { /* already gone */ }
    }
    state.redact = { fileId: f.id, page: 0, total: 0, boxes: {}, src: null, rendering: false };
    host.innerHTML = '<p class="muted">Loading preview…</p>';
  }
  const r = state.redact;
  if (!r.src) {
    r.src = await openPdfjs(await bytesOf(f));
    r.total = r.src.numPages;
  }
  wireRedactControls();
  await renderRedactPage();
}

function wireRedactControls() {
  const prev = document.getElementById('redact-prev');
  const next = document.getElementById('redact-next');
  const clear = document.getElementById('redact-clear');
  const go = (dir) => {
    const r = state.redact;
    if (!r) return;
    r.page = Math.min(r.total - 1, Math.max(0, r.page + dir));
    renderRedactPage().catch((e) => console.error(e));
  };
  if (prev && !prev.dataset.wired) { prev.dataset.wired = '1'; prev.addEventListener('click', () => go(-1)); }
  if (next && !next.dataset.wired) { next.dataset.wired = '1'; next.addEventListener('click', () => go(1)); }
  if (clear && !clear.dataset.wired) {
    clear.dataset.wired = '1';
    clear.addEventListener('click', () => {
      const r = state.redact;
      if (!r) return;
      r.boxes[r.page] = [];
      renderRedactPage().catch((e) => console.error(e));
    });
  }
}

async function renderRedactPage() {
  const r = state.redact;
  const host = document.getElementById('redact-stage');
  if (!r || !r.src || !host || r.rendering) return;
  r.rendering = true;
  try {
    const pageNo = Math.min(r.total, Math.max(1, r.page + 1));
    const page = await r.src.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const width = Math.min(660, Math.max(280, host.clientWidth || 660));
    const scale = width / base.width;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(base.width * scale);
    canvas.height = Math.round(base.height * scale);
    canvas.className = 'redact-canvas';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: scale }) }).promise;
    host.innerHTML = '';
    const frame = document.createElement('div');
    frame.className = 'redact-frame';
    frame.appendChild(canvas);
    const overlay = document.createElement('div');
    overlay.className = 'redact-overlay';
    overlay.id = 'redact-overlay';
    (r.boxes[r.page] || []).forEach((b, i) => {
      const el = document.createElement('div');
      el.className = 'redact-box';
      el.dataset.box = String(i);
      el.style.left = (b.x * 100) + '%';
      el.style.top = (b.y * 100) + '%';
      el.style.width = (b.w * 100) + '%';
      el.style.height = (b.h * 100) + '%';
      overlay.appendChild(el);
    });
    frame.appendChild(overlay);
    host.appendChild(frame);
    wireRedactOverlay(overlay);
    const label = document.getElementById('redact-page-label');
    if (label) label.textContent = 'Page ' + pageNo + ' / ' + r.total;
  } finally {
    r.rendering = false;
  }
}

function wireRedactOverlay(overlay) {
  let start = null;
  let temp = null;
  const norm = (e) => {
    const rect = overlay.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = norm(e);
    temp = document.createElement('div');
    temp.className = 'redact-box redact-temp';
    overlay.appendChild(temp);
    try { overlay.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!start || !temp) return;
    const p = norm(e);
    temp.style.left = (Math.min(start.x, p.x) * 100) + '%';
    temp.style.top = (Math.min(start.y, p.y) * 100) + '%';
    temp.style.width = (Math.abs(p.x - start.x) * 100) + '%';
    temp.style.height = (Math.abs(p.y - start.y) * 100) + '%';
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!start) return;
    const p = norm(e);
    const box = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    };
    start = null;
    if (temp) { temp.remove(); temp = null; }
    if (box.w > 0.006 && box.h > 0.004) {
      const r = state.redact;
      if (r) {
        r.boxes[r.page] = (r.boxes[r.page] || []).concat([box]);
        renderRedactPage().catch((err) => console.error(err));
      }
    }
  });
  overlay.addEventListener('pointercancel', () => {
    start = null;
    if (temp) { temp.remove(); temp = null; }
  });
}

async function textRedactionBoxes(page, term) {
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1 });
  const items = (tc.items || []).map((item) => ({ item: item, s: item.str || '' }));
  const normTerm = String(term).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normTerm) return [];

  const chars = [];
  items.forEach((it, i) => {
    for (let k = 0; k < it.s.length; k++) chars.push({ ch: it.s[k], i: i, off: k });
  });

  /* Normalise the page text two ways: with and without a separating space
     between neighbouring text items. A phrase split across items ("John" +
     "Smith") matches the joined form, while words inside one item match both. */
  const findHits = (joinItems) => {
    let norm = '';
    const owners = [];
    let lastItem = -1;
    for (const c of chars) {
      if (joinItems && lastItem !== -1 && c.i !== lastItem && norm && !norm.endsWith(' ') && !/\s/.test(c.ch)) {
        norm += ' ';
        owners.push(c.i);
      }
      lastItem = c.i;
      if (/\s/.test(c.ch)) {
        if (norm && !norm.endsWith(' ')) {
          norm += ' ';
          owners.push(c.i);
        }
      } else {
        norm += c.ch.toLowerCase();
        owners.push(c.i);
      }
    }
    const hits = [];
    let at = 0;
    while (at <= norm.length) {
      const idx = norm.indexOf(normTerm, at);
      if (idx === -1) break;
      hits.push([idx, idx + normTerm.length]);
      at = idx + Math.max(1, normTerm.length);
    }
    return { hits: hits, owners: owners };
  };

  const boxForItem = (item) => {
    const tx = pdfjs().Util.transform(vp.transform, item.transform);
    const h = item.height || 10;
    const w = item.width || 0;
    /* Build the box in display space (y down), then map its corners into PDF
       user space so rotated pages stay aligned. */
    const x0 = tx[4];
    const x1 = tx[4] + w;
    const yTop = tx[5] - h * 0.9;
    const yBottom = tx[5] + h * 0.3;
    const pts = [
      vp.convertToPdfPoint(x0, yTop),
      vp.convertToPdfPoint(x1, yTop),
      vp.convertToPdfPoint(x0, yBottom),
      vp.convertToPdfPoint(x1, yBottom),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min.apply(null, xs);
    const y = Math.min.apply(null, ys);
    return {
      x: x,
      y: y,
      w: Math.max.apply(null, xs) - x,
      h: Math.max.apply(null, ys) - y,
      unit: 'pt',
    };
  };

  const seen = new Set();
  const boxes = [];
  for (const variant of [findHits(true), findHits(false)]) {
    for (const span of variant.hits) {
      const use = new Set();
      for (let k = span[0]; k < span[1]; k++) use.add(variant.owners[k]);
      for (const i of use) {
        if (seen.has(i)) continue;
        seen.add(i);
        boxes.push(boxForItem(items[i].item));
      }
    }
  }
  return boxes;
}

/* ============================================================
   Camera scanning
   ============================================================ */

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser does not expose a camera API');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  state.camera = stream;
  const video = document.getElementById('scan-video');
  if (video) {
    video.srcObject = stream;
    video.classList.remove('hidden');
    try { await video.play(); } catch (e) { /* autoplay may need a gesture */ }
  }
  document.getElementById('scan-capture')?.classList.remove('hidden');
  document.getElementById('scan-stop')?.classList.remove('hidden');
  document.getElementById('scan-camera')?.classList.add('hidden');
}

function stopCamera() {
  if (state.camera) {
    state.camera.getTracks().forEach((t) => t.stop());
    state.camera = null;
  }
  const video = document.getElementById('scan-video');
  if (video) {
    video.srcObject = null;
    video.classList.add('hidden');
  }
  document.getElementById('scan-capture')?.classList.add('hidden');
  document.getElementById('scan-stop')?.classList.add('hidden');
  document.getElementById('scan-camera')?.classList.remove('hidden');
}

function captureScan() {
  const video = document.getElementById('scan-video');
  if (!video || !video.videoWidth) { toast('The camera is not ready yet', 'err'); return; }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  state.scans.push(canvas);
  renderScanThumbs();
  toast('Page captured');
}

function renderScanThumbs() {
  const box = document.getElementById('scan-thumbs');
  if (!box) return;
  if (!state.scans.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.scans.map((c, i) =>
    '<div class="scan-thumb"><img src="' + c.toDataURL('image/jpeg', 0.55) + '" alt="Captured page ' + (i + 1) + '" />' +
    '<span class="scan-no">' + (i + 1) + '</span>' +
    '<button class="icon-btn danger" data-scan-remove="' + i + '" type="button" title="Remove">✕</button></div>'
  ).join('');
}

function applyScanFilter(src, mode) {
  if (mode === 'colour') return src;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  if (mode === 'grayscale') {
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = l;
    }
  } else {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      n++;
    }
    const mean = sum / Math.max(1, n);
    const threshold = Math.min(232, Math.max(90, mean * 0.9));
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const v = l > threshold ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function imageFileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read image: ' + file.name));
    };
    img.src = url;
  });
}

/* ============================================================
   Word (.docx) writer
   ============================================================ */

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function pdfTextParagraphs(f) {
  const src = await openPdfjs(await bytesOf(f));
  const out = [];
  for (let i = 1; i <= src.numPages; i++) {
    if (i > 1) out.push({ text: '', pageBreak: true });
    const page = await src.getPage(i);
    const tc = await page.getTextContent();
    let cur = '';
    for (const item of tc.items || []) {
      cur += item.str || '';
      if (item.hasEOL) {
        const line = cur.replace(/\s+$/, '');
        if (line.trim()) out.push({ text: line });
        cur = '';
      }
    }
    const last = cur.replace(/\s+$/, '');
    if (last.trim()) out.push({ text: last });
  }
  return { paragraphs: out, pages: src.numPages };
}

async function docxFromPdf(f) {
  const { paragraphs, pages } = await pdfTextParagraphs(f);
  const body = paragraphs.map((p) => {
    if (p.pageBreak) return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    return '<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">' + xmlEsc(p.text) + '</w:t></w:r></w:p>';
  }).join('');

  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    '</w:sectPr></w:body></w:document>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>';

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + xmlEsc(f.name) + '</dc:title>' +
    '<dc:creator>ihatepdf.cv</dc:creator>' +
    '<cp:lastModifiedBy>ihatepdf.cv</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
    '</cp:coreProperties>';

  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', rels);
  zip.folder('word').file('document.xml', documentXml);
  zip.folder('docProps').file('core.xml', core);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const lines = paragraphs.filter((p) => !p.pageBreak && p.text.trim()).length;
  return { blob: blob, pages: pages, lines: lines };
}

/* ============================================================
   TIFF writer (baseline RGB, PackBits)
   ============================================================ */

function packbits(data) {
  const n = data.length;
  const out = new Uint8Array(n + Math.ceil(n / 128) + 2);
  let o = 0;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && data[i + run] === data[i] && run < 128) run++;
    if (run >= 2) {
      out[o++] = 257 - run;
      out[o++] = data[i];
      i += run;
    } else {
      let j = i + 1;
      while (j < n && j - i < 128) {
        if (j + 1 < n && data[j] === data[j + 1]) break;
        j++;
      }
      const len = j - i;
      out[o++] = len - 1;
      for (let k = i; k < j; k++) out[o++] = data[k];
      i = j;
    }
  }
  return out.subarray(0, o);
}

function encodeTiff(images, dpi) {
  const pages = images.map((img) => ({ w: img.width, h: img.height, data: packbits(img.rgb) }));
  const entries = 12;
  const ifdSize = 2 + entries * 12 + 4;
  const extSize = 6 + 6 + 8 + 8;
  let total = 8;
  const plan = [];
  for (const p of pages) {
    const ifdPos = total;
    const dataStart = ifdPos + ifdSize + extSize;
    plan.push({ ifdPos: ifdPos, dataStart: dataStart, w: p.w, h: p.h, data: p.data });
    total = dataStart + p.data.length;
    if (total % 2) total++;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const put16 = (pos, v) => view.setUint16(pos, v & 0xffff, true);
  const put32 = (pos, v) => view.setUint32(pos, v >>> 0, true);
  out[0] = 0x49;
  out[1] = 0x49;
  put16(2, 42);
  put32(4, 8);

  plan.forEach((p, idx) => {
    let pos = p.ifdPos;
    put16(pos, entries);
    pos += 2;
    const ext = p.ifdPos + ifdSize;
    const bitsPos = ext;
    const samplePos = ext + 6;
    const xresPos = ext + 12;
    const yresPos = ext + 20;
    const tag = (id, type, count, value) => {
      put16(pos, id); pos += 2;
      put16(pos, type); pos += 2;
      put32(pos, count); pos += 4;
      put32(pos, value); pos += 4;
    };
    tag(256, 4, 1, p.w);            // ImageWidth
    tag(257, 4, 1, p.h);            // ImageLength
    tag(258, 3, 3, bitsPos);        // BitsPerSample
    tag(259, 3, 1, 32773);          // Compression = PackBits
    tag(262, 3, 1, 2);              // Photometric = RGB
    tag(273, 4, 1, p.dataStart);    // StripOffsets
    tag(277, 3, 1, 3);              // SamplesPerPixel
    tag(278, 4, 1, p.h);            // RowsPerStrip
    tag(279, 4, 1, p.data.length);  // StripByteCounts
    tag(282, 5, 1, xresPos);        // XResolution
    tag(283, 5, 1, yresPos);        // YResolution
    tag(296, 3, 1, 2);              // ResolutionUnit = inch
    put32(pos, idx + 1 < plan.length ? plan[idx + 1].ifdPos : 0);
    pos += 4;

    put16(bitsPos, 8); put16(bitsPos + 2, 8); put16(bitsPos + 4, 8);
    put16(samplePos, 1); put16(samplePos + 2, 1); put16(samplePos + 4, 1);
    put32(xresPos, dpi); put32(xresPos + 4, 1);
    put32(yresPos, dpi); put32(yresPos + 4, 1);

    out.set(p.data, p.dataStart);
  });
  return out;
}

/* ============================================================
   Excel (.xlsx) writer
   ============================================================ */

function columnName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function xlsxFromPdf(f, mode) {
  const src = await openPdfjs(await bytesOf(f));
  const rows = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const tc = await page.getTextContent();
    const items = (tc.items || [])
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    const pageRows = [];
    for (const it of items) {
      let row = pageRows.length ? pageRows[pageRows.length - 1] : null;
      if (!row || Math.abs(row.y - it.y) > 3) {
        row = { y: it.y, cells: [] };
        pageRows.push(row);
      }
      row.cells.push(it);
    }
    for (const r of pageRows) {
      r.cells.sort((a, b) => a.x - b.x);
      rows.push(mode === 'lines' ? [r.cells.map((c) => c.text).join(' ')] : r.cells.map((c) => c.text));
    }
    if (i < src.numPages) rows.push([]);
  }

  let sheetRows = '';
  let rIdx = 0;
  for (const cells of rows) {
    rIdx++;
    if (!cells.length) { sheetRows += '<row r="' + rIdx + '"/>'; continue; }
    sheetRows += '<row r="' + rIdx + '">' + cells.map((val, ci) =>
      '<c r="' + columnName(ci) + rIdx + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(val) + '</t></is></c>'
    ).join('') + '</row>';
  }

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    sheetRows + '</sheetData></worksheet>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', rels);
  const xl = zip.folder('xl');
  xl.file('workbook.xml', workbook);
  xl.folder('_rels').file('workbook.xml.rels', wbRels);
  xl.folder('worksheets').file('sheet1.xml', sheet);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return { blob: blob, rows: rows.filter((r) => r.length).length, pages: src.numPages };
}

/* ============================================================
   PDF comparison
   ============================================================ */

async function pdfTextLines(f) {
  const src = await openPdfjs(await bytesOf(f));
  const lines = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const tc = await page.getTextContent();
    let cur = '';
    for (const item of tc.items || []) {
      cur += item.str || '';
      if (item.hasEOL) {
        const line = cur.trim();
        if (line) lines.push(line);
        cur = '';
      }
    }
    const last = cur.trim();
    if (last) lines.push(last);
  }
  return { lines: lines, pages: src.numPages };
}

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > 4000000) {
    const setA = new Set(a);
    const setB = new Set(b);
    const ops = [];
    for (const line of a) ops.push({ t: setB.has(line) ? 'same' : 'del', text: line });
    for (const line of b) if (!setA.has(line)) ops.push({ t: 'add', text: line });
    return ops;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: 'same', text: a[i] }); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: 'del', text: a[i] }); i++; }
    else { ops.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ t: 'del', text: a[i++] }); }
  while (j < m) { ops.push({ t: 'add', text: b[j++] }); }
  return ops;
}

function diffTextReport(ops) {
  return ops.map((op) => {
    if (op.t === 'add') return '+ ' + op.text;
    if (op.t === 'del') return '- ' + op.text;
    return '  ' + op.text;
  }).join('\n');
}

function diffHtmlReport(aName, bName, ops, aPages, bPages) {
  const added = ops.filter((o) => o.t === 'add').length;
  const removed = ops.filter((o) => o.t === 'del').length;
  const same = ops.filter((o) => o.t === 'same').length;
  const rows = ops.map((op) => {
    const cls = op.t === 'add' ? 'add' : op.t === 'del' ? 'del' : 'same';
    const mark = op.t === 'add' ? '+' : op.t === 'del' ? '−' : ' ';
    return '<div class="ln ' + cls + '"><span class="mark">' + mark + '</span><span class="txt">' + escHtml(op.text) + '</span></div>';
  }).join('\n');
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>PDF comparison — ' + escHtml(aName) + ' vs ' + escHtml(bName) + '</title>\n<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:1000px;margin:36px auto;padding:0 20px;color:#18181b;line-height:1.5}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:14px;font-weight:600;color:#52525b;margin:0 0 18px}' +
    '.stats{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 22px}' +
    '.stat{border:1px solid #e4e4e7;border-radius:10px;padding:10px 14px;font-size:13px}' +
    '.stat b{display:block;font-size:20px}.stat.add b{color:#15803d}.stat.del b{color:#b91c1c}' +
    '.diff{border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}' +
    '.ln{display:flex;gap:10px;padding:2px 12px;white-space:pre-wrap;word-break:break-word}' +
    '.ln .mark{width:12px;flex:0 0 12px;color:#a1a1aa}' +
    '.ln.add{background:#f0fdf4}.ln.add .mark{color:#15803d}.ln.del{background:#fef2f2}.ln.del .mark{color:#b91c1c}' +
    '.ln.same{color:#52525b}' +
    '</style></head><body>' +
    '<h1>PDF comparison</h1><h2>' + escHtml(aName) + ' (' + aPages + ' pages) → ' + escHtml(bName) + ' (' + bPages + ' pages)</h2>' +
    '<div class="stats">' +
    '<div class="stat"><b>' + same + '</b>unchanged lines</div>' +
    '<div class="stat del"><b>' + removed + '</b>removed</div>' +
    '<div class="stat add"><b>' + added + '</b>added</div>' +
    '</div>' +
    '<div class="diff">' + rows + '</div>' +
    '</body></html>';
}

/* ============================================================
   Small shared utilities
   ============================================================ */

function pageHasEncryption(bytes) {
  const needle = '/Encrypt';
  const limit = bytes.length - needle.length;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 0x2f) continue;
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle.charCodeAt(j)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/* ============================================================
   New tool helpers — documents, images, analysis
   ============================================================ */

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Could not parse XML inside this file');
  return doc;
}

function xmlNodeText(node, tag) {
  return Array.from(node.getElementsByTagName(tag)).map((n) => n.textContent || '').join('');
}

async function unzipFile(file) {
  return await window.JSZip.loadAsync(file);
}

/* ---------------- Word (.docx) ---------------- */

async function docxToHtml(file) {
  if (!/\.docx$/i.test(file.name)) {
    throw new Error('Legacy .doc files are not supported — open the document and save it as .docx first');
  }
  const zip = await unzipFile(file);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('This does not look like a valid .docx document');
  const xml = parseXml(await docFile.async('text'));
  const body = xml.getElementsByTagName('w:body')[0];
  if (!body) throw new Error('The Word document has no body');
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  for (const node of Array.from(body.children)) {
    if (node.tagName === 'w:p') {
      const text = xmlNodeText(node, 'w:t');
      const numbered = node.getElementsByTagName('w:numPr').length > 0;
      if (!text.trim()) continue;
      if (numbered) {
        if (!listOpen) { out.push('<ul>'); listOpen = true; }
        out.push('<li>' + escHtml(text) + '</li>');
        continue;
      }
      closeList();
      const style = node.getElementsByTagName('w:pStyle')[0];
      const styleName = style ? style.getAttribute('w:val') || '' : '';
      const heading = styleName.match(/^Heading\s*([1-6])$/i);
      if (heading) out.push('<h' + heading[1] + '>' + escHtml(text) + '</h' + heading[1] + '>');
      else if (/^Title$/i.test(styleName)) out.push('<h1 class="doc-title">' + escHtml(text) + '</h1>');
      else if (/^Subtitle$/i.test(styleName)) out.push('<p class="doc-subtitle">' + escHtml(text) + '</p>');
      else if (node.getElementsByTagName('w:jc')[0] && node.getElementsByTagName('w:jc')[0].getAttribute('w:val') === 'center') out.push('<p style="text-align:center">' + escHtml(text) + '</p>');
      else out.push('<p>' + escHtml(text) + '</p>');
    } else if (node.tagName === 'w:tbl') {
      closeList();
      const rows = Array.from(node.getElementsByTagName('w:tr'));
      if (!rows.length) continue;
      out.push('<table>');
      rows.forEach((tr, ri) => {
        out.push('<tr>');
        for (const tc of Array.from(tr.children).filter((c) => c.tagName === 'w:tc')) {
          const cellText = Array.from(tc.getElementsByTagName('w:p')).map((p) => xmlNodeText(p, 'w:t')).join(' ').trim();
          out.push((ri === 0 ? '<th>' : '<td>') + escHtml(cellText) + (ri === 0 ? '</th>' : '</td>'));
        }
        out.push('</tr>');
      });
      out.push('</table>');
    }
  }
  closeList();
  if (!out.length) throw new Error('No readable text was found in this Word document');
  return out.join('\n');
}

/* ---------------- Excel (.xlsx) ---------------- */

async function xlsxToSheets(file) {
  if (!/\.xlsx$/i.test(file.name)) {
    throw new Error('Legacy .xls files are not supported — save the spreadsheet as .xlsx first');
  }
  const zip = await unzipFile(file);
  const sharedFile = zip.file('xl/sharedStrings.xml');
  let shared = [];
  if (sharedFile) {
    const sdoc = parseXml(await sharedFile.async('text'));
    shared = Array.from(sdoc.getElementsByTagName('si')).map((si) => xmlNodeText(si, 't'));
  }
  const sheetNames = [];
  const wbFile = zip.file('xl/workbook.xml');
  if (wbFile) {
    const wdoc = parseXml(await wbFile.async('text'));
    Array.from(wdoc.getElementsByTagName('sheet')).forEach((s) => sheetNames.push(s.getAttribute('name') || 'Sheet'));
  }
  const files = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/sheet(\d+)/)[1], 10) - parseInt(b.match(/sheet(\d+)/)[1], 10));
  if (!files.length) throw new Error('No worksheets were found in this spreadsheet');
  const sheets = [];
  for (let si = 0; si < files.length; si++) {
    const xml = parseXml(await zip.file(files[si]).async('text'));
    const rows = [];
    let maxCols = 0;
    for (const row of Array.from(xml.getElementsByTagName('row'))) {
      const cells = [];
      for (const c of Array.from(row.getElementsByTagName('c'))) {
        const ref = c.getAttribute('r') || '';
        const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
        let col = 0;
        for (const ch of letters) col = col * 26 + (ch.charCodeAt(0) - 64);
        col = Math.max(0, col - 1);
        const type = c.getAttribute('t');
        const vNode = c.getElementsByTagName('v')[0];
        const isNode = c.getElementsByTagName('is')[0];
        let value = '';
        if (type === 's' && vNode) value = shared[parseInt(vNode.textContent, 10)] || '';
        else if (type === 'inlineStr' && isNode) value = xmlNodeText(isNode, 't');
        else if (type === 'b' && vNode) value = vNode.textContent === '1' ? 'TRUE' : 'FALSE';
        else if (vNode) value = vNode.textContent || '';
        cells[col] = value;
      }
      const cells2 = Array.from(cells, (v) => (v === undefined ? '' : v));
      maxCols = Math.max(maxCols, cells2.length);
      rows.push(cells2);
    }
    sheets.push({ name: sheetNames[si] || 'Sheet ' + (si + 1), rows: rows, cols: maxCols });
  }
  return sheets;
}

async function xlsxToHtml(file, showGrid, orientation) {
  const sheets = await xlsxToSheets(file);
  return sheets.map((sheet) => {
    const body = sheet.rows.map((row, ri) =>
      '<tr>' + Array.from({ length: sheet.cols }, (_, ci) => {
        const tag = ri === 0 ? 'th' : 'td';
        return '<' + tag + '>' + escHtml(row[ci] === undefined ? '' : row[ci]) + '</' + tag + '>';
      }).join('') + '</tr>'
    ).join('');
    return '<h2>' + escHtml(sheet.name) + '</h2><table class="' + (showGrid ? 'grid' : 'nogrid') + '"><tbody>' + body + '</tbody></table>';
  }).join('\n');
}

/* ---------------- PowerPoint (.pptx) ---------------- */

async function pptxSlides(file) {
  if (!/\.pptx$/i.test(file.name)) {
    throw new Error('Legacy .ppt files are not supported — save the presentation as .pptx first');
  }
  const zip = await unzipFile(file);
  const files = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10));
  if (!files.length) throw new Error('No slides were found in this presentation');
  const slides = [];
  for (const name of files) {
    const xml = parseXml(await zip.file(name).async('text'));
    const lines = Array.from(xml.getElementsByTagName('a:p')).map((p) => xmlNodeText(p, 'a:t').trim()).filter(Boolean);
    slides.push(lines);
  }
  return slides;
}

/* ---------------- eBooks ---------------- */

function htmlToPlain(html) {
  const withBreaks = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return String(doc.body ? doc.body.textContent : withBreaks).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function ebookChapters(file) {
  if (!/\.epub$/i.test(file.name)) {
    if (/\.(html?|xhtml)$/i.test(file.name)) return [{ title: file.name.replace(/\.[^.]+$/, ''), text: htmlToPlain(await file.text()) }];
    if (/\.txt$/i.test(file.name)) return [{ title: file.name.replace(/\.[^.]+$/, ''), text: await file.text() }];
    throw new Error('Upload an .epub, .html or .txt eBook');
  }
  const zip = await unzipFile(file);
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('This EPUB has no container.xml');
  const container = parseXml(await containerFile.async('text'));
  const rootfile = container.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile ? rootfile.getAttribute('full-path') : '';
  if (!opfPath || !zip.file(opfPath)) throw new Error('This EPUB has no package document');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parseXml(await zip.file(opfPath).async('text'));
  const manifest = {};
  Array.from(opf.getElementsByTagName('item')).forEach((it) => {
    manifest[it.getAttribute('id')] = it.getAttribute('href') || '';
  });
  const order = Array.from(opf.getElementsByTagName('itemref')).map((it) => manifest[it.getAttribute('idref')]).filter(Boolean);
  const files = order.length ? order : Object.keys(manifest).map((k) => manifest[k]);
  const chapters = [];
  for (let i = 0; i < files.length; i++) {
    const rel = files[i].split('#')[0];
    const path = base + rel;
    const zf = zip.file(path) || zip.file(decodeURI(path));
    if (!zf) continue;
    const html = await zf.async('text');
    const text = htmlToPlain(html);
    if (!text.trim()) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const h = doc.querySelector('h1,h2,h3,title');
    const heading = h && h.textContent.trim() ? h.textContent.trim() : 'Chapter ' + (chapters.length + 1);
    chapters.push({ title: heading.slice(0, 120), text: text });
  }
  if (!chapters.length) throw new Error('No readable chapters were found in this EPUB');
  return chapters;
}

/* ---------------- TIFF decoder ---------------- */

function lzwDecode(input, expected) {
  const out = new Uint8Array(expected || Math.max(1024, input.length * 4));
  let outPos = 0;
  let bitPos = 0;
  let codeWidth = 9;
  let dict = [];
  let next = 258;
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict[i] = [i];
    dict[256] = [];
    dict[257] = [];
    next = 258;
    codeWidth = 9;
  };
  reset();
  let prev = null;
  const readCode = () => {
    if (bitPos + codeWidth > input.length * 8) return 257;
    let code = 0;
    for (let i = 0; i < codeWidth; i++) {
      const bp = bitPos + i;
      code = (code << 1) | ((input[bp >> 3] >> (7 - (bp & 7))) & 1);
    }
    bitPos += codeWidth;
    return code;
  };
  while (true) {
    const code = readCode();
    if (code === 257) break;
    if (code === 256) { reset(); prev = null; continue; }
    let entry = dict[code];
    if (!entry) {
      if (!prev) break;
      entry = prev.concat([prev[0]]);
    }
    for (const b of entry) {
      if (outPos >= out.length) {
        if (expected) break;
        const bigger = new Uint8Array(out.length * 2);
        bigger.set(out);
        return bigger.subarray(0, outPos);
      }
      out[outPos++] = b;
    }
    if (outPos >= out.length && expected) break;
    if (prev) {
      dict[next++] = prev.concat([entry[0]]);
      if (next === (1 << codeWidth) && codeWidth < 12) codeWidth++;
    }
    prev = entry;
  }
  return out.subarray(0, outPos);
}

function packbitsDecode(src, expected) {
  const out = new Uint8Array(expected || src.length * 2);
  let o = 0;
  let i = 0;
  while (i < src.length && o < out.length) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) {
      const count = n + 1;
      for (let k = 0; k < count && i < src.length && o < out.length; k++) out[o++] = src[i++];
    } else if (n !== -128) {
      const count = 1 - n;
      const value = src[i++];
      for (let k = 0; k < count && o < out.length; k++) out[o++] = value;
    }
  }
  return out.subarray(0, o);
}

async function inflateZlib(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('Deflate-compressed TIFF files are not supported in this browser');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function tiffToCanvases(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 8) throw new Error('This file is not a TIFF image');
  const le = buf[0] === 0x49 && buf[1] === 0x49;
  const be = buf[0] === 0x4d && buf[1] === 0x4d;
  if (!le && !be) throw new Error('This file is not a TIFF image');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o) => (le ? view.getUint16(o, true) : view.getUint16(o, false));
  const u32 = (o) => (le ? view.getUint32(o, true) : view.getUint32(o, false));
  if (u16(2) !== 42) throw new Error('BigTIFF files are not supported');
  let ifd = u32(4);
  const canvases = [];
  let guard = 0;
  while (ifd && ifd + 2 < buf.length && guard++ < 200) {
    const count = u16(ifd);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const p = ifd + 2 + i * 12;
      const tag = u16(p);
      const type = u16(p + 2);
      const n = u32(p + 4);
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
      const size = sizes[type] || 1;
      const total = size * n;
      const valuePos = total <= 4 ? p + 8 : u32(p + 8);
      const vals = [];
      for (let k = 0; k < n; k++) {
        const q = valuePos + k * size;
        if (q >= buf.length) break;
        if (type === 3) vals.push(u16(q));
        else if (type === 4) vals.push(u32(q));
        else if (type === 5) vals.push(u32(q) / (u32(q + 4) || 1));
        else if (type === 1 || type === 6 || type === 7) vals.push(buf[q]);
        else vals.push(buf[q]);
      }
      tags[tag] = vals;
      if (tag === 34675 && type === 7) tags[tag] = vals;
    }
    const next = u32(ifd + 2 + count * 12);
    ifd = next;
    const width = (tags[256] && tags[256][0]) || 0;
    const height = (tags[257] && tags[257][0]) || 0;
    if (!width || !height) continue;
    const bits = (tags[258] && tags[258][0]) || 8;
    const compression = (tags[259] && tags[259][0]) || 1;
    const photo = (tags[262] && tags[262][0]) !== undefined ? tags[262][0] : 2;
    const offsets = tags[273] || [];
    const byteCounts = tags[279] || [];
    const samples = (tags[277] && tags[277][0]) || (photo === 2 ? 3 : 1);
    const rowsPerStrip = (tags[278] && tags[278][0]) || height;
    const planar = (tags[284] && tags[284][0]) || 1;
    if (planar !== 1) throw new Error('Planar TIFF files are not supported');
    if (bits !== 8 && bits !== 1 && bits !== 4 && bits !== 16) throw new Error('This TIFF uses ' + bits + '-bit samples, which is not supported');
    const bytesPerSample = bits === 16 ? 2 : 1;
    const rowBytes = Math.ceil((width * bits * samples) / 8);
    const full = new Uint8Array(rowBytes * height);
    let dst = 0;
    for (let s = 0; s < offsets.length; s++) {
      const rows = Math.min(rowsPerStrip, height - s * rowsPerStrip);
      if (rows <= 0) break;
      const expected = Math.ceil((width * bits * samples * rows) / 8);
      const raw = buf.subarray(offsets[s], Math.min(buf.length, offsets[s] + (byteCounts[s] || expected)));
      let strip;
      if (compression === 1) strip = raw;
      else if (compression === 32773) strip = packbitsDecode(raw, expected);
      else if (compression === 5) strip = lzwDecode(raw, expected);
      else if (compression === 8 || compression === 32946) strip = await inflateZlib(raw);
      else throw new Error('This TIFF uses compression type ' + compression + ', which is not supported');
      full.set(strip.subarray(0, Math.min(strip.length, full.length - dst)), dst);
      dst += expected;
    }
    const cmap = tags[320] || [];
    const extra = tags[338] || [];
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const out = imgData.data;
    const maxVal = bits === 16 ? 65535 : (1 << bits) - 1;
    const sampleAt = (x, y, c) => {
      const rowStart = y * rowBytes;
      if (bits === 8) return full[rowStart + (x * samples + c)];
      if (bits === 16) return ((full[rowStart + (x * samples + c) * 2] << 8) | full[rowStart + (x * samples + c) * 2 + 1]);
      const bitIndex = (x * samples + c) * bits;
      const byte = full[rowStart + (bitIndex >> 3)];
      const shift = 8 - bits - (bitIndex & 7);
      return (byte >> shift) & maxVal;
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        let r;
        let g;
        let b;
        let a = 255;
        if (photo === 3 && cmap.length) {
          const idx = sampleAt(x, y, 0);
          const n = cmap.length / 3;
          r = Math.round(((cmap[idx] || 0) / 65535) * 255);
          g = Math.round(((cmap[n + idx] || 0) / 65535) * 255);
          b = Math.round(((cmap[n * 2 + idx] || 0) / 65535) * 255);
        } else if (photo === 2 || samples >= 3) {
          r = sampleAt(x, y, 0);
          g = sampleAt(x, y, 1);
          b = sampleAt(x, y, 2);
          if (bits === 16) { r >>= 8; g >>= 8; b >>= 8; }
          if (extra.length && samples >= 4) a = Math.round((sampleAt(x, y, 3) / 255) * 255);
        } else {
          let gray = sampleAt(x, y, 0);
          if (bits === 16) gray >>= 8;
          else if (bits === 1 || bits === 4) gray = Math.round((gray / maxVal) * 255);
          if (photo === 0) gray = 255 - gray;
          r = g = b = gray;
          if (extra.length && samples >= 2) a = Math.round((sampleAt(x, y, 1) / 255) * 255);
        }
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    canvases.push(canvas);
  }
  if (!canvases.length) throw new Error('No pages could be read from this TIFF');
  return canvases;
}

/* ---------------- PDF rasterisation + splitting ---------------- */

async function pdfjsToImagePdf(src, scale, quality) {
  const out = await window.PDFLib.PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    toast('Rendering page ' + i + '/' + src.numPages);
    const page = await src.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(page, scale);
    const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', quality || 0.9)));
    const p = out.addPage([base.width, base.height]);
    p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
  }
  return out;
}

async function rasterizePdfFile(f, scale, password) {
  const src = await pdfjs().getDocument({ data: await bytesOf(f), password: password || undefined }).promise;
  return await pdfjsToImagePdf(src, scale || 2, 0.9);
}

async function splitPdfBySize(doc, limitBytes) {
  const parts = [];
  let part = await window.PDFLib.PDFDocument.create();
  let count = 0;
  const total = doc.getPageCount();
  for (let i = 0; i < total; i++) {
    const copied = await part.copyPages(doc, [i]);
    part.addPage(copied[0]);
    count++;
    const bytes = await part.save();
    if (bytes.byteLength > limitBytes) {
      if (count === 1) {
        parts.push({ bytes: bytes, pages: 1, over: true });
        part = await window.PDFLib.PDFDocument.create();
        count = 0;
      } else {
        part.removePage(part.getPageCount() - 1);
        parts.push({ bytes: await part.save(), pages: count - 1 });
        part = await window.PDFLib.PDFDocument.create();
        count = 0;
        i--;
      }
    }
  }
  if (count) parts.push({ bytes: await part.save(), pages: count });
  return parts;
}

/* ---------------- CSV, hashes, analysis ---------------- */

function csvCell(value, delim) {
  const s = value === undefined || value === null ? '' : String(value);
  if (s.includes('"') || s.includes('\n') || s.includes('\r') || s.includes(delim)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function hexFromBytes(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function shaHex(bytes, algo) {
  if (!window.crypto || !window.crypto.subtle) return '(unavailable)';
  const digest = await window.crypto.subtle.digest(algo, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return hexFromBytes(new Uint8Array(digest));
}

function md5Hex(bytes) {
  const s = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  const add32 = (a, b) => (a + b) & 0xffffffff;
  const rol = (n, c) => (n << c) | (n >>> (32 - c));
  const cmn = (q, a, b, x, s, t) => add32(rol(add32(add32(a, q), add32(x, t)), s), b);
  const ff = (a, b, c, d, x, s, t) => cmn((b & c) | (~b & d), a, b, x, s, t);
  const gg = (a, b, c, d, x, s, t) => cmn((b & d) | (c & ~d), a, b, x, s, t);
  const hh = (a, b, c, d, x, s, t) => cmn(b ^ c ^ d, a, b, x, s, t);
  const ii = (a, b, c, d, x, s, t) => cmn(c ^ (b | ~d), a, b, x, s, t);
  const blocks = [];
  const n = bytes.length;
  const bitLen = n * 8;
  const withPadding = ((n + 8) >> 6) + 1;
  for (let i = 0; i < withPadding * 16; i++) blocks[i] = 0;
  for (let i = 0; i < n; i++) blocks[i >> 2] |= bytes[i] << ((i % 4) * 8);
  blocks[n >> 2] |= 0x80 << ((n % 4) * 8);
  blocks[withPadding * 16 - 2] = bitLen;
  let a0 = 1732584193;
  let b0 = -271733879;
  let c0 = -1732584194;
  let d0 = 271733878;
  for (let i = 0; i < blocks.length; i += 16) {
    const olda = a0;
    const oldb = b0;
    const oldc = c0;
    const oldd = d0;
    a0 = ff(a0, b0, c0, d0, blocks[i], 7, -680876936); d0 = ff(d0, a0, b0, c0, blocks[i + 1], 12, -389564586);
    c0 = ff(c0, d0, a0, b0, blocks[i + 2], 17, 606105819); b0 = ff(b0, c0, d0, a0, blocks[i + 3], 22, -1044525330);
    a0 = ff(a0, b0, c0, d0, blocks[i + 4], 7, -176418897); d0 = ff(d0, a0, b0, c0, blocks[i + 5], 12, 1200080426);
    c0 = ff(c0, d0, a0, b0, blocks[i + 6], 17, -1473231341); b0 = ff(b0, c0, d0, a0, blocks[i + 7], 22, -45705983);
    a0 = ff(a0, b0, c0, d0, blocks[i + 8], 7, 1770035416); d0 = ff(d0, a0, b0, c0, blocks[i + 9], 12, -1958414417);
    c0 = ff(c0, d0, a0, b0, blocks[i + 10], 17, -42063); b0 = ff(b0, c0, d0, a0, blocks[i + 11], 22, -1990404162);
    a0 = ff(a0, b0, c0, d0, blocks[i + 12], 7, 1804603682); d0 = ff(d0, a0, b0, c0, blocks[i + 13], 12, -40341101);
    c0 = ff(c0, d0, a0, b0, blocks[i + 14], 17, -1502002290); b0 = ff(b0, c0, d0, a0, blocks[i + 15], 22, 1236535329);
    a0 = gg(a0, b0, c0, d0, blocks[i + 1], 5, -165796510); d0 = gg(d0, a0, b0, c0, blocks[i + 6], 9, -1069501632);
    c0 = gg(c0, d0, a0, b0, blocks[i + 11], 14, 643717713); b0 = gg(b0, c0, d0, a0, blocks[i], 20, -373897302);
    a0 = gg(a0, b0, c0, d0, blocks[i + 5], 5, -701558691); d0 = gg(d0, a0, b0, c0, blocks[i + 10], 9, 38016083);
    c0 = gg(c0, d0, a0, b0, blocks[i + 15], 14, -660478335); b0 = gg(b0, c0, d0, a0, blocks[i + 4], 20, -405537848);
    a0 = gg(a0, b0, c0, d0, blocks[i + 9], 5, 568446438); d0 = gg(d0, a0, b0, c0, blocks[i + 14], 9, -1019803690);
    c0 = gg(c0, d0, a0, b0, blocks[i + 3], 14, -187363961); b0 = gg(b0, c0, d0, a0, blocks[i + 8], 20, 1163531501);
    a0 = gg(a0, b0, c0, d0, blocks[i + 13], 5, -1444681467); d0 = gg(d0, a0, b0, c0, blocks[i + 2], 9, -51403784);
    c0 = gg(c0, d0, a0, b0, blocks[i + 7], 14, 1735328473); b0 = gg(b0, c0, d0, a0, blocks[i + 12], 20, -1926607734);
    a0 = hh(a0, b0, c0, d0, blocks[i + 5], 4, -378558); d0 = hh(d0, a0, b0, c0, blocks[i + 8], 11, -2022574463);
    c0 = hh(c0, d0, a0, b0, blocks[i + 11], 16, 1839030562); b0 = hh(b0, c0, d0, a0, blocks[i + 14], 23, -35309556);
    a0 = hh(a0, b0, c0, d0, blocks[i + 1], 4, -1530992060); d0 = hh(d0, a0, b0, c0, blocks[i + 4], 11, 1272893353);
    c0 = hh(c0, d0, a0, b0, blocks[i + 7], 16, -155497632); b0 = hh(b0, c0, d0, a0, blocks[i + 10], 23, -1094730640);
    a0 = hh(a0, b0, c0, d0, blocks[i + 13], 4, 681279174); d0 = hh(d0, a0, b0, c0, blocks[i], 11, -358537222);
    c0 = hh(c0, d0, a0, b0, blocks[i + 3], 16, -722436544); b0 = hh(b0, c0, d0, a0, blocks[i + 6], 23, -2081064974);
    a0 = hh(a0, b0, c0, d0, blocks[i + 9], 4, -640364487); d0 = hh(d0, a0, b0, c0, blocks[i + 12], 11, -421815835);
    c0 = hh(c0, d0, a0, b0, blocks[i + 15], 16, 530742520); b0 = hh(b0, c0, d0, a0, blocks[i + 2], 23, -995338651);
    a0 = ii(a0, b0, c0, d0, blocks[i], 6, -198630844); d0 = ii(d0, a0, b0, c0, blocks[i + 7], 10, 1126891415);
    c0 = ii(c0, d0, a0, b0, blocks[i + 14], 15, -1416354905); b0 = ii(b0, c0, d0, a0, blocks[i + 5], 21, -57434055);
    a0 = ii(a0, b0, c0, d0, blocks[i + 12], 6, 1700485571); d0 = ii(d0, a0, b0, c0, blocks[i + 3], 10, -1894986606);
    c0 = ii(c0, d0, a0, b0, blocks[i + 10], 15, -1051523); b0 = ii(b0, c0, d0, a0, blocks[i + 1], 21, -2054922799);
    a0 = ii(a0, b0, c0, d0, blocks[i + 8], 6, 1873313359); d0 = ii(d0, a0, b0, c0, blocks[i + 15], 10, -30611744);
    c0 = ii(c0, d0, a0, b0, blocks[i + 6], 15, -1560198380); b0 = ii(b0, c0, d0, a0, blocks[i + 13], 21, 1309151649);
    a0 = ii(a0, b0, c0, d0, blocks[i + 4], 6, -145523070); d0 = ii(d0, a0, b0, c0, blocks[i + 11], 10, -1120210379);
    c0 = ii(c0, d0, a0, b0, blocks[i + 2], 15, 718787259); b0 = ii(b0, c0, d0, a0, blocks[i + 9], 21, -343485551);
    a0 = add32(a0, olda);
    b0 = add32(b0, oldb);
    c0 = add32(c0, oldc);
    d0 = add32(d0, oldd);
  }
  return [a0, b0, c0, d0].map((n) => {
    let out = '';
    for (let i = 0; i < 4; i++) out += ((n >> (i * 8)) & 255).toString(16).padStart(2, '0');
    return out;
  }).join('');
}

const STOP_WORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with you your yours yourself yourselves').split(' '));

function textSentences(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return clean.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'])|\n+/).map((s) => s.trim()).filter((s) => s.length >= 20);
}

function wordsOf(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9\u0900-\u097F]{2,}/g) || [];
}

function rankText(text) {
  const sentences = textSentences(text);
  const freq = {};
  for (const s of sentences) {
    for (const w of wordsOf(s)) {
      if (STOP_WORDS.has(w) || w.length < 3) continue;
      freq[w] = (freq[w] || 0) + 1;
    }
  }
  return sentences.map((s, i) => {
    const ws = wordsOf(s).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    let score = 0;
    for (const w of new Set(ws)) score += freq[w] || 0;
    return { text: s, i: i, score: score / Math.sqrt(ws.length || 1) };
  });
}

function summarizeText(text, count) {
  const ranked = rankText(text);
  if (!ranked.length) return '';
  return ranked.slice().sort((a, b) => b.score - a.score).slice(0, count).sort((a, b) => a.i - b.i).map((s) => s.text);
}

function answerFromText(text, question, passages) {
  const qWords = Array.from(new Set(wordsOf(question).filter((w) => w.length > 2 && !STOP_WORDS.has(w))));
  if (!qWords.length) return { answer: '', hits: [] };
  const sentences = textSentences(text);
  const scored = sentences.map((s, i) => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const w of qWords) {
      if (lower.includes(w)) score += 2;
      if (lower.includes(w + 's') || lower.includes(w.replace(/s$/, ''))) score += 1;
    }
    return { text: s, i: i, score: score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const top = scored.slice(0, passages).sort((a, b) => a.i - b.i);
  return { answer: top.map((s) => '• ' + s.text).join('\n'), hits: top };
}

/* ---------------- Handwriting ---------------- */

function renderHandwritingPages(text, opts) {
  const style = opts.style || 'neat';
  const paper = opts.paper || 'ruled';
  const ink = opts.ink || '#1a2a6c';
  const W = 1240;
  const H = 1754;
  const margin = 92;
  const compact = style === 'compact';
  const lineH = compact ? 40 : 50;
  const fontSize = compact ? 25 : 30;
  const family = style === 'casual'
    ? '"Snell Roundhand", "Bradley Hand", "Segoe Script", "Comic Sans MS", cursive'
    : '"Bradley Hand", "Segoe Script", "Comic Sans MS", "Chalkboard SE", cursive';
  const pages = [];
  let canvas;
  let ctx;
  let y;
  const newPage = () => {
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf8';
    ctx.fillRect(0, 0, W, H);
    if (paper === 'ruled') {
      ctx.strokeStyle = '#c9dcf0';
      ctx.lineWidth = 1;
      for (let ly = margin + lineH; ly < H - margin; ly += lineH) {
        ctx.beginPath();
        ctx.moveTo(margin - 18, ly);
        ctx.lineTo(W - margin + 18, ly);
        ctx.stroke();
      }
      ctx.strokeStyle = '#e7b3b3';
      ctx.beginPath();
      ctx.moveTo(margin - 28, margin);
      ctx.lineTo(margin - 28, H - margin);
      ctx.stroke();
    } else if (paper === 'grid') {
      ctx.strokeStyle = '#d7e3ee';
      ctx.lineWidth = 1;
      for (let gx = margin; gx < W - margin; gx += lineH) {
        ctx.beginPath(); ctx.moveTo(gx, margin); ctx.lineTo(gx, H - margin); ctx.stroke();
      }
      for (let gy = margin; gy < H - margin; gy += lineH) {
        ctx.beginPath(); ctx.moveTo(margin, gy); ctx.lineTo(W - margin, gy); ctx.stroke();
      }
    }
    ctx.fillStyle = ink;
    ctx.textBaseline = 'alphabetic';
    pages.push(canvas);
    y = margin + lineH;
  };
  newPage();
  const paragraphs = String(text || '').split('\n');
  for (const para of paragraphs) {
    if (!para.trim()) { y += lineH * 0.6; if (y > H - margin) newPage(); continue; }
    ctx.font = fontSize + 'px ' + family;
    const words = para.split(/\s+/);
    let line = '';
    const flush = () => {
      if (!line) return;
      if (y > H - margin) newPage();
      ctx.font = fontSize + 'px ' + family;
      let x = margin;
      for (const word of line.split(' ')) {
        ctx.save();
        ctx.translate(x + (Math.random() - 0.5) * 1.6, y + (Math.random() - 0.5) * 2.2);
        ctx.rotate((Math.random() - 0.5) * 0.018);
        ctx.fillStyle = ink;
        ctx.fillText(word, 0, 0);
        ctx.restore();
        x += ctx.measureText(word + ' ').width;
      }
      y += lineH;
      line = '';
    };
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > W - margin * 2) flush();
      line = line ? line + ' ' + word : word;
    }
    flush();
    y += lineH * 0.18;
  }
  return pages;
}

/* ============================================================
   Helper block B — edit text, PII, writers, media, sharing
   ============================================================ */

function numberToWordsIndian(num) {
  const n = Math.round((Number(num) || 0) * 100) / 100;
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const two = (v) => (v < 20 ? ones[v] : tens[Math.floor(v / 10)] + (v % 10 ? '-' + ones[v % 10] : ''));
  const words = (x) => {
    const parts = [];
    const crore = Math.floor(x / 10000000);
    const lakh = Math.floor((x % 10000000) / 100000);
    const thousand = Math.floor((x % 100000) / 1000);
    const hundred = Math.floor((x % 1000) / 100);
    const rest = x % 100;
    if (crore) parts.push(two(crore) + ' crore');
    if (lakh) parts.push(two(lakh) + ' lakh');
    if (thousand) parts.push(two(thousand) + ' thousand');
    if (hundred) parts.push(ones[hundred] + ' hundred');
    if (rest) parts.push(two(rest));
    return parts.join(' ') || 'zero';
  };
  let out = words(rupees) + ' rupees';
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (paise) out += ' and ' + words(paise) + ' paise';
  return out;
}

async function pdfAllText(f) {
  const src = await openPdfjs(await bytesOf(f));
  const parts = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const tc = await page.getTextContent();
    let cur = '';
    for (const item of tc.items || []) {
      cur += item.str || '';
      if (item.hasEOL) {
        if (cur.trim()) parts.push(cur.replace(/\s+$/, ''));
        cur = '';
      }
    }
    if (cur.trim()) parts.push(cur.replace(/\s+$/, ''));
    parts.push('');
  }
  return parts.join('\n').trim();
}

function fillVoiceList() {
  const sel = document.getElementById('opt-audio-voice');
  if (!sel || !('speechSynthesis' in window)) return;
  const fill = () => {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">System default</option>' + voices
      .map((v) => '<option value="' + escHtml(v.name) + '">' + escHtml(v.name) + ' — ' + escHtml(v.lang) + '</option>')
      .join('');
    if (current) sel.value = current;
  };
  fill();
  if (!window.speechSynthesis.__ihpVoicesWired) {
    window.speechSynthesis.__ihpVoicesWired = true;
    window.speechSynthesis.addEventListener('voiceschanged', fill);
  }
}

/* ---------------- Edit PDF text ---------------- */

async function prepareEditText() {
  const f = state.files.find((x) => x.kind === 'pdf');
  const stage = document.getElementById('et-stage');
  const editor = document.getElementById('et-editor');
  if (!stage || !editor) return;
  if (!f) {
    stage.innerHTML = '<p class="muted">Upload a PDF to preview pages.</p>';
    return;
  }
  if (state.edit && state.edit.fileId === f.id) {
    await renderEditPage();
    return;
  }
  try {
    toast('Reading PDF text');
    const src = await openPdfjs(await bytesOf(f));
    state.edit = { fileId: f.id, src: src, page: 0, total: src.numPages, rendering: false, items: [], edits: [], sel: null };
    wireEditControls();
    await renderEditPage();
  } catch (e) {
    stage.innerHTML = '<p class="muted">' + escHtml(e.message || 'Could not read this PDF') + '</p>';
  }
}

function wireEditControls() {
  const prev = document.getElementById('et-prev');
  const next = document.getElementById('et-next');
  const clear = document.getElementById('et-clear');
  const go = (dir) => {
    const ed = state.edit;
    if (!ed) return;
    ed.page = Math.min(ed.total - 1, Math.max(0, ed.page + dir));
    ed.sel = null;
    renderEditPage().catch((e) => console.error(e));
  };
  if (prev && !prev.dataset.wired) { prev.dataset.wired = '1'; prev.addEventListener('click', () => go(-1)); }
  if (next && !next.dataset.wired) { next.dataset.wired = '1'; next.addEventListener('click', () => go(1)); }
  if (clear && !clear.dataset.wired) {
    clear.dataset.wired = '1';
    clear.addEventListener('click', () => {
      const ed = state.edit;
      if (!ed) return;
      ed.edits = [];
      ed.sel = null;
      const editor = document.getElementById('et-editor');
      if (editor) editor.innerHTML = '';
      renderEditPage().catch((e) => console.error(e));
    });
  }
  const stage = document.getElementById('et-stage');
  if (stage && !stage.dataset.wired) {
    stage.dataset.wired = '1';
    stage.addEventListener('click', (e) => {
      const hit = e.target.closest('.et-hit');
      if (!hit) return;
      const ed = state.edit;
      if (!ed) return;
      ed.sel = parseInt(hit.dataset.i, 10);
      renderEditEditor();
    });
  }
}

async function renderEditPage() {
  const ed = state.edit;
  const stage = document.getElementById('et-stage');
  if (!ed || !stage || ed.rendering) return;
  ed.rendering = true;
  try {
    const pageNo = ed.page + 1;
    const page = await ed.src.getPage(pageNo);
    const scale = 1.5;
    const vp = page.getViewport({ scale });
    const canvas = await renderPageToCanvas(page, scale);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items || []) {
      if (!it.str || !it.str.trim()) continue;
      const tx = pdfjs().Util.transform(vp.transform, it.transform);
      const h = (it.height || 10) * scale;
      const w = Math.max(3, (it.width || 0) * scale);
      const x = tx[4];
      const yTop = tx[5] - h * 0.94;
      const boxH = h * 1.28;
      const p1 = vp.convertToPdfPoint(x, yTop);
      const p2 = vp.convertToPdfPoint(x + w, yTop + boxH);
      const base = vp.convertToPdfPoint(tx[4], tx[5]);
      items.push({
        str: it.str,
        dx: x,
        dy: yTop,
        dw: w,
        dh: boxH,
        x: base[0],
        y: base[1],
        bx: Math.min(p1[0], p2[0]),
        by: Math.min(p1[1], p2[1]),
        bw: Math.abs(p2[0] - p1[0]),
        bh: Math.abs(p2[1] - p1[1]),
        size: Math.max(5, it.height || 10),
      });
    }
    ed.items = items;
    const label = document.getElementById('et-page-label');
    if (label) label.textContent = 'Page ' + pageNo + ' / ' + ed.total;
    const ctx = canvas.getContext('2d');
    for (const e of ed.edits) {
      if (e.page !== ed.page) continue;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(e.dx - 1, e.dy - 1, e.dw + 2, e.dh + 2);
      if (e.text) {
        ctx.fillStyle = '#14161c';
        ctx.font = Math.max(6, e.dh * 0.72) + 'px Helvetica, Arial, sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(e.text, e.dx, e.dy + e.dh * 0.82);
      }
    }
    const url = canvas.toDataURL('image/jpeg', 0.9);
    stage.innerHTML = '<div class="et-canvas-wrap" style="max-width:' + vp.width + 'px"><img src="' + url + '" alt="Page ' + pageNo + '" />' +
      items.map((it, i) => '<button type="button" class="et-hit' + (ed.sel === i ? ' active' : '') + '" data-i="' + i +
        '" style="left:' + (it.dx / vp.width * 100) + '%;top:' + (it.dy / vp.height * 100) + '%;width:' + (it.dw / vp.width * 100) + '%;height:' + (it.dh / vp.height * 100) + '%" title="' + escHtml(it.str) + '"></button>').join('') +
      '</div>';
    renderEditEditor();
  } catch (e) {
    console.error(e);
    stage.innerHTML = '<p class="muted">' + escHtml(e.message || 'Could not render this page') + '</p>';
  } finally {
    ed.rendering = false;
  }
}

function renderEditEditor() {
  const ed = state.edit;
  const editor = document.getElementById('et-editor');
  if (!ed || !editor) return;
  if (ed.sel === null || ed.sel === undefined || !ed.items[ed.sel]) {
    editor.innerHTML = '<p class="muted et-hint">Click a highlighted line to replace its text. Text replaced this way is drawn in Helvetica.</p>';
    return;
  }
  const item = ed.items[ed.sel];
  const existing = ed.edits.find((x) => x.page === ed.page && x.sel === ed.sel);
  editor.innerHTML = '<div class="et-edit-row"><p class="et-original">' + escHtml(item.str) + '</p>' +
    '<input type="text" id="et-input" value="' + escHtml(existing ? existing.text : item.str) + '" />' +
    '<button type="button" class="btn btn-sm" id="et-apply">Replace</button>' +
    '<button type="button" class="btn btn-sm" id="et-cancel">Cancel</button></div>';
  const input = document.getElementById('et-input');
  const apply = () => {
    const text = input.value;
    const keep = ed.edits.filter((x) => !(x.page === ed.page && x.sel === ed.sel));
    keep.push(Object.assign({}, item, { sel: ed.sel, page: ed.page, text: text }));
    ed.edits = keep;
    renderEditPage().catch((e) => console.error(e));
  };
  document.getElementById('et-apply')?.addEventListener('click', apply);
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    input.focus();
    input.select();
  }
  document.getElementById('et-cancel')?.addEventListener('click', () => {
    ed.sel = null;
    renderEditEditor();
  });
}

function wrapLines(text, font, size, maxWidth) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* ---------------- PII detection ---------------- */

const PII_SPECS = {
  aadhaar: { label: 'Aadhaar number', re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  pan: { label: 'PAN number', re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  card: { label: 'Card number', re: /\b(?:\d[ -]?){13,19}\b/g },
  email: { label: 'Email address', re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  phone: { label: 'Phone number', re: /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g },
  ifsc: { label: 'IFSC code', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
};

function luhnValid(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function piiEnabledTypes() {
  return Object.keys(PII_SPECS).filter((key) => document.querySelector('[data-pii="' + key + '"]')?.checked);
}

async function piiHitsOnPage(page, types, extraTerms) {
  const tc = await page.getTextContent();
  const text = (tc.items || []).map((it) => it.str || '').join(' ');
  const hits = [];
  const seen = new Set();
  const push = (type, label, value) => {
    const clean = String(value).replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const key = type + '|' + clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ type: type, label: label, value: clean });
  };
  for (const type of types) {
    const spec = PII_SPECS[type];
    if (!spec) continue;
    const re = new RegExp(spec.re.source, spec.re.flags.includes('g') ? spec.re.flags : spec.re.flags + 'g');
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 500) {
      const value = m[0];
      if (!value || !value.trim()) { re.lastIndex++; continue; }
      if (type === 'card' && !luhnValid(value)) continue;
      if (type === 'aadhaar' && /^(\d)\1{11}$/.test(value.replace(/\D/g, ''))) continue;
      push(type, spec.label, value);
    }
  }
  for (const term of extraTerms) {
    const needle = term.toLowerCase();
    if (!needle) continue;
    const hay = text.toLowerCase();
    let at = 0;
    let guard = 0;
    while ((at = hay.indexOf(needle, at)) !== -1 && guard++ < 200) {
      push('custom', 'Custom match', text.slice(at, at + term.length));
      at += Math.max(1, needle.length);
    }
  }
  return hits;
}

async function piiBoxesFor(page, hits) {
  const boxes = [];
  const seen = new Set();
  for (const hit of hits) {
    const found = await textRedactionBoxes(page, hit.value);
    for (const b of found) {
      const key = [b.x.toFixed(1), b.y.toFixed(1), b.w.toFixed(1), b.h.toFixed(1)].join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      boxes.push(b);
    }
  }
  return boxes;
}

function redactBoxesOnDoc(doc, boxesByPage) {
  const { rgb } = window.PDFLib;
  for (const key of Object.keys(boxesByPage)) {
    const page = doc.getPage(parseInt(key, 10));
    const media = page.getMediaBox();
    for (const b of boxesByPage[key]) {
      if (b.unit !== 'pt') continue;
      const x = Math.max(media.x, Math.min(media.x + media.width - 1, b.x));
      const y = Math.max(media.y, Math.min(media.y + media.height - 1, b.y));
      const w = Math.max(1, Math.min(media.x + media.width - x, b.w));
      const h = Math.max(1, Math.min(media.y + media.height - y, b.h));
      page.drawRectangle({ x: x, y: y, width: w, height: h, color: rgb(0, 0, 0) });
    }
  }
}

async function flattenPdfBytes(bytes) {
  const src = await openPdfjs(bytes);
  return await pdfjsToImagePdf(src, 2, 0.9);
}

/* Rasterise only the pages whose content changed, keeping the text layer on
   every untouched page. Ensures covered-up text cannot be recovered. */
async function flattenSelectedPages(bytes, indexes) {
  const { PDFDocument } = window.PDFLib;
  const srcDoc = await PDFDocument.load(bytes);
  const patched = await openPdfjs(bytes);
  const out = await PDFDocument.create();
  const set = new Set(indexes);
  for (let i = 0; i < srcDoc.getPageCount(); i++) {
    if (set.has(i)) {
      const page = await patched.getPage(i + 1);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, 2);
      const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', 0.92)));
      const added = out.addPage([base.width, base.height]);
      added.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    } else {
      const copied = await out.copyPages(srcDoc, [i]);
      out.addPage(copied[0]);
    }
  }
  return await out.save();
}

/* ---------------- PowerPoint writer ---------------- */

function pptxPresentationXml(slideCount, slideW, slideH) {
  const ids = [];
  for (let i = 0; i < slideCount; i++) ids.push('<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + ids.join('') + '</p:sldIdLst>' +
    '<p:sldSz cx="' + slideW + '" cy="' + slideH + '" type="' + (slideW > slideH ? 'screen16x9' : 'screen4x3') + '"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>';
}

function pptxThemeXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ihatepdf">' +
    '<a:themeElements><a:clrScheme name="ihatepdf">' +
    '<a:dk1><a:srgbClr val="111318"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="26303F"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="C43D3D"/></a:accent1><a:accent2><a:srgbClr val="1F6FEB"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="2E9E6B"/></a:accent3><a:accent4><a:srgbClr val="D9A21B"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="7A5AF8"/></a:accent5><a:accent6><a:srgbClr val="2AA7B8"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="ihatepdf"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="ihatepdf"><a:fillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '</a:fillStyleLst><a:lnStyleLst>' +
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '</a:lnStyleLst><a:effectStyleLst>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '</a:effectStyleLst><a:bgFillStyleLst>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>';
}

function pptxSpTree() {
  return '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
}

async function buildPptx(images, slideW, slideH) {
  const zip = new window.JSZip();
  const n = images.length;
  slideW = slideW || 12192000;
  slideH = slideH || 6858000;
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    Array.from({ length: n }, (_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join('') +
    '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>';
  const presRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    Array.from({ length: n }, (_, i) => '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join('') +
    '</Relationships>';
  const master = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>' + pptxSpTree() + '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>';
  const masterRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
  const layout = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
    '<p:cSld name="Blank"><p:spTree>' + pptxSpTree() + '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';
  const layoutRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>';
  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels').file('.rels', rootRels);
  zip.folder('ppt').file('presentation.xml', pptxPresentationXml(n, slideW, slideH));
  zip.folder('ppt').folder('_rels').file('presentation.xml.rels', presRels);
  zip.folder('ppt').folder('slideMasters').file('slideMaster1.xml', master);
  zip.folder('ppt').folder('slideMasters').folder('_rels').file('slideMaster1.xml.rels', masterRels);
  zip.folder('ppt').folder('slideLayouts').file('slideLayout1.xml', layout);
  zip.folder('ppt').folder('slideLayouts').folder('_rels').file('slideLayout1.xml.rels', layoutRels);
  zip.folder('ppt').folder('theme').file('theme1.xml', pptxThemeXml());
  for (let i = 0; i < n; i++) {
    const img = images[i];
    const slide = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
      '<p:cSld><p:spTree>' + pptxSpTree() +
      '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Page ' + (i + 1) + '"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>' +
      '<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      '<p:spPr><a:xfrm><a:off x="' + Math.round(img.offX) + '" y="' + Math.round(img.offY) + '"/><a:ext cx="' + Math.round(img.extX) + '" cy="' + Math.round(img.extY) + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>' +
      '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
    const slideRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image' + (i + 1) + '.png"/>' +
      '</Relationships>';
    zip.folder('ppt').folder('slides').file('slide' + (i + 1) + '.xml', slide);
    zip.folder('ppt').folder('slides').folder('_rels').file('slide' + (i + 1) + '.xml.rels', slideRels);
    zip.folder('ppt').folder('media').file('image' + (i + 1) + '.png', img.png);
  }
  return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/* ---------------- EPUB writer ---------------- */

async function buildEpub(chapters, meta) {
  const zip = new window.JSZip();
  const title = meta.title || 'Document';
  const author = meta.author || 'Unknown';
  const uidValue = 'urn:uuid:' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now().toString(16));
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const esc = (s) => xmlEsc(String(s || ''));
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const manifest = chapters.map((ch, i) => '<item id="ch' + (i + 1) + '" href="chapter' + (i + 1) + '.xhtml" media-type="application/xhtml+xml"/>').join('');
  const spine = chapters.map((ch, i) => '<itemref idref="ch' + (i + 1) + '"/>').join('');
  const navPoints = chapters.map((ch, i) => '<navPoint id="nav' + (i + 1) + '" playOrder="' + (i + 1) + '"><navLabel><text>' + esc(ch.title) + '</text></navLabel><content src="chapter' + (i + 1) + '.xhtml"/></navPoint>').join('');
  const navLis = chapters.map((ch, i) => '<li><a href="chapter' + (i + 1) + '.xhtml">' + esc(ch.title) + '</a></li>').join('');
  zip.file('OEBPS/content.opf', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:identifier id="bookid">' + esc(uidValue) + '</dc:identifier>' +
    '<dc:title>' + esc(title) + '</dc:title>' +
    '<dc:creator>' + esc(author) + '</dc:creator>' +
    '<dc:language>en</dc:language>' +
    '<meta property="dcterms:modified">' + modified + '</meta>' +
    '</metadata>' +
    '<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' +
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
    '<item id="css" href="style.css" media-type="text/css"/>' + manifest + '</manifest>' +
    '<spine toc="ncx">' + spine + '</spine></package>');
  zip.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>' + esc(title) + '</title>' +
    '<link rel="stylesheet" type="text/css" href="style.css"/></head><body><nav epub:type="toc"><h1>Contents</h1><ol>' + navLis + '</ol></nav></body></html>');
  zip.file('OEBPS/toc.ncx', '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="' + esc(uidValue) + '"/></head>' +
    '<docTitle><text>' + esc(title) + '</text></docTitle><navMap>' + navPoints + '</navMap></ncx>');
  zip.file('OEBPS/style.css', 'body{font-family:Georgia,serif;line-height:1.6;margin:1.4em;color:#111}h1{font-size:1.6em;margin:1.2em 0 .6em;line-height:1.25}p{margin:0 0 .9em;text-indent:1.4em}p.first{text-indent:0}');
  chapters.forEach((ch, i) => {
    const paragraphs = String(ch.text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const body = paragraphs.length
      ? paragraphs.map((p, pi) => '<p' + (pi === 0 ? ' class="first"' : '') + '>' + esc(p).replace(/\n/g, '<br/>') + '</p>').join('')
      : '<p class="first">(This section has no text.)</p>';
    zip.file('OEBPS/chapter' + (i + 1) + '.xhtml', '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' + esc(ch.title) + '</title>' +
      '<link rel="stylesheet" type="text/css" href="style.css"/></head><body><h1>' + esc(ch.title) + '</h1>' + body + '</body></html>');
  });
  return await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

/* ---------------- Image extraction ---------------- */

function pageObjectData(page, id) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value || null); } };
    try {
      const value = page.objs.get(id, finish);
      if (value) finish(value);
    } catch (e) {
      finish(null);
    }
    setTimeout(() => finish(null), 6000);
  });
}

function imageObjectToCanvas(img) {
  if (!img) return null;
  if (img.bitmap) {
    const c = document.createElement('canvas');
    c.width = img.width || img.bitmap.width;
    c.height = img.height || img.bitmap.height;
    c.getContext('2d').drawImage(img.bitmap, 0, 0);
    return c;
  }
  const width = img.width;
  const height = img.height;
  const data = img.data;
  if (!width || !height || !data) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  const rgba = out.data;
  const kind = img.kind;
  if (data.length === width * height * 4) {
    rgba.set(data);
  } else if (data.length === width * height * 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 255;
    }
  } else if (kind === 1 || data.length === Math.ceil(width / 8) * height) {
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const j = (y * width + x) * 4;
        rgba[j] = rgba[j + 1] = rgba[j + 2] = v;
        rgba[j + 3] = 255;
      }
    }
  } else {
    return null;
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

function canvasSignature(canvas) {
  const small = document.createElement('canvas');
  small.width = 16;
  small.height = 16;
  small.getContext('2d').drawImage(canvas, 0, 0, 16, 16);
  const d = small.getContext('2d').getImageData(0, 0, 16, 16).data;
  let h = 5381;
  for (let i = 0; i < d.length; i += 4) h = ((h * 33) ^ d[i] ^ (d[i + 1] << 3) ^ (d[i + 2] << 6)) >>> 0;
  return h.toString(16);
}

async function extractPdfImageCanvases(f, minSize) {
  const src = await openPdfjs(await bytesOf(f));
  const lib = pdfjs();
  const canvases = [];
  const seen = new Set();
  for (let pno = 1; pno <= src.numPages; pno++) {
    const page = await src.getPage(pno);
    let ops;
    try {
      ops = await page.getOperatorList();
    } catch (e) {
      continue;
    }
    const ids = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i] || [];
      if (fn === lib.OPS.paintImageXObject || fn === lib.OPS.paintJpegXObject) {
        if (typeof args[0] === 'string') ids.push(args[0]);
      } else if (fn === lib.OPS.paintInlineImageXObject) {
        const canvas = imageObjectToCanvas(args[0]);
        if (canvas && Math.max(canvas.width, canvas.height) >= minSize) {
          const sig = canvasSignature(canvas);
          if (!seen.has(sig)) { seen.add(sig); canvases.push({ canvas: canvas, page: pno }); }
        }
      }
    }
    for (const id of Array.from(new Set(ids))) {
      const obj = await pageObjectData(page, id);
      const canvas = imageObjectToCanvas(obj);
      if (!canvas) continue;
      if (Math.max(canvas.width, canvas.height) < minSize) continue;
      const sig = canvasSignature(canvas);
      if (seen.has(sig)) continue;
      seen.add(sig);
      canvases.push({ canvas: canvas, page: pno });
    }
  }
  return canvases;
}

function extractJpegStreams(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      let end = -1;
      for (let j = i + 2; j < bytes.length - 1; j++) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) { end = j + 2; break; }
      }
      if (end > i + 512) {
        out.push(bytes.subarray(i, end));
        i = end - 1;
      }
    }
  }
  return out;
}

/* ---------------- P2P sharing ---------------- */

function p2pLog(message, kind) {
  const box = document.getElementById('p2p-log');
  if (!box) return;
  const line = document.createElement('p');
  line.className = 'p2p-line' + (kind ? ' ' + kind : '');
  line.textContent = message;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function p2pEncode(payload) {
  return btoa(JSON.stringify(payload));
}

function p2pDecode(text) {
  try {
    const parsed = JSON.parse(atob(String(text).replace(/\s+/g, '')));
    if (!parsed || !parsed.type) throw new Error('bad code');
    return parsed;
  } catch (e) {
    throw new Error('That code is not valid — copy the whole block and try again');
  }
}

async function p2pGather(pc) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') finish(); });
    setTimeout(finish, 4000);
  });
}

function p2pNewConnection() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const p = state.p2p || {};
  state.p2p = p;
  p.pc = pc;
  p.role = null;
  p.received = 0;
  p.chunks = [];
  p.name = '';
  p.size = 0;
  pc.addEventListener('connectionstatechange', () => {
    p2pLog('Connection: ' + pc.connectionState);
    if (pc.connectionState === 'connected') p2pLog('Connected — ready to transfer', 'ok');
    if (pc.connectionState === 'failed') p2pLog('Connection failed. Codes expire after a while — create a new invite.', 'err');
  });
  return pc;
}

function p2pWireChannel(pc) {
  const p = state.p2p;
  pc.addEventListener('datachannel', (event) => {
    p.dc = event.channel;
    p2pAttachChannel(p.dc);
  });
}

function p2pAttachChannel(dc) {
  const p = state.p2p;
  try { dc.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }
  dc.bufferedAmountLowThreshold = 1024 * 1024;
  dc.addEventListener('open', () => {
    p2pLog('Data channel open', 'ok');
    if (p.role === 'offer') p2pSendFile().catch((e) => p2pLog('Send failed: ' + e.message, 'err'));
  });
  dc.addEventListener('close', () => p2pLog('Data channel closed'));
  dc.addEventListener('message', (event) => {
    const data = event.data;
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg.type === 'meta') {
        p.name = msg.name || 'shared-file';
        p.size = msg.size || 0;
        p.mime = msg.mime || 'application/octet-stream';
        p.received = 0;
        p.chunks = [];
        p2pLog('Receiving ' + p.name + ' (' + fmtBytes(p.size) + ')');
      } else if (msg.type === 'done') {
        p2pFinishReceive();
      } else if (msg.type === 'progress') {
        p2pLog('Sending… ' + msg.pct + '%');
      }
      return;
    }
    const buffer = data instanceof ArrayBuffer ? data : null;
    if (!buffer) return;
    p.chunks.push(buffer);
    p.received += buffer.byteLength;
    if (p.size) p2pLog('Receiving… ' + Math.min(100, Math.round((p.received / p.size) * 100)) + '%');
    if (p.size && p.received >= p.size) p2pFinishReceive();
  });
}

function p2pFinishReceive() {
  const p = state.p2p;
  if (!p || !p.chunks || !p.chunks.length) return;
  const blob = new Blob(p.chunks, { type: p.mime || 'application/octet-stream' });
  p.chunks = [];
  p.received = 0;
  const host = document.getElementById('p2p-downloads');
  if (host) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = p.name || 'shared-file';
    a.className = 'p2p-download';
    a.textContent = '⬇ Save ' + (p.name || 'shared-file') + ' (' + fmtBytes(blob.size) + ')';
    host.appendChild(a);
  }
  p2pLog('Transfer complete', 'ok');
}

async function p2pSendFile() {
  const p = state.p2p;
  const dc = p && p.dc;
  const entry = p && p.file;
  if (!dc || dc.readyState !== 'open' || !entry) return;
  const file = entry.file;
  dc.send(JSON.stringify({ type: 'meta', name: file.name, size: file.size, mime: file.type }));
  const chunkSize = 64 * 1024;
  let offset = 0;
  while (offset < file.size) {
    if (dc.bufferedAmount > 4 * 1024 * 1024) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; dc.removeEventListener('bufferedamountlow', finish); resolve(); } };
        dc.addEventListener('bufferedamountlow', finish);
        setTimeout(finish, 3000);
      });
    }
    if (dc.readyState !== 'open') { p2pLog('Channel closed before the file finished', 'err'); return; }
    const slice = file.slice(offset, offset + chunkSize);
    dc.send(await slice.arrayBuffer());
    offset += chunkSize;
    if (offset % (chunkSize * 8) === 0) p2pLog('Sending… ' + Math.min(100, Math.round((offset / file.size) * 100)) + '%');
  }
  dc.send(JSON.stringify({ type: 'done' }));
  p2pLog('File sent — waiting for the other side to save it', 'ok');
}

function wireP2P() {
  const create = document.getElementById('p2p-create');
  const accept = document.getElementById('p2p-accept');
  const connect = document.getElementById('p2p-connect');
  const copy = document.getElementById('p2p-copy');
  const reset = document.getElementById('p2p-reset');
  if (!create || create.dataset.wired) return;
  create.dataset.wired = '1';
  const local = document.getElementById('p2p-local');
  const remote = document.getElementById('p2p-remote');
  const entry = state.files[0] || null;

  create.addEventListener('click', async () => {
    try {
      if (!state.files[0]) throw new Error('Choose the file you want to send first');
      if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC');
      state.p2p = { file: state.files[0] };
      const pc = p2pNewConnection();
      state.p2p.role = 'offer';
      const dc = pc.createDataChannel('file', { ordered: true });
      state.p2p.dc = dc;
      p2pAttachChannel(dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      p2pLog('Gathering connection details…');
      await p2pGather(pc);
      if (local) local.value = p2pEncode({ type: 'offer', sdp: pc.localDescription.sdp });
      p2pLog('Invite ready — send your code, then paste their reply and press Connect', 'ok');
    } catch (e) {
      p2pLog(e.message || 'Could not create an invite', 'err');
    }
  });

  accept.addEventListener('click', () => {
    if (remote) remote.focus();
    p2pLog('Paste their invite code in “Their code”, then press Connect.');
  });

  connect.addEventListener('click', async () => {
    try {
      const code = remote ? remote.value.trim() : '';
      if (!code) throw new Error('Paste the other person’s code first');
      const payload = p2pDecode(code);
      let p = state.p2p;
      if (!p || !p.pc) { state.p2p = p = { file: state.files[0] || null }; }
      const pc = p.pc || p2pNewConnection();
      if (payload.type === 'offer') {
        if (!pc) throw new Error('Create a connection first');
        p.role = 'answer';
        p2pWireChannel(pc);
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        p2pLog('Gathering connection details…');
        await p2pGather(pc);
        if (local) local.value = p2pEncode({ type: 'answer', sdp: pc.localDescription.sdp });
        p2pLog('Reply ready — send it back, then the transfer starts', 'ok');
      } else if (payload.type === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        p2pLog('Reply accepted — waiting for the connection', 'ok');
      } else {
        throw new Error('This code is not an invite or a reply');
      }
    } catch (e) {
      p2pLog(e.message || 'Could not connect', 'err');
    }
  });

  copy.addEventListener('click', async () => {
    try {
      if (!local || !local.value) throw new Error('Create an invite first');
      await navigator.clipboard.writeText(local.value);
      p2pLog('Code copied', 'ok');
    } catch (e) {
      if (local) local.select();
      p2pLog('Select the code and copy it manually', 'err');
    }
  });

  reset.addEventListener('click', () => {
    const p = state.p2p;
    if (p && p.pc) { try { p.pc.close(); } catch (e) { /* ignore */ } }
    state.p2p = null;
    if (local) local.value = '';
    if (remote) remote.value = '';
    const log = document.getElementById('p2p-log');
    const downloads = document.getElementById('p2p-downloads');
    if (log) log.innerHTML = '';
    if (downloads) downloads.innerHTML = '';
    p2pLog('Reset — choose a file and create a new invite');
  });

  if (entry) p2pLog('Ready to send: ' + entry.name + ' (' + fmtBytes(entry.size) + ')');
}

/* ---------------- Collaborative whiteboard ---------------- */

function wireWhiteboard() {
  const canvas = document.getElementById('wb-canvas');
  if (!canvas || canvas.dataset.wired) return;
  canvas.dataset.wired = '1';
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  const wb = { canvas: canvas, ctx: ctx, strokes: strokes, channel: null };
  state.wb = wb;
  const blank = () => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  const redraw = () => {
    blank();
    for (const stroke of strokes) {
      if (!stroke.points.length) continue;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size;
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x + 0.1, stroke.points[0].y + 0.1);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.stroke();
    }
  };
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };
  const post = (msg) => {
    if (wb.channel) { try { wb.channel.postMessage(msg); } catch (e) { /* ignore */ } }
  };
  try { wb.channel = new BroadcastChannel('ihatepdf-whiteboard'); } catch (e) { wb.channel = null; }
  if (wb.channel) {
    wb.channel.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'stroke') {
        strokes.push({ color: msg.color, size: msg.size, points: msg.points, remote: true });
        redraw();
      } else if (msg.type === 'undo') {
        strokes.pop();
        redraw();
      } else if (msg.type === 'clear') {
        strokes.length = 0;
        redraw();
      }
    };
  }
  blank();
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    current = {
      color: (document.getElementById('wb-color') || {}).value || '#111111',
      size: parseInt((document.getElementById('wb-size') || {}).value, 10) || 4,
      points: [point(event)],
    };
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!current) return;
    const p = point(event);
    const last = current.points[current.points.length - 1];
    if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 1.5) return;
    current.points.push(p);
    ctx.strokeStyle = current.color;
    ctx.lineWidth = current.size;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    post({ type: 'stroke', color: current.color, size: current.size, points: [last, p] });
  });
  const stop = () => { current = null; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
  document.getElementById('wb-undo')?.addEventListener('click', () => {
    strokes.pop();
    redraw();
    post({ type: 'undo' });
  });
  document.getElementById('wb-clear')?.addEventListener('click', () => {
    strokes.length = 0;
    redraw();
    post({ type: 'clear' });
  });
  document.getElementById('wb-save')?.addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'whiteboard_ihatepdf.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Whiteboard saved as PNG');
    }, 'image/png');
  });
}

/* ---------------- Audio transcription ---------------- */

async function decodeAudioToMono16k(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('This browser cannot decode audio files');
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const target = 16000;
    if (buffer.sampleRate === target && buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0));
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) {
      const data = buffer.getChannelData(0);
      const ratio = buffer.sampleRate / target;
      const out = new Float32Array(Math.floor(data.length / ratio));
      for (let i = 0; i < out.length; i++) out[i] = data[Math.floor(i * ratio)] || 0;
      return out;
    }
    const offline = new Offline(1, Math.ceil(buffer.duration * target), target);
    const node = offline.createBufferSource();
    node.buffer = buffer;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    try { ctx.close(); } catch (e) { /* ignore */ }
  }
}

/* ---------------- Shared chapter extraction ---------------- */

async function pdfToChapters(f) {
  const src = await openPdfjs(await bytesOf(f));
  const chapters = [];
  let outline = null;
  try { outline = await src.getOutline(); } catch (e) { outline = null; }
  const outlineEntries = [];
  if (outline && outline.length) {
    const walk = async (items) => {
      for (const item of items) {
        let index = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await src.getDestination(dest);
          if (Array.isArray(dest) && dest.length) index = await src.getPageIndex(dest[0]);
        } catch (e) {
          index = null;
        }
        if (typeof index === 'number' && index >= 0) outlineEntries.push({ title: item.title || 'Section', page: index });
      }
    };
    await walk(outline);
  }
  const pageText = async (pno) => {
    const page = await src.getPage(pno);
    const tc = await page.getTextContent();
    const lines = [];
    let cur = '';
    for (const item of tc.items || []) {
      cur += item.str || '';
      if (item.hasEOL) { if (cur.trim()) lines.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  };
  if (outlineEntries.length > 1) {
    outlineEntries.sort((a, b) => a.page - b.page);
    for (let i = 0; i < outlineEntries.length; i++) {
      const start = outlineEntries[i].page;
      const end = i + 1 < outlineEntries.length ? outlineEntries[i + 1].page - 1 : src.numPages - 1;
      const lines = [];
      for (let p = start; p <= end; p++) {
        if (p > start) lines.push('');
        lines.push.apply(lines, await pageText(p + 1));
      }
      const text = lines.join('\n');
      if (text.trim()) chapters.push({ title: outlineEntries[i].title, text: text });
    }
  }
  if (!chapters.length) {
    for (let p = 1; p <= src.numPages; p++) {
      const lines = await pageText(p);
      if (!lines.length) continue;
      const first = lines[0];
      chapters.push({
        title: first.length <= 90 ? first : 'Page ' + p,
        text: lines.join('\n'),
      });
    }
  }
  return { chapters: chapters, pages: src.numPages };
}

const HANDLERS = {
  async 'merge-pdf'() {
    if (!state.files.length) throw new Error('Add at least one PDF file');
    const merged = await window.PDFLib.PDFDocument.create();
    for (const f of state.files) {
      const src = await loadDoc(f);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    const bytes = await merged.save();
    return { items: [{ name: 'merged_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Merged ' + state.files.length + ' PDF(s) — ' + fmtBytes(bytes.byteLength) };
  },

  async 'compress-pdf'() {
    const f = needPdf();
    const preset = val('#opt-preset');
    if (preset === 'light') {
      const doc = await loadDoc(f);
      const bytes = await doc.save();
      return { items: [{ name: 'compressed_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: fmtBytes(f.size) + ' → ' + fmtBytes(bytes.byteLength) };
    }
    const scale = preset === 'medium' ? 1.5 : 1.0;
    const quality = preset === 'medium' ? 0.72 : 0.5;
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Compressing page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, scale);
      const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', quality)));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    const bytes = await out.save();
    return { items: [{ name: 'compressed_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: fmtBytes(f.size) + ' → ' + fmtBytes(bytes.byteLength) };
  },

  async 'split-pdf'() {
    const f = needPdf();
    const mode = val('#opt-mode') || 'pages';
    const doc = await loadDoc(f);
    const count = doc.getPageCount();
    const items = [];
    if (mode === 'ranges') {
      const ranges = parseRanges(val('#opt-ranges'), count);
      if (!ranges.length) throw new Error('Enter valid page ranges like 1-3, 5');
      for (const r of ranges) {
        const out = await window.PDFLib.PDFDocument.create();
        const pages = await out.copyPages(doc, r.indices);
        pages.forEach((p) => out.addPage(p));
        const label = r.start === r.end ? String(r.start) : r.start + '-' + r.end;
        items.push({ name: 'split_ihatepdf_' + label + '.pdf', blob: pdfBlob(await out.save()) });
      }
    } else {
      for (let i = 0; i < count; i++) {
        const out = await window.PDFLib.PDFDocument.create();
        const pages = await out.copyPages(doc, [i]);
        out.addPage(pages[0]);
        items.push({ name: 'split_ihatepdf_page-' + (i + 1) + '.pdf', blob: pdfBlob(await out.save()) });
      }
    }
    return { items: items, note: 'Created ' + items.length + ' file(s)' };
  },

  async 'pdf-to-jpg'() {
    return await imagesFromPdf('jpeg', parseInt(val('#opt-dpi'), 10) || 150);
  },

  async 'pdf-to-png'() {
    return await imagesFromPdf('png', parseInt(val('#opt-dpi'), 10) || 150);
  },

  async 'pdf-to-zip'() {
    if (!state.files.length) throw new Error('Add at least one PDF file');
    const zip = new window.JSZip();
    const used = new Set();
    for (const f of state.files) {
      let name = f.name || 'document.pdf';
      if (used.has(name)) {
        const dot = name.toLowerCase().lastIndexOf('.pdf');
        name = dot > 0 ? name.slice(0, dot) + '-' + used.size + '.pdf' : name + '-' + used.size;
      }
      used.add(name);
      zip.file(name, f.file);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    return { items: [{ name: 'ihatepdf_pdfs.zip', blob: zipBlob }], note: 'Zipped ' + state.files.length + ' PDF(s) — ' + fmtBytes(zipBlob.size) };
  },

  async 'images-to-pdf'() {
    if (!state.files.length) throw new Error('Add at least one image');
    const doc = await window.PDFLib.PDFDocument.create();
    for (const f of state.files) {
      const png = await imageToPngBytes(f.file);
      const img = await doc.embedPng(png);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const bytes = await doc.save();
    return { items: [{ name: 'images_ihatepdf.pdf', blob: pdfBlob(bytes) }] };
  },

  async 'organize-pages'() {
    const f = needPdf();
    if (!state.pageOps) throw new Error('Add a PDF first');
    const kept = state.pageOps.filter((o) => !o.del);
    if (!kept.length) throw new Error('All pages are marked for deletion');
    const doc = await loadDoc(f);
    const out = await window.PDFLib.PDFDocument.create();
    const pages = await out.copyPages(doc, kept.map((o) => o.src));
    pages.forEach((p, i) => {
      if (kept[i].rot) p.setRotation(window.PDFLib.degrees(kept[i].rot));
      out.addPage(p);
    });
    return { items: [{ name: 'merged_organized_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: kept.length + ' page(s) kept' };
  },

  async 'rotate-pdf'() {
    const f = needPdf();
    const angle = parseInt(val('#opt-angle'), 10) || 90;
    const doc = await loadDoc(f);
    doc.getPages().forEach((p) => p.setRotation(window.PDFLib.degrees(angle)));
    return { items: [{ name: 'rotated_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }] };
  },

  async 'extract-pdf-pages'() {
    const f = needPdf();
    const indices = [...document.querySelectorAll('.page-check:checked')].map((el) => parseInt(el.value, 10)).filter((n) => !isNaN(n));
    if (!indices.length) throw new Error('Select at least one page');
    const doc = await loadDoc(f);
    const out = await window.PDFLib.PDFDocument.create();
    const pages = await out.copyPages(doc, indices);
    pages.forEach((p) => out.addPage(p));
    return { items: [{ name: 'extracted_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Extracted ' + indices.length + ' page(s)' };
  },

  async 'delete-pdf-pages'() {
    const f = needPdf();
    const doc = await loadDoc(f);
    const count = doc.getPageCount();
    const ranges = parseRanges(val('#opt-del-ranges'), count);
    if (!ranges.length) throw new Error('Enter pages to delete like 2, 5-7');
    const del = new Set(ranges.reduce((a, r) => a.concat(r.indices), []));
    const keep = [];
    for (let i = 0; i < count; i++) if (!del.has(i)) keep.push(i);
    if (!keep.length) throw new Error('You cannot delete every page');
    const out = await window.PDFLib.PDFDocument.create();
    const pages = await out.copyPages(doc, keep);
    pages.forEach((p) => out.addPage(p));
    return { items: [{ name: 'deleted_pages_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Deleted ' + del.size + ' page(s)' };
  },

  async 'pdf-size-analyzer'() {
    const f = needPdf();
    const bytes = await bytesOf(f);
    const doc = await loadDoc(f);
    const pages = doc.getPages();
    const lines = [
      'PDF Size Analyzer',
      '=================',
      'File:          ' + f.name,
      'File size:     ' + fmtBytes(bytes.byteLength),
      'Pages:         ' + pages.length,
      'Average/page:  ' + fmtBytes(Math.round(bytes.byteLength / Math.max(1, pages.length))),
      '',
      'Page dimensions (points):',
    ];
    pages.slice(0, 40).forEach((page, i) => {
      const { width, height } = page.getSize();
      const w = Math.round(width);
      const h = Math.round(height);
      const dims = (w + ' × ' + h).padEnd(14);
      const portrait = height >= width;
      const standard = (w === 595 || w === 596) && (h === 841 || h === 842) ? 'A4' : (w === 612 && h === 792) ? 'Letter' : (w === 420 && h === 595) ? 'A5' : '';
      lines.push('  ' + String(i + 1).padStart(3) + '.  ' + dims + (portrait ? 'portrait ' : 'landscape') + (standard ? ' · ' + standard : ''));
    });
    if (pages.length > 40) lines.push('  … and ' + (pages.length - 40) + ' more page(s)');
    return { text: lines.join('\n'), note: 'Analyzed ' + f.name };
  },

  async 'alternate-mix-pdf'() {
    if (state.files.length < 2) throw new Error('Add at least two PDF files to mix');
    const docs = [];
    for (const f of state.files) docs.push(await loadDoc(f));
    const out = await window.PDFLib.PDFDocument.create();
    const max = Math.max.apply(null, docs.map((d) => d.getPageCount()));
    for (let i = 0; i < max; i++) {
      for (const doc of docs) {
        if (i < doc.getPageCount()) {
          const pages = await out.copyPages(doc, [i]);
          out.addPage(pages[0]);
        }
      }
    }
    return { items: [{ name: 'mixed_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Interleaved ' + docs.length + ' PDF(s)' };
  },

  async 'flip-pdf'() {
    const f = needPdf();
    const dir = val('#opt-flip-direction') || 'horizontal';
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Flipping page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, 2);
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const ctx = tmp.getContext('2d');
      if (dir === 'vertical') { ctx.translate(0, tmp.height); ctx.scale(1, -1); }
      else if (dir === 'both') { ctx.translate(tmp.width, tmp.height); ctx.scale(-1, -1); }
      else { ctx.translate(tmp.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(canvas, 0, 0);
      const img = await out.embedJpg(dataUrlToUint8(tmp.toDataURL('image/jpeg', 0.92)));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    return { items: [{ name: 'flipped_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Flipped ' + src.numPages + ' page(s) ' + dir };
  },

  async 'multiple-pages-per-sheet'() {
    const f = needPdf();
    const per = parseInt(val('#opt-nup'), 10) || 4;
    const sheet = val('#opt-nup-size') || 'a4';
    const pageW = sheet === 'letter' ? 792 : 842;
    const pageH = sheet === 'letter' ? 612 : 595;
    const cols = per === 2 ? 2 : per === 6 ? 3 : per === 9 ? 3 : 2;
    const rows = per === 2 ? 1 : per === 6 ? 2 : per === 9 ? 3 : 2;
    const scaleFactor = 2;
    const W = pageW * scaleFactor;
    const H = pageH * scaleFactor;
    const slotW = W / cols;
    const slotH = H / rows;
    const pad = 10 * scaleFactor;
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let start = 1; start <= src.numPages; start += per) {
      const sheetCanvas = document.createElement('canvas');
      sheetCanvas.width = W;
      sheetCanvas.height = H;
      const sctx = sheetCanvas.getContext('2d');
      sctx.fillStyle = '#ffffff';
      sctx.fillRect(0, 0, W, H);
      for (let slot = 0; slot < per; slot++) {
        const pageNo = start + slot;
        if (pageNo > src.numPages) break;
        const page = await src.getPage(pageNo);
        const vp = page.getViewport({ scale: 1 });
        const fit = Math.min((slotW - pad * 2) / vp.width, (slotH - pad * 2) / vp.height);
        const canvas = await renderPageToCanvas(page, fit * scaleFactor);
        const w = vp.width * fit;
        const h = vp.height * fit;
        const cx = (slot % cols) * slotW + (slotW - w) / 2;
        const cy = Math.floor(slot / cols) * slotH + (slotH - h) / 2;
        sctx.drawImage(canvas, cx, cy, w, h);
      }
      const img = await out.embedJpg(dataUrlToUint8(sheetCanvas.toDataURL('image/jpeg', 0.9)));
      const p = out.addPage([pageW, pageH]);
      p.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
      toast('Built sheet ' + Math.ceil(start / per) + '/' + Math.ceil(src.numPages / per));
    }
    return { items: [{ name: 'n-up_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Placed ' + src.numPages + ' page(s) at ' + per + ' per sheet' };
  },

  async 'repair-pdf'() {
    const f = needPdf();
    const doc = await loadDoc(f);
    const pages = doc.getPageCount();
    return { items: [{ name: 'repaired_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }], note: 'Rebuilt ' + pages + ' page(s)' };
  },

  async 'add-watermark'() {
    const f = needPdf();
    const text = val('#opt-wm-text').trim();
    if (!text) throw new Error('Enter watermark text');
    const opacity = parseFloat(val('#opt-wm-opacity')) || 0.2;
    const angle = parseInt(val('#opt-wm-angle'), 10) || 0;
    const doc = await loadDoc(f);
    const font = await doc.embedFont(window.PDFLib.StandardFonts.HelveticaBold);
    const size = 44;
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const w = font.widthOfTextAtSize(text, size);
      page.drawText(text, {
        x: (width - w) / 2,
        y: height / 2 - size / 3,
        size: size,
        font: font,
        color: window.PDFLib.rgb(0.5, 0.5, 0.5),
        opacity: opacity,
        rotate: window.PDFLib.degrees(angle),
      });
    }
    return { items: [{ name: 'watermarked_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }] };
  },

  async 'page-numbers'() {
    const f = needPdf();
    const pos = val('#opt-pn-pos') || 'bottom-center';
    const start = parseInt(val('#opt-pn-start'), 10) || 1;
    const doc = await loadDoc(f);
    const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
    const size = 10;
    doc.getPages().forEach((page, i) => {
      const label = String(start + i);
      const { width, height } = page.getSize();
      const tw = font.widthOfTextAtSize(label, size);
      const x = pos.indexOf('right') >= 0 ? width - 40 - tw : pos.indexOf('left') >= 0 ? 40 : (width - tw) / 2;
      const y = pos.indexOf('top') === 0 ? height - 30 : 24;
      page.drawText(label, { x: x, y: y, size: size, font: font, color: window.PDFLib.rgb(0.2, 0.2, 0.2) });
    });
    return { items: [{ name: 'numbered_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }] };
  },

  async 'headers-footers'() {
    const f = needPdf();
    const header = val('#opt-hf-header').trim();
    const footer = val('#opt-hf-footer').trim();
    const numbers = !!document.querySelector('#opt-hf-numbers')?.checked;
    if (!header && !footer && !numbers) throw new Error('Enter header or footer text');
    const size = Math.min(24, Math.max(6, parseInt(val('#opt-hf-size'), 10) || 9));
    const doc = await loadDoc(f);
    const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
    const color = window.PDFLib.rgb(0.35, 0.35, 0.35);
    doc.getPages().forEach((page, i) => {
      const { width, height } = page.getSize();
      if (header) page.drawText(header, { x: 36, y: height - 26, size: size, font: font, color: color });
      const foot = [footer, numbers ? String(i + 1) : ''].filter(Boolean).join('   ·   ');
      if (foot) page.drawText(foot, { x: 36, y: 22, size: size, font: font, color: color });
    });
    return { items: [{ name: 'headers_footers_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }] };
  },

  async 'bates-numbering'() {
    const f = needPdf();
    const prefix = val('#opt-bates-prefix');
    const start = Math.max(0, parseInt(val('#opt-bates-start'), 10) || 0);
    const digits = Math.min(12, Math.max(1, parseInt(val('#opt-bates-digits'), 10) || 6));
    const pos = val('#opt-bates-pos') || 'bottom-right';
    const doc = await loadDoc(f);
    const font = await doc.embedFont(window.PDFLib.StandardFonts.HelveticaBold);
    const size = 9;
    doc.getPages().forEach((page, i) => {
      const label = prefix + String(start + i).padStart(digits, '0');
      const { width } = page.getSize();
      const tw = font.widthOfTextAtSize(label, size);
      const x = pos === 'bottom-right' ? width - 36 - tw : pos === 'bottom-left' ? 36 : (width - tw) / 2;
      page.drawText(label, { x: x, y: 22, size: size, font: font, color: window.PDFLib.rgb(0.15, 0.15, 0.15) });
    });
    return { items: [{ name: 'bates_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }], note: 'Numbered ' + doc.getPageCount() + ' page(s)' };
  },

  async 'edit-pdf-metadata'() {
    const f = needPdf();
    const doc = await loadDoc(f);
    doc.setTitle(val('#opt-meta-title'));
    doc.setAuthor(val('#opt-meta-author'));
    doc.setSubject(val('#opt-meta-subject'));
    doc.setKeywords(String(val('#opt-meta-keywords') || '').split(',').map((s) => s.trim()).filter(Boolean));
    doc.setProducer('ihatepdf.cv (local)');
    return { items: [{ name: 'metadata_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }], note: 'Metadata updated' };
  },

  async 'flatten-pdf'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Flattening page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, 2);
      const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', 0.92)));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    return { items: [{ name: 'flattened_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Flattened ' + src.numPages + ' page(s)' };
  },

  async 'extract-text'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const parts = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      parts.push('--- Page ' + i + ' ---\n' + tc.items.map((it) => it.str).join(' '));
    }
    const text = parts.join('\n\n');
    return { items: [{ name: 'extracted_text_ihatepdf.txt', blob: new Blob([text], { type: 'text/plain' }) }], text: text, note: 'Extracted text from ' + src.numPages + ' page(s)' };
  },

  async 'pdf-to-html'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const sections = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      const lines = [];
      let line = '';
      for (const item of tc.items) {
        line += item.str || '';
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
      }
      if (line.trim()) lines.push(line.trim());
      const body = lines.length ? lines.map((l) => escHtml(l)).join('<br />\n') : '<em>No text layer found on this page.</em>';
      sections.push('<section>\n<h2>Page ' + i + '</h2>\n<p>' + body + '</p>\n</section>');
    }
    const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>' + escHtml(f.name) + '</title>\n<style>body{font-family:Georgia,serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.65;color:#111}h1{font-size:24px}h2{font-size:16px;color:#555;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:6px}</style>\n</head>\n<body>\n<h1>' + escHtml(f.name) + '</h1>\n' + sections.join('\n') + '\n</body>\n</html>';
    return { items: [{ name: 'converted_ihatepdf.html', blob: new Blob([html], { type: 'text/html' }) }], note: 'Converted ' + src.numPages + ' page(s) to HTML' };
  },

  async 'ocr-pdf'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const worker = await window.Tesseract.createWorker('eng');
    const parts = [];
    try {
      for (let i = 1; i <= src.numPages; i++) {
        toast('OCR — page ' + i + ' of ' + src.numPages);
        const page = await src.getPage(i);
        const canvas = await renderPageToCanvas(page, 2);
        const { data } = await worker.recognize(canvas);
        parts.push('--- Page ' + i + ' ---\n' + (data && data.text ? data.text : ''));
      }
    } finally {
      await worker.terminate();
    }
    const text = parts.join('\n\n');
    return { items: [{ name: 'ocr_ihatepdf.txt', blob: new Blob([text], { type: 'text/plain' }) }], text: text, note: 'OCR complete' };
  },

  async 'invert-pdf'() {
    const f = needPdf();
    const mode = val('#opt-invert') || 'invert';
    const filter = mode === 'grayscale' ? 'grayscale(1)' : mode === 'sepia' ? 'sepia(1)' : 'invert(1)';
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Processing page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, 2);
      const tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = canvas.height;
      const tctx = tmp.getContext('2d');
      tctx.filter = filter;
      tctx.drawImage(canvas, 0, 0);
      const img = await out.embedPng(dataUrlToUint8(tmp.toDataURL('image/png')));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    return { items: [{ name: 'inverted_ihatepdf.pdf', blob: pdfBlob(await out.save()) }] };
  },

  async 'create-pdf'() {
    const text = val('#text-input');
    if (!text.trim()) throw new Error('Write some content first');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    writeTextToPdf(doc, text);
    return { items: [{ name: 'created_ihatepdf.pdf', blob: doc.output('blob') }] };
  },

  async 'markdown-to-pdf'() {
    const md = val('#text-input');
    if (!md.trim()) throw new Error('Enter some Markdown first');
    const blob = await htmlToPdfBlob(mdToHtml(md));
    return { items: [{ name: 'markdown_ihatepdf.pdf', blob: blob }] };
  },

  async 'csv-to-pdf'() {
    const text = val('#text-input');
    const rows = parseCsv(text);
    if (!rows.length) throw new Error('No CSV rows found');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    const pageW = 595.28;
    const pageH = 841.89;
    const cols = Math.max.apply(null, rows.map((r) => r.length));
    const colW = (pageW - margin * 2) / cols;
    let y = 60;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    rows.forEach((row, ri) => {
      if (y > pageH - 40) { doc.addPage(); y = 60; }
      if (ri === 0) doc.setFont('helvetica', 'bold'); else doc.setFont('helvetica', 'normal');
      for (let ci = 0; ci < cols; ci++) {
        const cell = row[ci] === undefined ? '' : String(row[ci]);
        doc.text(doc.splitTextToSize(cell, colW - 8).slice(0, 2), margin + ci * colW + 3, y);
      }
      doc.setDrawColor(220);
      doc.line(margin, y + 5, pageW - margin, y + 5);
      y += 18;
    });
    return { items: [{ name: 'csv_ihatepdf.pdf', blob: doc.output('blob') }] };
  },

  async 'txt-to-pdf'() {
    const text = val('#text-input');
    if (!text.trim()) throw new Error('Add some text first');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    writeTextToPdf(doc, text);
    return { items: [{ name: 'text_ihatepdf.pdf', blob: doc.output('blob') }] };
  },

  async 'html-to-pdf'() {
    const html = val('#text-input');
    if (!html.trim()) throw new Error('Enter some HTML first');
    const blob = await htmlToPdfBlob(html);
    return { items: [{ name: 'html_ihatepdf.pdf', blob: blob }] };
  },

  /* ---------------- Signatures ---------------- */

  async 'sign-pdf'() {
    const f = needPdf();
    const sig = readSignatureCanvas();
    if (!sig) throw new Error('Draw or type a signature first');
    const doc = await loadDoc(f);
    const png = await canvasToBlob(sig, 'image/png');
    const img = await doc.embedPng(new Uint8Array(await png.arrayBuffer()));
    const target = val('#opt-sig-page') || 'last';
    const pos = val('#opt-sig-pos') || 'bottom-right';
    const wanted = Math.min(500, Math.max(40, parseFloat(val('#opt-sig-width')) || 170));
    const pages = doc.getPages();
    const chosen = target === 'all' ? pages : target === 'first' ? [pages[0]] : [pages[pages.length - 1]];
    for (const page of chosen) {
      const { width, height } = page.getSize();
      const w = Math.min(wanted, Math.max(40, width - 72));
      const h = w * (sig.height / sig.width);
      const margin = 36;
      let x = margin;
      let y = margin;
      if (pos === 'bottom-right') x = width - margin - w;
      else if (pos === 'bottom-center') x = (width - w) / 2;
      else if (pos === 'top-right') { x = width - margin - w; y = height - margin - h; }
      page.drawImage(img, { x: x, y: y, width: w, height: h });
    }
    const bytes = await doc.save();
    return { items: [{ name: 'signed_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Signed ' + chosen.length + ' page(s)' };
  },

  /* ---------------- Forms ---------------- */

  async 'fill-pdf-form'() {
    const f = needPdf();
    const doc = await loadDoc(f);
    const L = window.PDFLib;
    const form = doc.getForm();
    if (!form.getFields().length) throw new Error('This PDF has no fillable form fields');
    const inputs = Array.from(document.querySelectorAll('[data-form]'));
    if (!inputs.length) throw new Error('No fillable fields were detected — try re-uploading the PDF');
    let filled = 0;
    for (const el of inputs) {
      const name = el.dataset.form;
      let field = null;
      try { field = form.getField(name); } catch (e) { field = null; }
      if (!field) continue;
      try {
        if (field instanceof L.PDFTextField) {
          field.setText(el.value);
          filled++;
        } else if (field instanceof L.PDFCheckBox) {
          if (el.checked) field.check(); else field.uncheck();
          filled++;
        } else if (field instanceof L.PDFDropdown || field instanceof L.PDFRadioGroup || field instanceof L.PDFOptionList) {
          if (el.value) { field.select(el.value); filled++; }
        }
      } catch (e) {
        console.warn('Could not fill field: ' + name, e);
      }
    }
    if (!filled) throw new Error('No form values were changed');
    try { form.updateFieldAppearances(); } catch (e) { console.warn('Could not refresh appearances', e); }
    if (document.querySelector('#opt-form-flatten')?.checked) {
      try { form.flatten(); } catch (e) { console.warn('Could not flatten form', e); }
    }
    const bytes = await doc.save();
    return { items: [{ name: 'filled_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Filled ' + filled + ' field(s)' };
  },

  /* ---------------- Compare ---------------- */

  async 'compare-pdfs'() {
    if (state.files.length < 2) throw new Error('Add two PDFs to compare');
    const a = state.files[0];
    const b = state.files[1];
    const A = await pdfTextLines(a);
    const B = await pdfTextLines(b);
    if (!A.lines.length && !B.lines.length) {
      throw new Error('No extractable text in either PDF — scanned documents need OCR first');
    }
    const ops = diffLines(A.lines, B.lines);
    const html = diffHtmlReport(a.name, b.name, ops, A.pages, B.pages);
    const added = ops.filter((o) => o.t === 'add').length;
    const removed = ops.filter((o) => o.t === 'del').length;
    const plain = diffTextReport(ops);
    return {
      items: [
        { name: 'comparison_ihatepdf.html', blob: new Blob([html], { type: 'text/html' }) },
        { name: 'comparison_ihatepdf.txt', blob: new Blob([plain], { type: 'text/plain' }) },
      ],
      text: plain.slice(0, 20000),
      note: added + ' added, ' + removed + ' removed line(s)',
    };
  },

  /* ---------------- Crop & Resize ---------------- */

  async 'crop-resize-pdf'() {
    const f = needPdf();
    const mode = val('#opt-cr-mode') || 'crop';
    const doc = await loadDoc(f);
    const mm = 72 / 25.4;

    if (mode === 'crop') {
      const top = parseFloat(val('#opt-cr-top')) || 0;
      const right = parseFloat(val('#opt-cr-right')) || 0;
      const bottom = parseFloat(val('#opt-cr-bottom')) || 0;
      const left = parseFloat(val('#opt-cr-left')) || 0;
      if (top + right + bottom + left <= 0) throw new Error('Set at least one margin');
      let changed = 0;
      for (const page of doc.getPages()) {
        const box = page.getCropBox();
        const nx = box.x + left * mm;
        const ny = box.y + bottom * mm;
        const nw = box.width - (left + right) * mm;
        const nh = box.height - (top + bottom) * mm;
        if (nw > 20 && nh > 20) {
          page.setCropBox(nx, ny, nw, nh);
          changed++;
        }
      }
      if (!changed) throw new Error('Those margins are too large for these pages');
      const bytes = await doc.save();
      return { items: [{ name: 'cropped_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Cropped ' + changed + ' page(s)' };
    }

    const size = val('#opt-cr-size') || 'a4';
    const dims = size === 'letter' ? [612, 792] : size === 'a5' ? [420, 595] : [595, 842];
    const keep = !!document.querySelector('#opt-cr-keep')?.checked;
    const first = doc.getPage(0);
    if (typeof first.scaleContent !== 'function') throw new Error('This build of pdf-lib cannot scale page content');
    for (const page of doc.getPages()) {
      const s = page.getSize();
      const sx = dims[0] / s.width;
      const sy = dims[1] / s.height;
      if (keep) {
        const k = Math.min(sx, sy);
        page.scaleContent(k, k);
        page.translateContent((dims[0] - s.width * k) / 2, (dims[1] - s.height * k) / 2);
      } else {
        page.scaleContent(sx, sy);
      }
      page.setSize(dims[0], dims[1]);
    }
    const bytes = await doc.save();
    return { items: [{ name: 'resized_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Resized ' + doc.getPageCount() + ' page(s) to ' + size.toUpperCase() };
  },

  /* ---------------- Redaction ---------------- */

  async 'redact-pdf'() {
    const f = needPdf();
    const r = state.redact && state.redact.fileId === f.id ? state.redact : null;
    const terms = String(val('#opt-redact-terms') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const doc = await loadDoc(f);
    const pages = doc.getPages();
    const boxesByPage = {};
    if (r) {
      for (const key of Object.keys(r.boxes)) {
        if (r.boxes[key] && r.boxes[key].length) boxesByPage[key] = r.boxes[key].slice();
      }
    }
    if (terms.length) {
      const src = await openPdfjs(await bytesOf(f));
      for (let i = 0; i < pages.length; i++) {
        const page = await src.getPage(i + 1);
        for (const term of terms) {
          const found = await textRedactionBoxes(page, term);
          if (found.length) boxesByPage[i] = (boxesByPage[i] || []).concat(found);
        }
      }
    }
    const total = Object.values(boxesByPage).reduce((a, b) => a + b.length, 0);
    if (!total) throw new Error('Draw a box on the preview or enter words to redact');

    /* Manual boxes are normalised against the rendered preview. Convert them
       through the pdf.js viewport so rotation and crop offsets are honoured. */
    let srcForBoxes = null;
    if (Object.keys(boxesByPage).some((k) => (boxesByPage[k] || []).some((b) => b.unit !== 'pt'))) {
      srcForBoxes = await openPdfjs(await bytesOf(f));
    }

    const { rgb } = window.PDFLib;
    for (const key of Object.keys(boxesByPage)) {
      const page = pages[parseInt(key, 10)];
      if (!page) continue;
      const box = page.getMediaBox();
      let vp = null;
      if (srcForBoxes) {
        try {
          const jp = await srcForBoxes.getPage(parseInt(key, 10) + 1);
          vp = jp.getViewport({ scale: 1 });
        } catch (e) { vp = null; }
      }
      for (const b of boxesByPage[key]) {
        let x;
        let y;
        let w;
        let h;
        if (b.unit === 'pt') {
          x = b.x; y = b.y; w = b.w; h = b.h;
        } else if (vp) {
          const p1 = vp.convertToPdfPoint(b.x * vp.width, b.y * vp.height);
          const p2 = vp.convertToPdfPoint((b.x + b.w) * vp.width, (b.y + b.h) * vp.height);
          x = Math.min(p1[0], p2[0]);
          y = Math.min(p1[1], p2[1]);
          w = Math.abs(p2[0] - p1[0]);
          h = Math.abs(p2[1] - p1[1]);
        } else {
          x = box.x + b.x * box.width;
          w = b.w * box.width;
          h = b.h * box.height;
          y = box.y + (1 - b.y - b.h) * box.height;
        }
        x = Math.max(box.x, Math.min(box.x + box.width - 1, x));
        y = Math.max(box.y, Math.min(box.y + box.height - 1, y));
        w = Math.max(1, Math.min(box.x + box.width - x, w));
        h = Math.max(1, Math.min(box.y + box.height - y, h));
        page.drawRectangle({ x: x, y: y, width: w, height: h, color: rgb(0, 0, 0) });
      }
    }

    const flatten = !!document.querySelector('#opt-redact-flatten')?.checked;
    let bytes = await doc.save();
    if (flatten) {
      const src = await openPdfjs(bytes);
      const out = await window.PDFLib.PDFDocument.create();
      for (let i = 1; i <= src.numPages; i++) {
        toast('Flattening page ' + i + '/' + src.numPages);
        const page = await src.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const canvas = await renderPageToCanvas(page, 2);
        const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', 0.92)));
        const p = out.addPage([base.width, base.height]);
        p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
      }
      bytes = await out.save();
    }
    return { items: [{ name: 'redacted_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Redacted ' + total + ' area(s)' + (flatten ? ' · flattened' : '') };
  },

  /* ---------------- Password removal ---------------- */

  async 'remove-password'() {
    const f = needPdf();
    const raw = await bytesOf(f);
    const encrypted = pageHasEncryption(raw);
    const password = val('#opt-pw-password');
    const forceRaster = !!document.querySelector('#opt-pw-rasterize')?.checked;

    if (!encrypted && !forceRaster) {
      const doc = await loadDoc(f);
      const bytes = await doc.save();
      return { items: [{ name: 'unlocked_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'This PDF was not encrypted — re-saved ' + f.name };
    }

    let src;
    try {
      src = await pdfjs().getDocument({ data: raw, password: password }).promise;
    } catch (e) {
      if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) {
        throw new Error('Wrong password — or this document needs a password to open');
      }
      throw e;
    }
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Rebuilding page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(page, 2);
      const img = await out.embedJpg(dataUrlToUint8(canvas.toDataURL('image/jpeg', 0.92)));
      const p = out.addPage([base.width, base.height]);
      p.drawImage(img, { x: 0, y: 0, width: base.width, height: base.height });
    }
    const bytes = await out.save();
    return { items: [{ name: 'unlocked_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Rebuilt ' + src.numPages + ' page(s) without encryption' };
  },

  /* ---------------- Document scanning ---------------- */

  async 'scan-to-pdf'() {
    const canvases = [];
    for (const f of state.files.filter((x) => x.kind === 'image')) canvases.push(await imageFileToCanvas(f.file));
    for (const c of state.scans) canvases.push(c);
    if (!canvases.length) throw new Error('Capture a page with the camera or upload photos first');
    const mode = val('#opt-scan-filter') || 'bw';
    const size = val('#opt-scan-size') || 'a4';
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 0; i < canvases.length; i++) {
      toast('Processing page ' + (i + 1) + '/' + canvases.length);
      const filtered = applyScanFilter(canvases[i], mode);
      const img = await out.embedJpg(dataUrlToUint8(filtered.toDataURL('image/jpeg', 0.92)));
      if (size === 'fit') {
        const w = filtered.width * 0.5;
        const h = filtered.height * 0.5;
        const p = out.addPage([w, h]);
        p.drawImage(img, { x: 0, y: 0, width: w, height: h });
      } else {
        const W = 595;
        const H = 842;
        const margin = 24;
        const p = out.addPage([W, H]);
        const k = Math.min((W - margin * 2) / filtered.width, (H - margin * 2) / filtered.height);
        const w = filtered.width * k;
        const h = filtered.height * k;
        p.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
      }
    }
    const bytes = await out.save();
    return { items: [{ name: 'scanned_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Scanned ' + canvases.length + ' page(s)' };
  },

  /* ---------------- Office formats ---------------- */

  async 'pdf-to-word'() {
    const f = needPdf();
    const res = await docxFromPdf(f);
    if (!res.pages) throw new Error('Could not read the PDF');
    if (!res.lines) throw new Error('This PDF has no extractable text — scanned pages need OCR first');
    return { items: [{ name: 'converted_ihatepdf.docx', blob: res.blob }], note: 'Converted ' + res.pages + ' page(s) to Word' };
  },

  async 'pdf-to-tiff'() {
    const f = needPdf();
    const dpi = parseInt(val('#opt-tiff-dpi'), 10) || 150;
    const src = await openPdfjs(await bytesOf(f));
    const images = [];
    for (let i = 1; i <= src.numPages; i++) {
      toast('Rendering page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const canvas = await renderPageToCanvas(page, dpi / 72);
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (let p = 0, q = 0; p < data.length; p += 4, q += 3) {
        rgb[q] = data[p];
        rgb[q + 1] = data[p + 1];
        rgb[q + 2] = data[p + 2];
      }
      images.push({ width: canvas.width, height: canvas.height, rgb: rgb });
    }
    const bytes = encodeTiff(images, dpi);
    return { items: [{ name: 'converted_ihatepdf.tiff', blob: new Blob([bytes], { type: 'image/tiff' }) }], note: 'Exported ' + images.length + ' page(s) at ' + dpi + ' DPI' };
  },

  async 'pdf-to-excel'() {
    const f = needPdf();
    const mode = val('#opt-xlsx-mode') || 'items';
    const res = await xlsxFromPdf(f, mode);
    if (!res.rows) throw new Error('This PDF has no extractable text — scanned pages need OCR first');
    return { items: [{ name: 'converted_ihatepdf.xlsx', blob: res.blob }], note: 'Converted ' + res.pages + ' page(s), ' + res.rows + ' row(s)' };
  },

  /* ---------------- Split variants ---------------- */

  async 'split-pdf-by-text'() {
    const f = needPdf();
    const term = val('#opt-sbt-text').trim();
    if (!term) throw new Error('Type the phrase that marks a new section');
    const mode = val('#opt-sbt-mode') || 'before';
    const src = await openPdfjs(await bytesOf(f));
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const needle = norm(term);
    const matches = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      if (norm(tc.items.map((it) => it.str || '').join(' ')).includes(needle)) matches.push(i - 1);
    }
    if (!matches.length) throw new Error('No page contains “' + term + '” — nothing to split');
    const doc = await loadDoc(f);
    const total = doc.getPageCount();
    const ranges = [];
    let start = 0;
    for (const m of matches) {
      if (mode === 'before') {
        if (m > start) ranges.push([start, m - 1]);
        start = m;
      } else {
        ranges.push([start, m]);
        start = m + 1;
      }
    }
    if (start < total) ranges.push([start, total - 1]);
    const items = [];
    let n = 0;
    for (const range of ranges) {
      if (range[1] < range[0]) continue;
      const indices = [];
      for (let i = range[0]; i <= range[1]; i++) indices.push(i);
      const out = await window.PDFLib.PDFDocument.create();
      const pages = await out.copyPages(doc, indices);
      pages.forEach((p) => out.addPage(p));
      n++;
      items.push({ name: 'split_text_' + n + '.pdf', blob: pdfBlob(await out.save()) });
    }
    return { items: items, note: 'Created ' + items.length + ' file(s) from ' + matches.length + ' matching page(s)' };
  },

  async 'split-pdf-by-bookmarks'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const outline = await src.getOutline();
    if (!outline || !outline.length) throw new Error('This PDF has no bookmarks or outline');
    const topOnly = !!document.querySelector('#opt-bookmarks-top')?.checked;
    const merge = !!document.querySelector('#opt-bookmarks-merge')?.checked;
    const entries = [];
    const walk = async (items) => {
      for (const item of items) {
        let index = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await src.getDestination(dest);
          if (Array.isArray(dest) && dest.length) index = await src.getPageIndex(dest[0]);
        } catch (e) {
          index = null;
        }
        if (typeof index === 'number' && index >= 0) {
          entries.push({ title: item.title || 'Section', page: index });
        }
        if (!topOnly && item.items && item.items.length) await walk(item.items);
      }
    };
    await walk(outline);
    if (!entries.length) throw new Error('Bookmarks were found, but none point to a page');
    entries.sort((a, b) => a.page - b.page);
    const doc = await loadDoc(f);
    const total = doc.getPageCount();
    const sections = [];
    for (let i = 0; i < entries.length; i++) {
      const start = entries[i].page;
      const end = i + 1 < entries.length ? entries[i + 1].page - 1 : total - 1;
      if (end >= start) sections.push({ title: entries[i].title, start: start, end: end });
    }
    if (merge) {
      const out = await window.PDFLib.PDFDocument.create();
      for (const section of sections) {
        const indices = [];
        for (let i = section.start; i <= section.end; i++) indices.push(i);
        const pages = await out.copyPages(doc, indices);
        pages.forEach((p) => out.addPage(p));
      }
      return { items: [{ name: 'bookmarked_sections.pdf', blob: pdfBlob(await out.save()) }], note: 'Kept ' + sections.length + ' bookmarked section(s)' };
    }
    const items = [];
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const out = await window.PDFLib.PDFDocument.create();
      const indices = [];
      for (let p = section.start; p <= section.end; p++) indices.push(p);
      const pages = await out.copyPages(doc, indices);
      pages.forEach((p) => out.addPage(p));
      const safe = section.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 48) || 'section';
      items.push({ name: String(i + 1).padStart(2, '0') + '_' + safe + '.pdf', blob: pdfBlob(await out.save()) });
    }
    return { items: items, note: 'Split into ' + items.length + ' bookmarked section(s)' };
  },

  async 'split-pdf-in-half'() {
    const f = needPdf();
    const mode = val('#opt-half-mode') || 'two';
    const doc = await loadDoc(f);
    const total = doc.getPageCount();
    if (mode === 'two') {
      if (total < 2) throw new Error('This PDF only has one page');
      const cut = Math.ceil(total / 2);
      const first = await window.PDFLib.PDFDocument.create();
      const p1 = await first.copyPages(doc, Array.from({ length: cut }, (_, i) => i));
      p1.forEach((p) => first.addPage(p));
      const second = await window.PDFLib.PDFDocument.create();
      const p2 = await second.copyPages(doc, Array.from({ length: total - cut }, (_, i) => cut + i));
      p2.forEach((p) => second.addPage(p));
      return {
        items: [
          { name: 'half_1.pdf', blob: pdfBlob(await first.save()) },
          { name: 'half_2.pdf', blob: pdfBlob(await second.save()) },
        ],
        note: 'Split ' + total + ' page(s) into ' + cut + ' + ' + (total - cut),
      };
    }
    const dir = val('#opt-half-dir') || 'vertical';
    const src = await openPdfjs(await bytesOf(f));
    const out = await window.PDFLib.PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      toast('Slicing page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const full = await renderPageToCanvas(page, 2);
      const halves = dir === 'vertical'
        ? [[0, 0, full.width / 2, full.height], [full.width / 2, 0, full.width / 2, full.height]]
        : [[0, 0, full.width, full.height / 2], [0, full.height / 2, full.width, full.height / 2]];
      const baseW = vp.width / 2;
      const baseH = vp.height / 2;
      for (const h of halves) {
        const c = document.createElement('canvas');
        c.width = Math.round(h[2]);
        c.height = Math.round(h[3]);
        c.getContext('2d').drawImage(full, h[0], h[1], h[2], h[3], 0, 0, c.width, c.height);
        const img = await out.embedJpg(dataUrlToUint8(c.toDataURL('image/jpeg', 0.92)));
        const p = out.addPage([baseW, baseH]);
        p.drawImage(img, { x: 0, y: 0, width: baseW, height: baseH });
      }
    }
    return { items: [{ name: 'sliced_in_half.pdf', blob: pdfBlob(await out.save()) }], note: 'Sliced ' + src.numPages + ' page(s) into ' + (src.numPages * 2) + ' halves' };
  },

  async 'split-pdf-by-size'() {
    const f = needPdf();
    const limitMb = parseFloat(val('#opt-size-limit')) || 5;
    if (limitMb < 0.05) throw new Error('Choose a limit of at least 0.05 MB');
    const limit = Math.floor(limitMb * 1024 * 1024);
    const compress = !!document.querySelector('#opt-size-compress')?.checked;
    const doc = compress ? await rasterizePdfFile(f, 1.4) : await loadDoc(f);
    toast('Packing pages into ' + limitMb + ' MB parts');
    const parts = await splitPdfBySize(doc, limit);
    const items = parts.map((p, i) => ({ name: 'part_' + String(i + 1).padStart(2, '0') + '.pdf', blob: pdfBlob(p.bytes) }));
    const over = parts.filter((p) => p.over).length;
    return { items: items, note: 'Created ' + items.length + ' part(s)' + (over ? ' · ' + over + ' single page(s) still exceed the limit' : '') };
  },

  async 'word-to-pdf'() {
    const f = state.files.find((x) => x.kind === 'docx');
    if (!f) throw new Error('Add a Word document (.docx) first');
    toast('Reading Word document');
    const body = await docxToHtml(f.file);
    const css = '<style>body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11pt;line-height:1.55}h1,h2,h3{color:#1a1a1a;line-height:1.25;margin:18px 0 8px}h1{font-size:24pt}h2{font-size:17pt}h3{font-size:13pt}p{margin:0 0 9px}ul{margin:0 0 12px 22px;padding:0}li{margin:0 0 5px}table{border-collapse:collapse;width:100%;margin:10px 0;font-size:10pt}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left}th{background:#f0f2f5}.doc-title{text-align:center}.doc-subtitle{text-align:center;color:#555}</style>';
    const bytes = await htmlToTextPdfBlob(css + body);
    return { items: [{ name: 'word_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Converted ' + f.name + ' to PDF' };
  },

  async 'png-to-pdf'() {
    const files = state.files.filter((f) => /\.png$/i.test(f.name));
    if (!files.length) throw new Error('Add at least one PNG image');
    const doc = await window.PDFLib.PDFDocument.create();
    for (const f of files) {
      const png = await imageToPngBytes(f.file);
      const img = await doc.embedPng(png);
      const k = Math.min(1, 2000 / Math.max(img.width, img.height));
      const page = doc.addPage([img.width * k, img.height * k]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * k, height: img.height * k });
    }
    return { items: [{ name: 'png_images.pdf', blob: pdfBlob(await doc.save()) }], note: 'Added ' + files.length + ' image(s)' };
  },

  async 'tiff-to-pdf'() {
    const files = state.files.filter((f) => /\.(tif|tiff)$/i.test(f.name));
    if (!files.length) throw new Error('Add at least one TIFF image');
    const doc = await window.PDFLib.PDFDocument.create();
    let pages = 0;
    for (const f of files) {
      toast('Reading ' + f.name);
      const canvases = await tiffToCanvases(f.file);
      for (const canvas of canvases) {
        const png = dataUrlToUint8(canvas.toDataURL('image/png'));
        const img = await doc.embedPng(png);
        const k = Math.min(1, 2000 / Math.max(canvas.width, canvas.height));
        const page = doc.addPage([canvas.width * k, canvas.height * k]);
        page.drawImage(img, { x: 0, y: 0, width: canvas.width * k, height: canvas.height * k });
        pages++;
      }
    }
    if (!pages) throw new Error('No TIFF pages were found');
    return { items: [{ name: 'tiff_images.pdf', blob: pdfBlob(await doc.save()) }], note: 'Converted ' + pages + ' TIFF page(s)' };
  },

  async 'workflow'() {
    if (!state.files.length) throw new Error('Add at least one PDF');
    const merge = !!document.querySelector('#opt-wf-merge')?.checked;
    const angle = parseInt(val('#opt-wf-rotate'), 10) || 0;
    const watermark = val('#opt-wf-watermark').trim();
    const numbers = !!document.querySelector('#opt-wf-numbers')?.checked;
    const flatten = !!document.querySelector('#opt-wf-flatten')?.checked;
    let doc = await window.PDFLib.PDFDocument.create();
    const sources = merge ? state.files : [state.files[0]];
    for (const f of sources) {
      const src = await loadDoc(f);
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    }
    if (angle) doc.getPages().forEach((p) => p.setRotation(window.PDFLib.degrees(angle)));
    if (watermark) {
      const font = await doc.embedFont(window.PDFLib.StandardFonts.HelveticaBold);
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        const size = Math.max(18, Math.min(52, width / Math.max(6, watermark.length * 0.62)));
        const tw = font.widthOfTextAtSize(watermark, size);
        page.drawText(watermark, {
          x: (width - tw) / 2,
          y: height / 2 - size / 3,
          size: size,
          font: font,
          color: window.PDFLib.rgb(0.55, 0.55, 0.55),
          opacity: 0.22,
          rotate: window.PDFLib.degrees(-45),
        });
      }
    }
    if (numbers) {
      const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
      doc.getPages().forEach((page, i) => {
        const { width } = page.getSize();
        const label = String(i + 1);
        const tw = font.widthOfTextAtSize(label, 10);
        page.drawText(label, { x: (width - tw) / 2, y: 20, size: 10, font: font, color: window.PDFLib.rgb(0.3, 0.3, 0.3) });
      });
    }
    let bytes = await doc.save();
    if (flatten) {
      const src = await openPdfjs(bytes);
      const out = await pdfjsToImagePdf(src, 2, 0.9);
      bytes = await out.save();
    }
    const steps = [merge ? 'merge' : null, angle ? 'rotate ' + angle + '°' : null, watermark ? 'watermark' : null, numbers ? 'page numbers' : null, flatten ? 'flatten' : null].filter(Boolean);
    return { items: [{ name: 'workflow_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Ran ' + steps.length + ' step(s): ' + steps.join(' → ') };
  },

  /* ---------------- Handwriting ---------------- */

  async 'pdf-to-handwriting'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const parts = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of tc.items) {
        line += item.str || '';
        if (item.hasEOL) { if (line.trim()) lines.push(line.trim()); line = ''; }
      }
      if (line.trim()) lines.push(line.trim());
      parts.push(lines.join('\n'));
    }
    const text = parts.join('\n\n');
    if (!text.trim()) throw new Error('This PDF has no extractable text — run OCR first');
    const canvases = renderHandwritingPages(text, {
      style: val('#opt-hw-style') || 'neat',
      paper: val('#opt-hw-paper') || 'ruled',
      ink: val('#opt-hw-ink') || '#1a2a6c',
    });
    const out = await window.PDFLib.PDFDocument.create();
    for (const canvas of canvases) {
      const img = await out.embedPng(dataUrlToUint8(canvas.toDataURL('image/png')));
      const p = out.addPage([595, 842]);
      p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    }
    return { items: [{ name: 'handwritten_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Wrote ' + canvases.length + ' handwritten page(s)' };
  },

  async 'text-to-handwriting'() {
    const text = val('#text-input');
    if (!text.trim()) throw new Error('Type some text first');
    const canvases = renderHandwritingPages(text, {
      style: val('#opt-hw-style') || 'neat',
      paper: val('#opt-hw-paper') || 'ruled',
      ink: val('#opt-hw-ink') || '#1a2a6c',
    });
    const out = await window.PDFLib.PDFDocument.create();
    for (const canvas of canvases) {
      const img = await out.embedPng(dataUrlToUint8(canvas.toDataURL('image/png')));
      const p = out.addPage([595, 842]);
      p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    }
    return { items: [{ name: 'handwriting_ihatepdf.pdf', blob: pdfBlob(await out.save()) }], note: 'Wrote ' + canvases.length + ' handwritten page(s)' };
  },

  async 'handwriting-to-pdf'() {
    const images = state.files.filter((x) => x.kind === 'image');
    if (!images.length) throw new Error('Add photos of handwritten pages first');
    const lang = val('#opt-hw-lang') || 'eng';
    const includeImage = !!document.querySelector('#opt-hw-image')?.checked;
    const worker = await window.Tesseract.createWorker(lang);
    const parts = [];
    let html = '<style>body{font-family:Georgia,serif;line-height:1.6}h2{font-size:18px;margin:18px 0 8px}p{margin:0 0 10px;white-space:pre-wrap}img{max-width:100%;border:1px solid #ddd;margin:8px 0 16px}</style>';
    try {
      for (let i = 0; i < images.length; i++) {
        toast('Reading handwriting ' + (i + 1) + '/' + images.length);
        const canvas = await imageFileToCanvas(images[i].file);
        const { data } = await worker.recognize(canvas);
        const text = (data && data.text ? data.text : '').trim();
        parts.push({ title: images[i].name, text: text });
        html += '<h2>' + escHtml(images[i].name) + '</h2>';
        if (includeImage) {
          const preview = document.createElement('canvas');
          const k = Math.min(1, 900 / canvas.width);
          preview.width = Math.round(canvas.width * k);
          preview.height = Math.round(canvas.height * k);
          preview.getContext('2d').drawImage(canvas, 0, 0, preview.width, preview.height);
          html += '<img src="' + preview.toDataURL('image/jpeg', 0.82) + '" />';
        }
        html += '<p>' + escHtml(text || '(no text recognised)') + '</p>';
      }
    } finally {
      await worker.terminate();
    }
    const pdf = await htmlToPdfBlob(html);
    const text = parts.map((p) => '--- ' + p.title + ' ---\n' + p.text).join('\n\n');
    return {
      items: [
        { name: 'handwriting_transcript.pdf', blob: pdf },
        { name: 'handwriting_transcript.txt', blob: new Blob([text], { type: 'text/plain' }) },
      ],
      note: 'Recognised ' + images.length + ' handwritten page(s)',
    };
  },

  async 'thumbmark-generator'() {
    const f = state.files.find((x) => x.kind === 'image');
    if (!f) throw new Error('Add a thumbprint photo first');
    const threshold = parseFloat(val('#opt-thumb-threshold')) || 150;
    const invert = !!document.querySelector('#opt-thumb-invert')?.checked;
    const removeBg = !!document.querySelector('#opt-thumb-bg')?.checked;
    const src = await imageFileToCanvas(f.file);
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const ink = invert ? 255 - lum : lum;
      const alpha = removeBg ? Math.max(0, Math.min(255, ((threshold * (invert ? -1 : 1)) + (invert ? lum : -lum)) * 2.4)) : 255;
      const value = invert ? 255 : 0;
      d[i] = value;
      d[i + 1] = value;
      d[i + 2] = value;
      d[i + 3] = alpha;
    }
    ctx.putImageData(image, 0, 0);
    const trimmed = trimCanvas(canvas, 8) || canvas;
    const blob = await canvasToBlob(trimmed, 'image/png');
    return { items: [{ name: 'thumbmark_ihatepdf.png', blob: blob }], note: 'Thumbmark cropped to ' + trimmed.width + ' × ' + trimmed.height + ' px' };
  },

  /* ---------------- Security ---------------- */

  async 'encrypt-pdf'() {
    const f = needPdf();
    const user = val('#opt-enc-user');
    if (!user || user.length < 4) throw new Error('Choose an open password of at least 4 characters');
    const owner = val('#opt-enc-owner') || user + '-owner';
    const perms = [];
    if (document.querySelector('#opt-enc-print')?.checked) perms.push('print', 'print-high');
    if (document.querySelector('#opt-enc-copy')?.checked) perms.push('copy');
    if (document.querySelector('#opt-enc-modify')?.checked) perms.push('modify');
    const src = await openPdfjs(await bytesOf(f));
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      unit: 'pt',
      format: 'a4',
      encryption: { userPassword: user, ownerPassword: owner, userPermissions: perms },
    });
    const pageW = 595.28;
    const pageH = 841.89;
    for (let i = 1; i <= src.numPages; i++) {
      toast('Encrypting page ' + i + '/' + src.numPages);
      const page = await src.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = await renderPageToCanvas(page, 2);
      if (i > 1) pdf.addPage();
      const k = Math.min((pageW - 36) / vp.width, (pageH - 36) / vp.height);
      const w = vp.width * k;
      const h = vp.height * k;
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', (pageW - w) / 2, (pageH - h) / 2, w, h);
    }
    return { items: [{ name: 'encrypted_ihatepdf.pdf', blob: pdf.output('blob') }], note: 'Encrypted ' + src.numPages + ' page(s) · permissions: ' + (perms.join(', ') || 'none') };
  },

  async 'unlock-pdf'() {
    const f = needPdf();
    const password = val('#opt-unlock-password');
    const raw = await bytesOf(f);
    if (!pageHasEncryption(raw) && !password) {
      const doc = await loadDoc(f);
      return { items: [{ name: 'unlocked_ihatepdf.pdf', blob: pdfBlob(await doc.save()) }], note: 'No encryption was found — the PDF was re-saved without restrictions' };
    }
    let src;
    try {
      src = await pdfjs().getDocument({ data: raw, password: password || undefined }).promise;
    } catch (e) {
      if (e && /password/i.test(e.message || '') || (e && e.name === 'PasswordException')) throw new Error('Wrong password — check it and try again');
      throw e;
    }
    const out = await pdfjsToImagePdf(src, 2, 0.92);
    const bytes = await out.save();
    return { items: [{ name: 'unlocked_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Removed protection from ' + src.numPages + ' page(s) · text layer rebuilt' };
  },

  /* ---------------- Data conversion ---------------- */

  async 'pdf-to-csv'() {
    const f = needPdf();
    const mode = val('#opt-csv-mode') || 'lines';
    const delim = val('#opt-csv-delim') || ',';
    const src = await openPdfjs(await bytesOf(f));
    const rows = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      const items = (tc.items || [])
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5] }))
        .sort((a, b) => b.y - a.y || a.x - b.x);
      const pageRows = [];
      for (const it of items) {
        let row = pageRows.length ? pageRows[pageRows.length - 1] : null;
        if (!row || Math.abs(row.y - it.y) > 3) { row = { y: it.y, cells: [] }; pageRows.push(row); }
        row.cells.push(it);
      }
      for (const r of pageRows) {
        r.cells.sort((a, b) => a.x - b.x);
        rows.push(mode === 'items' ? r.cells.map((c) => c.text) : [r.cells.map((c) => c.text).join(' ')]);
      }
      rows.push([]);
    }
    if (!rows.length) throw new Error('This PDF has no extractable text — run OCR first');
    const csv = rows.map((r) => r.map((c) => csvCell(c, delim)).join(delim)).join('\r\n');
    return {
      items: [{ name: 'converted_ihatepdf.csv', blob: new Blob([csv], { type: 'text/csv' }) }],
      text: csv.slice(0, 20000),
      note: 'Exported ' + rows.filter((r) => r.length).length + ' row(s)',
    };
  },

  async 'excel-to-pdf'() {
    const f = state.files.find((x) => x.kind === 'xlsx');
    if (!f) throw new Error('Add an Excel workbook (.xlsx) first');
    const grid = !!document.querySelector('#opt-xlsx-grid')?.checked;
    const orient = val('#opt-xlsx-orient') || 'landscape';
    const html = await xlsxToHtml(f.file, grid, orient);
    const css = '<style>body{font-family:Arial,sans-serif;font-size:9pt;color:#111}h2{font-size:14pt;margin:14px 0 6px}table{border-collapse:collapse;width:100%;margin:0 0 14px}th,td{padding:4px 6px;text-align:left;vertical-align:top}table.grid th,table.grid td{border:1px solid #c7ccd4}table.grid th{background:#eef1f6;font-weight:700}table.nogrid th{background:#eef1f6}td{white-space:pre-wrap}</style>';
    const bytes = await htmlToTextPdfBlob(css + html, orient);
    return { items: [{ name: 'excel_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Converted ' + f.name + ' to PDF' };
  },

  async 'pptx-to-pdf'() {
    const f = state.files.find((x) => x.kind === 'pptx');
    if (!f) throw new Error('Add a PowerPoint file (.pptx) first');
    const slides = await pptxSlides(f.file);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: [720, 405] });
    const margin = 46;
    slides.forEach((lines, si) => {
      if (si > 0) doc.addPage([720, 405]);
      doc.setFillColor(255, 255, 255);
      doc.rect(0, 0, 720, 405, 'F');
      let y = 60;
      const title = lines[0] || 'Slide ' + (si + 1);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(24);
      doc.setTextColor(20, 28, 45);
      const titleLines = doc.splitTextToSize(title, 620);
      doc.text(titleLines, margin, y);
      y += titleLines.length * 28 + 14;
      doc.setDrawColor(210, 60, 60);
      doc.setLineWidth(2);
      doc.line(margin, y - 22, margin + 54, y - 22);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(45, 50, 62);
      for (const line of lines.slice(1)) {
        doc.setFontSize(15);
        const wrapped = doc.splitTextToSize('•  ' + line, 620);
        for (const w of wrapped) {
          if (y > 360) {
            doc.addPage([720, 405]);
            y = 56;
          }
          doc.text(w, margin, y);
          y += 21;
        }
        y += 5;
      }
    });
    return { items: [{ name: 'powerpoint_ihatepdf.pdf', blob: doc.output('blob') }], note: 'Converted ' + slides.length + ' slide(s)' };
  },

  async 'ebook-to-pdf'() {
    const f = state.files.find((x) => x.kind === 'epub' || x.kind === 'text');
    if (!f) throw new Error('Add an EPUB, HTML or TXT book first');
    const chapters = await ebookChapters(f.file);
    if (!chapters.length) throw new Error('No readable chapters were found');
    const css = '<style>body{font-family:Georgia,"Times New Roman",serif;line-height:1.68;color:#111;font-size:11.5pt}h1{font-size:25pt;margin:0 0 6px}h2{font-size:16pt;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:5px}p{margin:0 0 11px;text-align:justify}.book-title{text-align:center;margin:20px 0 6px}.book-sub{text-align:center;color:#666;margin-bottom:26px}</style>';
    let html = '<h1 class="book-title">' + escHtml(f.name.replace(/\.[^.]+$/, '')) + '</h1>';
    for (const ch of chapters) {
      html += '<h2>' + escHtml(ch.title) + '</h2>' + String(ch.text).split(/\n{2,}/).map((p) => '<p>' + escHtml(p).replace(/\n/g, '<br />') + '</p>').join('');
    }
    const bytes = await htmlToTextPdfBlob(css + html);
    return { items: [{ name: 'ebook_ihatepdf.pdf', blob: pdfBlob(bytes) }], note: 'Typeset ' + chapters.length + ' chapter(s)' };
  },

  async 'pdf-to-audio'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const parts = [];
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      const tc = await page.getTextContent();
      parts.push(tc.items.map((it) => it.str).join(' '));
    }
    const text = parts.join('\n\n').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('This PDF has no extractable text — run OCR first');
    if (document.querySelector('#opt-audio-speak')?.checked && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text.slice(0, 20000));
      utter.rate = parseFloat(val('#opt-audio-rate')) || 1;
      const voiceName = val('#opt-audio-voice');
      const voice = window.speechSynthesis.getVoices().find((v) => v.name === voiceName);
      if (voice) utter.voice = voice;
      window.speechSynthesis.speak(utter);
    }
    return {
      items: [{ name: 'read_aloud_ihatepdf.txt', blob: new Blob([text], { type: 'text/plain' }) }],
      text: text.slice(0, 20000),
      note: 'Reading aloud · full transcript ready (' + text.length.toLocaleString() + ' characters)',
    };
  },

  /* ---------------- AI-style extractive tools ---------------- */

  async 'chat-with-pdf'() {
    const f = needPdf();
    const question = val('#opt-chat-question').trim();
    if (!question) throw new Error('Type a question about the PDF');
    const text = await pdfAllText(f);
    if (!text.trim()) throw new Error('This PDF has no extractable text — run OCR first');
    const passages = Math.max(1, parseInt(val('#opt-chat-passages'), 10) || 3);
    const res = answerFromText(text, question, passages);
    if (!res.answer) throw new Error('I could not find that in the document. Try different words.');
    const answer = 'Q: ' + question + '\n\n' + res.answer;
    return {
      items: [{ name: 'pdf_answer_ihatepdf.txt', blob: new Blob([answer], { type: 'text/plain' }) }],
      text: answer,
      note: 'Found ' + res.hits.length + ' relevant passage(s) on-device',
    };
  },

  async 'summarize-pdf'() {
    const f = needPdf();
    const text = await pdfAllText(f);
    if (!text.trim()) throw new Error('This PDF has no extractable text — run OCR first');
    const style = val('#opt-sum-style') || 'bullets';
    const length = Math.max(3, parseInt(val('#opt-sum-length'), 10) || 9);
    const picked = summarizeText(text, length);
    if (!picked.length) throw new Error('The document is too short to summarize');
    let out;
    if (style === 'detailed') {
      const paragraphs = [];
      for (let i = 0; i < picked.length; i += 3) paragraphs.push(picked.slice(i, i + 3).join(' '));
      out = 'Summary of ' + f.name + '\n\n' + paragraphs.join('\n\n');
    } else if (style === 'overview') {
      out = 'Overview of ' + f.name + '\n\n' + picked.slice(0, 5).map((s) => s).join(' ');
    } else {
      out = 'Key points from ' + f.name + '\n\n' + picked.map((s) => '• ' + s).join('\n');
    }
    return {
      items: [{ name: 'summary_ihatepdf.txt', blob: new Blob([out], { type: 'text/plain' }) }],
      text: out,
      note: 'Summarized ' + wordsOf(text).length.toLocaleString() + ' words into ' + picked.length + ' sentences',
    };
  },

  /* ---------------- Business documents ---------------- */

  async 'gst-invoice'() {
    const seller = val('#opt-gst-seller').trim() || 'Your Business';
    const sellerGstin = val('#opt-gst-seller-gstin').trim();
    const buyer = val('#opt-gst-buyer').trim() || 'Customer';
    const buyerGstin = val('#opt-gst-buyer-gstin').trim();
    const invoiceNo = val('#opt-gst-invoice-no').trim() || 'INV-001';
    const date = val('#opt-gst-date') || new Date().toISOString().slice(0, 10);
    const inter = (val('#opt-gst-state') || 'intra') === 'inter';
    const notes = val('#opt-gst-notes').trim();
    const rawItems = String(val('#opt-gst-items') || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!rawItems.length) throw new Error('Add at least one invoice item');
    const items = rawItems.map((line) => {
      const p = line.split('|').map((s) => s.trim());
      const qty = parseFloat(p[2]) || 1;
      const rate = parseFloat(p[3]) || 0;
      const gst = parseFloat(p[4]) || 0;
      const taxable = qty * rate;
      return { desc: p[0] || 'Item', hsn: p[1] || '', qty: qty, rate: rate, gst: gst, taxable: taxable, tax: taxable * gst / 100, total: taxable * (1 + gst / 100) };
    });
    const taxable = items.reduce((a, b) => a + b.taxable, 0);
    const tax = items.reduce((a, b) => a + b.tax, 0);
    const grand = taxable + tax;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const W = 595.28;
    const M = 40;
    doc.setFillColor(28, 38, 58);
    doc.rect(0, 0, W, 92, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text('TAX INVOICE', M, 44);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(seller, M, 66);
    if (sellerGstin) doc.text('GSTIN: ' + sellerGstin, M, 80);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Invoice ' + invoiceNo, W - M, 44, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('Date: ' + date, W - M, 62, { align: 'right' });
    doc.text(inter ? 'Inter-state supply (IGST)' : 'Intra-state supply (CGST + SGST)', W - M, 78, { align: 'right' });
    doc.setTextColor(24, 30, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('BILL TO', M, 120);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(buyer, M, 137);
    if (buyerGstin) doc.text('GSTIN: ' + buyerGstin, M, 152);
    const cols = [
      { x: M, w: 22, label: '#', align: 'left' },
      { x: M + 22, w: 192, label: 'Description', align: 'left' },
      { x: M + 214, w: 55, label: 'HSN', align: 'left' },
      { x: M + 269, w: 38, label: 'Qty', align: 'right' },
      { x: M + 307, w: 58, label: 'Rate', align: 'right' },
      { x: M + 365, w: 55, label: 'GST', align: 'right' },
      { x: M + 420, w: 95, label: 'Amount', align: 'right' },
    ];
    let y = 180;
    doc.setFillColor(238, 241, 247);
    doc.rect(M, y - 14, W - M * 2, 22, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    for (const c of cols) doc.text(c.label, c.align === 'right' ? c.x + c.w : c.x, y, { align: c.align });
    y += 22;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    items.forEach((it, i) => {
      if (y > 690) { doc.addPage(); y = 60; }
      const desc = doc.splitTextToSize(it.desc, cols[1].w - 4)[0];
      doc.text(String(i + 1), cols[0].x, y);
      doc.text(desc, cols[1].x, y);
      doc.text(it.hsn, cols[2].x, y);
      doc.text(String(it.qty), cols[3].x + cols[3].w, y, { align: 'right' });
      doc.text(it.rate.toFixed(2), cols[4].x + cols[4].w, y, { align: 'right' });
      doc.text(it.gst + '%', cols[5].x + cols[5].w, y, { align: 'right' });
      doc.text(it.total.toFixed(2), cols[6].x + cols[6].w, y, { align: 'right' });
      doc.setDrawColor(224, 228, 235);
      doc.line(M, y + 6, W - M, y + 6);
      y += 20;
    });
    y += 10;
    const rows = [
      ['Taxable value', taxable],
      inter ? ['IGST', tax] : ['CGST', tax / 2],
      ...(inter ? [] : [['SGST', tax / 2]]),
    ];
    doc.setFontSize(9.5);
    for (const r of rows) {
      doc.text(String(r[0]), W - M - 170, y, { align: 'right' });
      doc.text(Number(r[1]).toFixed(2), W - M, y, { align: 'right' });
      y += 16;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Total payable', W - M - 170, y + 6, { align: 'right' });
    doc.text('INR ' + grand.toFixed(2), W - M, y + 6, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text('Amount in words: ' + numberToWordsIndian(grand) + ' only', M, y + 34, { maxWidth: W - M * 2 });
    if (notes) doc.text(notes, M, y + 58, { maxWidth: W - M * 2 });
    doc.setTextColor(110, 118, 130);
    doc.setFontSize(8);
    doc.text('Generated locally with ihatepdf.cv — no upload, no watermark.', M, 812);
    return { items: [{ name: 'gst_invoice_' + invoiceNo.replace(/[^\w\-]+/g, '_') + '.pdf', blob: doc.output('blob') }], note: 'Invoice total ₹' + grand.toFixed(2) + ' · ' + items.length + ' item(s)' };
  },

  async 'pos-billing'() {
    const shop = val('#opt-pos-shop').trim() || 'My Shop';
    const address = val('#opt-pos-address').trim();
    const gstin = val('#opt-pos-gstin').trim();
    const payment = val('#opt-pos-payment') || 'Cash';
    const discountPct = Math.min(100, Math.max(0, parseFloat(val('#opt-pos-discount')) || 0));
    const note = val('#opt-pos-note').trim();
    const raw = String(val('#opt-pos-items') || '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (!raw.length) throw new Error('Add at least one item to the cart');
    const items = raw.map((line) => {
      const p = line.split('|').map((s) => s.trim());
      const qty = parseFloat(p[1]) || 1;
      const price = parseFloat(p[2]) || 0;
      const gst = parseFloat(p[3]) || 0;
      return { name: p[0] || 'Item', qty: qty, price: price, gst: gst, total: qty * price * (1 + gst / 100) };
    });
    const subtotal = items.reduce((a, b) => a + b.qty * b.price, 0);
    const discount = subtotal * discountPct / 100;
    const taxes = items.reduce((a, b) => a + b.qty * b.price * b.gst / 100, 0);
    const total = subtotal - discount + taxes;
    const { jsPDF } = window.jspdf;
    const H = Math.max(340, 210 + items.length * 22);
    const doc = new jsPDF({ unit: 'pt', format: [226, H] });
    const cx = 113;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(shop, cx, 30, { align: 'center' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    let y = 44;
    if (address) { doc.text(address, cx, y, { align: 'center', maxWidth: 196 }); y += 11; }
    if (gstin) { doc.text('GSTIN: ' + gstin, cx, y, { align: 'center' }); y += 11; }
    doc.setLineDashPattern([2, 2], 0);
    doc.line(12, y, 214, y);
    doc.setLineDashPattern([], 0);
    y += 14;
    doc.setFontSize(8);
    doc.text('Item', 12, y);
    doc.text('Amount', 214, y, { align: 'right' });
    y += 12;
    for (const it of items) {
      if (y > H - 90) break;
      doc.text(doc.splitTextToSize(it.name, 128)[0], 12, y);
      doc.text(it.total.toFixed(2), 214, y, { align: 'right' });
      y += 10;
      doc.setFontSize(7);
      doc.setTextColor(110, 110, 110);
      doc.text(it.qty + ' × ' + it.price.toFixed(2) + (it.gst ? '  · GST ' + it.gst + '%' : ''), 12, y);
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(8);
      y += 12;
    }
    doc.line(12, y, 214, y);
    y += 14;
    const row = (label, value, bold) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.text(label, 12, y);
      doc.text(value, 214, y, { align: 'right' });
      y += 13;
    };
    row('Subtotal', subtotal.toFixed(2));
    if (discountPct) row('Discount (' + discountPct + '%)', '-' + discount.toFixed(2));
    row('GST', taxes.toFixed(2));
    doc.setFontSize(10);
    row('TOTAL', '₹' + total.toFixed(2), true);
    doc.setFontSize(7.5);
    row('Paid by', payment);
    y += 4;
    doc.setFontSize(7.5);
    doc.text('Date: ' + new Date().toLocaleString(), cx, y, { align: 'center' });
    y += 13;
    if (note) doc.text(note, cx, y, { align: 'center', maxWidth: 196 });
    y += 14;
    doc.text('Thank you · no watermark', cx, y, { align: 'center' });
    return { items: [{ name: 'pos_receipt.pdf', blob: doc.output('blob') }], note: 'Receipt total ₹' + total.toFixed(2) + ' · ' + items.length + ' item(s)' };
  },

  async 'gst-filing-prep'() {
    const f = needPdf();
    const limitMb = parseFloat(val('#opt-gstf-limit')) || 5;
    const compress = !!document.querySelector('#opt-gstf-compress')?.checked;
    const limit = Math.floor(limitMb * 1024 * 1024);
    const doc = compress ? await rasterizePdfFile(f, 1.4) : await loadDoc(f);
    toast('Packing parts under ' + limitMb + ' MB');
    const parts = await splitPdfBySize(doc, limit);
    const zip = new window.JSZip();
    parts.forEach((p, i) => zip.file('gst_part_' + String(i + 1).padStart(2, '0') + '.pdf', p.bytes));
    const blob = await zip.generateAsync({ type: 'blob' });
    const over = parts.filter((p) => p.over).length;
    return {
      items: [{ name: 'gst_upload_parts.zip', blob: blob }],
      note: parts.length + ' part(s) under ' + limitMb + ' MB' + (over ? ' · ' + over + ' page(s) still too large' : ''),
    };
  },

  /* ---------------- Resume ---------------- */

  async 'latex-resume'() {
    const name = val('#opt-cv-name').trim();
    if (!name) throw new Error('Enter your name first');
    const role = val('#opt-cv-role').trim();
    const email = val('#opt-cv-email').trim();
    const phone = val('#opt-cv-phone').trim();
    const location = val('#opt-cv-location').trim();
    const summary = val('#opt-cv-summary').trim();
    const skills = val('#opt-cv-skills').split(',').map((s) => s.trim()).filter(Boolean);
    const template = val('#opt-cv-template') || 'classic';
    const experience = String(val('#opt-cv-experience') || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const p = line.split('|').map((s) => s.trim());
      return { org: p[0] || '', role: p[1] || '', dates: p[2] || '', detail: p[3] || '' };
    });
    const education = String(val('#opt-cv-education') || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const p = line.split('|').map((s) => s.trim());
      return { org: p[0] || '', degree: p[1] || '', dates: p[2] || '' };
    });
    const contact = [email, phone, location].filter(Boolean).map((s) => escHtml(s)).join(' &nbsp;·&nbsp; ');
    const modern = template === 'modern';
    let html = '<style>body{font-family:"Helvetica Neue",Arial,sans-serif;color:#1b1f28;font-size:10.5pt;line-height:1.5}.cv-head{text-align:center;padding-bottom:12px;border-bottom:3px solid ' + (modern ? '#c0392b' : '#1f2b46') + '}h1{margin:0;font-size:27pt;letter-spacing:1px;color:' + (modern ? '#c0392b' : '#1f2b46') + '}.role{margin:4px 0 0;font-size:12.5pt;color:#4a5264;letter-spacing:.5px}.contact{margin-top:7px;font-size:9pt;color:#5b6474}.cv-contact{margin-top:7px;font-size:9pt;color:#5b6474}h2{font-size:10.5pt;text-transform:uppercase;letter-spacing:1.4px;color:' + (modern ? '#c0392b' : '#1f2b46') + ';border-bottom:1px solid #ccd2dc;padding-bottom:3px;margin:18px 0 8px}.cv-row{margin:0 0 11px}.cv-title{font-weight:700;font-size:11pt}.cv-sub{color:#4d5666;font-size:9.5pt}.cv-detail{margin:2px 0 0;color:#333;font-size:10pt}ul{margin:4px 0 0 18px;padding:0}li{margin:0 0 3px}.skills{color:#333}</style>';
    html += '<div class="cv-head"><h1>' + escHtml(name) + '</h1>' + (role ? '<p class="role">' + escHtml(role) + '</p>' : '') + (contact ? '<p class="contact">' + contact + '</p>' : '') + '</div>';
    if (summary) html += '<h2>Profile</h2><p class="cv-detail">' + escHtml(summary) + '</p>';
    if (experience.length) {
      html += '<h2>Experience</h2>';
      for (const e of experience) {
        html += '<div class="cv-row"><p class="cv-title">' + escHtml(e.role || e.org) + (e.dates ? ' <span class="cv-sub">· ' + escHtml(e.dates) + '</span>' : '') + '</p><p class="cv-sub">' + escHtml(e.org) + '</p>' + (e.detail ? '<p class="cv-detail">' + escHtml(e.detail) + '</p>' : '') + '</div>';
      }
    }
    if (education.length) {
      html += '<h2>Education</h2>';
      for (const e of education) {
        html += '<div class="cv-row"><p class="cv-title">' + escHtml(e.degree || e.org) + '</p><p class="cv-sub">' + escHtml(e.org) + (e.dates ? ' · ' + escHtml(e.dates) : '') + '</p></div>';
      }
    }
    if (skills.length) html += '<h2>Skills</h2><p class="skills">' + skills.map(escHtml).join(' · ') + '</p>';
    const pdf = await htmlToPdfBlob(html);
    const L = (s) => String(s || '').replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
    let tex = '\\documentclass[11pt,a4paper]{article}\n\\usepackage[margin=0.8in]{geometry}\n\\usepackage[T1]{fontenc}\n\\usepackage{enumitem}\n\\usepackage{hyperref}\n\\begin{document}\n';
    tex += '\\begin{center}\n{\\Huge\\bfseries ' + L(name) + '}\\\\\n';
    if (role) tex += '\\vspace{2pt}{\\large ' + L(role) + '}\\\\\n';
    if (contact) tex += '\\vspace{4pt}{\\small ' + [email, phone, location].filter(Boolean).map(L).join(' \\textperiodcentered{} ') + '}\n';
    tex += '\\end{center}\n\\hrule\\vspace{8pt}\n';
    if (summary) tex += '\\section*{Profile}\n' + L(summary) + '\n';
    if (experience.length) {
      tex += '\\section*{Experience}\n\\begin{itemize}[leftmargin=*]\n';
      for (const e of experience) tex += '\\item \\textbf{' + L(e.role || e.org) + '}' + (e.dates ? ' \\hfill ' + L(e.dates) : '') + '\\\\\n' + L(e.org) + (e.detail ? ' --- ' + L(e.detail) : '') + '\n';
      tex += '\\end{itemize}\n';
    }
    if (education.length) {
      tex += '\\section*{Education}\n\\begin{itemize}[leftmargin=*]\n';
      for (const e of education) tex += '\\item \\textbf{' + L(e.degree || e.org) + '}' + (e.dates ? ' \\hfill ' + L(e.dates) : '') + '\\\\\n' + L(e.org) + '\n';
      tex += '\\end{itemize}\n';
    }
    if (skills.length) tex += '\\section*{Skills}\n' + skills.map(L).join(', ') + '\n';
    tex += '\\end{document}\n';
    return {
      items: [
        { name: 'resume_ihatepdf.pdf', blob: pdf },
        { name: 'resume_ihatepdf.tex', blob: new Blob([tex], { type: 'text/x-tex' }) },
      ],
      note: 'Built a ' + (modern ? 'modern' : 'classic') + ' resume',
    };
  },

  /* ---------------- Edit text in place ---------------- */

  async 'edit-pdf-text'() {
    const f = needPdf();
    const ed = state.edit && state.edit.fileId === f.id ? state.edit : null;
    const edits = ed ? ed.edits.slice() : [];
    const addText = String(val('#opt-et-add') || '').trim();
    const addPos = val('#opt-et-add-pos') || 'bottom';
    if (!edits.length && !addText) throw new Error('Click a highlighted line to replace it, or type text to add to the last page');
    const doc = await loadDoc(f);
    const { rgb } = window.PDFLib;
    const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
    for (const e of edits) {
      const page = doc.getPage(e.page);
      page.drawRectangle({ x: e.bx, y: e.by, width: e.bw, height: e.bh, color: rgb(1, 1, 1) });
      if (e.text) {
        page.drawText(e.text, { x: e.x, y: e.y, size: e.size, font: font, color: rgb(0.08, 0.09, 0.11) });
      }
    }
    if (addText) {
      const page = doc.getPage(doc.getPageCount() - 1);
      const { width, height } = page.getSize();
      const size = 12;
      const lineHeight = size * 1.35;
      const lines = wrapLines(addText, font, size, width - 80);
      let y = addPos === 'top' ? height - 46 : 40 + (lines.length - 1) * lineHeight;
      for (const line of lines) {
        page.drawText(line, { x: 40, y: y, size: size, font: font, color: rgb(0.08, 0.09, 0.11) });
        y -= lineHeight;
      }
    }
    const bytes = await doc.save();
    const editedPages = Array.from(new Set(edits.map((e) => e.page)));
    let finalBytes = bytes;
    if (editedPages.length) {
      toast('Flattening edited pages so the old text is gone');
      finalBytes = await flattenSelectedPages(bytes, editedPages);
    }
    return {
      items: [{ name: 'edited_ihatepdf.pdf', blob: pdfBlob(finalBytes) }],
      note: 'Replaced ' + edits.length + ' line(s)' + (addText ? ' · added ' + wrapLines(addText, font, 12, 400).length + ' new line(s)' : '') + (editedPages.length ? ' · edited pages flattened' : ''),
    };
  },

  /* ---------------- PII detection + redaction ---------------- */

  async 'auto-redact-pii'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const types = piiEnabledTypes();
    const extra = String(val('#opt-pii-extra') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!types.length && !extra.length) throw new Error('Tick at least one type of personal data to find');
    const found = [];
    const boxesByPage = {};
    for (let p = 1; p <= src.numPages; p++) {
      toast('Scanning page ' + p + ' / ' + src.numPages);
      const page = await src.getPage(p);
      const hits = await piiHitsOnPage(page, types, extra);
      for (const hit of hits) {
        found.push({ page: p, label: hit.label, value: hit.value });
        const boxes = await piiBoxesFor(page, [hit]);
        if (boxes.length) boxesByPage[p - 1] = (boxesByPage[p - 1] || []).concat(boxes);
      }
    }
    if (!found.length) {
      return { note: 'No matching personal data was found — nothing to redact', text: 'No matching data found in ' + f.name + '.' };
    }
    const doc = await loadDoc(f);
    redactBoxesOnDoc(doc, boxesByPage);
    const boxed = await doc.save();
    toast('Flattening redacted pages');
    const out = await flattenPdfBytes(boxed);
    const report = 'Redacted ' + found.length + ' match(es) in ' + f.name + '\n\n' +
      found.map((x) => 'Page ' + x.page + ' · ' + x.label + ' · ' + x.value).join('\n');
    return {
      items: [{ name: 'redacted_pii.pdf', blob: pdfBlob(await out.save()) }],
      text: report,
      note: 'Covered and flattened ' + found.length + ' match(es) — the text is not recoverable',
    };
  },

  async 'privacy-scanner'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const types = piiEnabledTypes();
    const extra = String(val('#opt-pii-extra') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!types.length && !extra.length) throw new Error('Tick at least one type of personal data to look for');
    const found = [];
    const boxesByPage = {};
    for (let p = 1; p <= src.numPages; p++) {
      toast('Scanning page ' + p + ' / ' + src.numPages);
      const page = await src.getPage(p);
      const hits = await piiHitsOnPage(page, types, extra);
      for (const hit of hits) {
        found.push({ page: p, label: hit.label, value: hit.value });
        const boxes = await piiBoxesFor(page, [hit]);
        if (boxes.length) boxesByPage[p - 1] = (boxesByPage[p - 1] || []).concat(boxes);
      }
    }
    const counts = {};
    for (const hit of found) counts[hit.label] = (counts[hit.label] || 0) + 1;
    const summary = Object.keys(counts).map((k) => '  ' + k + ': ' + counts[k]).join('\n');
    let report = 'Privacy report for ' + f.name + '\n' +
      'Pages scanned: ' + src.numPages + '\n' +
      'Matches found: ' + found.length + '\n\n' +
      (found.length ? summary + '\n\nDetails:\n' + found.map((x) => '  Page ' + x.page + '  ' + x.label + '  ' + x.value).join('\n') : 'No selected personal data was found.');
    const items = [{ name: 'privacy_report.txt', blob: new Blob([report], { type: 'text/plain' }) }];
    let note = found.length + ' potential match(es) across ' + src.numPages + ' page(s)';
    if (found.length && document.querySelector('#opt-pii-export')?.checked) {
      const doc = await loadDoc(f);
      redactBoxesOnDoc(doc, boxesByPage);
      toast('Flattening redacted pages');
      const out = await flattenPdfBytes(await doc.save());
      items.push({ name: 'redacted_copy.pdf', blob: pdfBlob(await out.save()) });
      note += ' · redacted copy included';
    }
    return { items: items, text: report, note: note };
  },

  async 'redaction-checker'() {
    const f = needPdf();
    const src = await openPdfjs(await bytesOf(f));
    const findings = [];
    for (let p = 1; p <= src.numPages; p++) {
      toast('Checking page ' + p + ' / ' + src.numPages);
      const page = await src.getPage(p);
      const tc = await page.getTextContent();
      const items = (tc.items || []).filter((it) => it.str && it.str.trim());
      if (!items.length) continue;
      const scale = 1.6;
      const vp = page.getViewport({ scale: scale });
      const canvas = await renderPageToCanvas(page, scale);
      const ctx = canvas.getContext('2d');
      for (const it of items) {
        const tx = pdfjs().Util.transform(vp.transform, it.transform);
        const w = (it.width || 0) * scale;
        const h = (it.height || 10) * scale;
        const cx = Math.round(tx[4] + w / 2);
        const cy = Math.round(tx[5] - h * 0.35);
        if (cx < 2 || cy < 2 || cx >= canvas.width - 2 || cy >= canvas.height - 2) continue;
        const patch = ctx.getImageData(cx - 2, cy - 2, 5, 5).data;
        let lum = 0;
        for (let i = 0; i < patch.length; i += 4) lum += 0.299 * patch[i] + 0.587 * patch[i + 1] + 0.114 * patch[i + 2];
        lum /= patch.length / 4;
        if (lum < 42) findings.push({ page: p, text: it.str.trim() });
      }
    }
    let report;
    if (!findings.length) {
      report = 'No recoverable text was found underneath dark areas in ' + f.name + '.\n\nThis looks like a clean redaction. Remember that a check can only find text that is still in the PDF text layer.';
    } else {
      report = 'Potentially recoverable text was found under dark areas in ' + f.name + ':\n\n' +
        findings.map((x) => '  Page ' + x.page + '  “' + x.text + '”').join('\n') +
        '\n\nThis means the characters still exist in the file. Re-redact the document and flatten it, or use Auto-Redact PII.';
    }
    return { note: findings.length ? findings.length + ' piece(s) of text may still be recoverable' : 'Clean — no hidden text detected under dark areas', text: report };
  },

  /* ---------------- Fingerprint ---------------- */

  async 'fingerprint-pdf'() {
    const f = needPdf();
    const label = val('#opt-fp-label').trim() || 'Copy';
    const hidden = !!document.querySelector('#opt-fp-hidden')?.checked;
    const doc = await loadDoc(f);
    const id = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, '').slice(0, 16).toUpperCase();
    const marker = 'IHP-' + id + ' · ' + label;
    const now = new Date().toISOString();
    doc.setProducer('ihatepdf.cv');
    doc.setCreator('ihatepdf.cv fingerprint');
    doc.setSubject('Fingerprint ' + marker);
    doc.setKeywords([marker, 'ihatepdf', now]);
    try { doc.setTitle((doc.getTitle() || f.name.replace(/\.[^.]+$/, '')) + ' — ' + label); } catch (e) { /* ignore */ }
    if (hidden) {
      const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
      for (const page of doc.getPages()) {
        const { width } = page.getSize();
        page.drawText(marker, {
          x: Math.max(2, width - 4 - font.widthOfTextAtSize(marker, 1)),
          y: 2,
          size: 1,
          font: font,
          color: window.PDFLib.rgb(1, 1, 1),
          opacity: 0,
        });
      }
    }
    const bytes = await doc.save();
    const sha256 = await shaHex(bytes, 'SHA-256');
    const sha1 = await shaHex(bytes, 'SHA-1');
    const md5 = md5Hex(bytes);
    const manifest = 'Fingerprint manifest\n' +
      '=====================\n' +
      'Source file : ' + f.name + '\n' +
      'Copy label  : ' + label + '\n' +
      'Fingerprint : ' + marker + '\n' +
      'Created     : ' + now + '\n' +
      'Size        : ' + fmtBytes(bytes.byteLength) + '\n\n' +
      'SHA-256 : ' + sha256 + '\n' +
      'SHA-1   : ' + sha1 + '\n' +
      'MD5     : ' + md5 + '\n\n' +
      'Keep this file. Re-hashing a leaked copy with the same algorithms lets you confirm whether it is this copy.';
    return {
      items: [
        { name: 'fingerprinted_' + label.replace(/[^\w\-]+/g, '_').slice(0, 32) + '.pdf', blob: pdfBlob(bytes) },
        { name: 'fingerprint_manifest.txt', blob: new Blob([manifest], { type: 'text/plain' }) },
      ],
      text: manifest,
      note: 'Embedded fingerprint ' + marker + ' · SHA-256 ' + sha256.slice(0, 16) + '…',
    };
  },

  /* ---------------- PDF → PowerPoint ---------------- */

  async 'pdf-to-pptx'() {
    const f = needPdf();
    const dpi = parseInt(val('#opt-pptx-dpi'), 10) || 150;
    const ratio = val('#opt-pptx-ratio') || '16:9';
    const slideW = ratio === '4:3' ? 9144000 : 12192000;
    const slideH = 6858000;
    const src = await openPdfjs(await bytesOf(f));
    const scale = Math.min(3, Math.max(1, dpi / 72));
    const images = [];
    for (let p = 1; p <= src.numPages; p++) {
      toast('Rendering slide ' + p + ' / ' + src.numPages);
      const page = await src.getPage(p);
      const canvas = await renderPageToCanvas(page, scale);
      const ar = canvas.width / canvas.height;
      let extX = slideW;
      let extY = extX / ar;
      if (extY > slideH) { extY = slideH; extX = extY * ar; }
      images.push({
        png: dataUrlToUint8(canvas.toDataURL('image/png')),
        offX: (slideW - extX) / 2,
        offY: (slideH - extY) / 2,
        extX: extX,
        extY: extY,
      });
    }
    const blob = await buildPptx(images, slideW, slideH);
    return { items: [{ name: 'slides_ihatepdf.pptx', blob: blob }], note: 'Built ' + images.length + ' picture slide(s) at ' + dpi + ' DPI' };
  },

  /* ---------------- PDF → EPUB ---------------- */

  async 'pdf-to-epub'() {
    const f = needPdf();
    const { chapters, pages } = await pdfToChapters(f);
    if (!chapters.length) throw new Error('This PDF has no extractable text — run OCR first');
    const title = val('#opt-epub-title').trim() || f.name.replace(/\.[^.]+$/, '');
    const author = val('#opt-epub-author').trim() || 'Unknown';
    const blob = await buildEpub(chapters, { title: title, author: author });
    return {
      items: [{ name: title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 48) + '.epub', blob: blob }],
      note: 'Packed ' + chapters.length + ' chapter(s) from ' + pages + ' page(s) as EPUB 3',
    };
  },

  /* ---------------- Audio → PDF ---------------- */

  async 'audio-to-pdf'() {
    const f = state.files.find((x) => x.kind === 'audio');
    const title = val('#opt-audio-title').trim() || (f ? f.name.replace(/\.[^.]+$/, '') : 'Transcript');
    const lang = val('#opt-audio-lang') || 'en';
    let transcript = String(val('#opt-audio-manual') || '').trim();
    let engine = 'pasted transcript';
    if (!transcript) {
      if (!f) throw new Error('Add an audio file, or paste a transcript first');
      toast('Loading the speech model (about 40 MB on first run)');
      let mod;
      try {
        mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
      } catch (e) {
        throw new Error('Could not download the speech model. Check your connection, or paste a transcript in the box below.');
      }
      mod.env.allowLocalModels = false;
      const model = lang === 'en' ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-tiny';
      toast('Preparing the speech recogniser');
      const transcriber = await mod.pipeline('automatic-speech-recognition', model, { quantized: true });
      toast('Decoding audio');
      const samples = await decodeAudioToMono16k(f.file);
      toast('Transcribing on-device — this can take a few minutes');
      const options = { chunk_length_s: 30, stride_length_s: 5, language: lang, task: 'transcribe' };
      const result = await transcriber(samples, options);
      transcript = (result && result.text ? result.text : '').trim();
      engine = 'Whisper tiny, on-device';
    }
    if (!transcript) throw new Error('No speech was recognised in this recording');
    const paragraphs = transcript.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const css = '<style>body{font-family:Georgia,"Times New Roman",serif;line-height:1.7;color:#14161c;font-size:12pt}h1{font-size:24pt;margin:0 0 4px;letter-spacing:-.3px}.sub{color:#5c6472;font-size:10pt;margin:0 0 24px;border-bottom:1px solid #d9dde5;padding-bottom:12px}p{margin:0 0 12px;text-align:justify}</style>';
    let html = css + '<h1>' + escHtml(title) + '</h1>';
    html += '<p class="sub">' + escHtml(engine) + (f ? ' · ' + escHtml(f.name) : '') + '</p>';
    html += paragraphs.map((p) => '<p>' + escHtml(p) + '</p>').join('');
    const bytes = await htmlToTextPdfBlob(html);
    const pdf = pdfBlob(bytes);
    const words = wordsOf(transcript).length;
    return {
      items: [
        { name: 'transcript_ihatepdf.pdf', blob: pdf },
        { name: 'transcript_ihatepdf.txt', blob: new Blob([transcript], { type: 'text/plain' }) },
      ],
      text: transcript.slice(0, 20000),
      note: 'Transcribed about ' + words.toLocaleString() + ' word(s) · ' + engine,
    };
  },

  /* ---------------- Extract images ---------------- */

  async 'extract-images'() {
    const f = needPdf();
    const minSize = Math.max(0, parseInt(val('#opt-img-min'), 10) || 0);
    const format = val('#opt-img-format') || 'png';
    toast('Looking for embedded images');
    const found = await extractPdfImageCanvases(f, minSize);
    const items = [];
    if (found.length) {
      for (let i = 0; i < found.length; i++) {
        const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
        const blob = await canvasToBlob(found[i].canvas, type, 0.92);
        if (!blob) continue;
        items.push({
          name: 'page' + found[i].page + '_image' + String(i + 1).padStart(2, '0') + '.' + format,
          blob: blob,
        });
      }
    }
    if (!items.length) {
      const jpegs = extractJpegStreams(await bytesOf(f));
      for (let i = 0; i < jpegs.length; i++) {
        const blob = new Blob([jpegs[i]], { type: 'image/jpeg' });
        let width = 0;
        let height = 0;
        try {
          const bmp = await createImageBitmap(blob);
          width = bmp.width;
          height = bmp.height;
          bmp.close && bmp.close();
        } catch (e) { /* keep it anyway */ }
        if (Math.max(width, height) && Math.max(width, height) < minSize) continue;
        items.push({ name: 'embedded_image' + String(i + 1).padStart(2, '0') + '.jpg', blob: blob });
      }
    }
    if (!items.length) throw new Error('No embedded images were found. Scanned pages are full-page pictures — use PDF to JPG to export those.');
    if (items.length === 1) return { items: items, note: 'Extracted 1 image' };
    const zip = new window.JSZip();
    items.forEach((it) => zip.file(it.name, it.blob));
    const blob = await zip.generateAsync({ type: 'blob' });
    return { items: [{ name: 'extracted_images.zip', blob: blob }], note: 'Extracted ' + items.length + ' image(s) into a ZIP' };
  },

  /* ---------------- Sharing + whiteboard ---------------- */

  async 'p2p-share'() {
    const f = state.files[0];
    if (!f) throw new Error('Choose the file you want to send first');
    if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC');
    state.p2p = state.p2p || {};
    state.p2p.file = f;
    wireP2P();
    p2pLog('Ready to send: ' + f.name + ' (' + fmtBytes(f.size) + ')');
    return { note: f.name + ' is ready. Press “1 · Create invite”, send the code to the other person, then exchange codes and press Connect.' };
  },

  async 'collab-whiteboard'() {
    wireWhiteboard();
    return { note: 'Draw on the board above. Tabs of this site on this device share the board; press Download PNG to save it.' };
  },
};

async function imagesFromPdf(format, dpi) {
  const f = needPdf();
  const src = await openPdfjs(await bytesOf(f));
  const items = [];
  for (let i = 1; i <= src.numPages; i++) {
    toast('Rendering page ' + i + '/' + src.numPages);
    const page = await src.getPage(i);
    const canvas = await renderPageToCanvas(page, dpi / 72);
    const blob = await canvasToBlob(canvas, format === 'png' ? 'image/png' : 'image/jpeg', 0.92);
    items.push({ name: 'ihatepdf_page-' + i + '.' + (format === 'png' ? 'png' : 'jpg'), blob: blob });
  }
  return { items: items, note: 'Exported ' + items.length + ' page image(s)' };
}

function setBusy(btn, label, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.innerHTML = on ? '<span class="spin"></span> ' + label + '…' : label;
}

function showResult(res) {
  const box = document.getElementById('result');
  if (!box) return;
  box.classList.remove('hidden');
  let html = '<h3>✓ ' + escHtml(res.note || 'Done — your file(s) are ready') + '</h3>';
  if (res.items && res.items.length) {
    html += '<div class="dl">' + res.items.map((it, i) => {
      const url = URL.createObjectURL(it.blob);
      return '<a href="' + url + '" download="' + escHtml(it.name) + '" data-auto="' + (i === 0 ? '1' : '0') + '">⬇ <span>' + escHtml(it.name) + '</span><span class="sz">' + fmtBytes(it.blob.size) + '</span></a>';
    }).join('') + '</div>';
  }
  if (res.text) {
    html += '<textarea id="result-text" readonly>' + escHtml(res.text) + '</textarea>';
  }
  box.innerHTML = html;
  if (res.items && res.items.length === 1) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(res.items[0].blob);
    a.download = res.items[0].name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runTool(id) {
  const t = toolById(id);
  if (!t || state.busy) return;
  const btn = document.getElementById('run');
  state.busy = true;
  setBusy(btn, t.action, true);
  try {
    const res = await HANDLERS[id]();
    showResult(res || {});
  } catch (e) {
    console.error(e);
    toast(e && e.message ? e.message : 'Something went wrong', 'err');
  } finally {
    state.busy = false;
    setBusy(btn, t.action, false);
  }
}

/* ---------------- sidebar + search ---------------- */

function buildSidebar(route) {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.innerHTML = `
    <button class="sb-close" id="sb-close" aria-label="Close tools menu">✕</button>
    <a class="sb-home ${route === 'home' ? 'active' : ''}" href="#/">▦ Dashboard</a>
    <p class="sb-label">Tools</p>
    ${CATEGORIES.map((cat) => {
      const tools = TOOLS.filter((t) => t.cat === cat.id);
      return `
        <div class="sb-group">
          <p class="sb-title"><span class="sb-ic">${cat.icon}</span><span>${cat.title}</span><span class="sb-count">${tools.length}</span></p>
          ${tools.map((t) => `<a class="sb-link ${route === t.id ? 'active' : ''}" href="#/${t.id}" data-tool="${t.id}">${t.name}</a>`).join('')}
        </div>`;
    }).join('')}
    <p class="sb-note"><span class="dot"></span> Files are processed locally. Nothing is uploaded.</p>
  `;
}

function wireHomeTabs() {
  const tabs = document.getElementById('tool-tabs');
  if (!tabs) return;
  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const cat = btn.dataset.cat;
    Array.from(tabs.querySelectorAll('.tab')).forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.category').forEach((sec) => {
      sec.classList.toggle('hidden', cat !== 'all' && sec.dataset.cat !== cat);
    });
  });
}

function openSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if (sb) sb.classList.add('open');
  if (bd) bd.classList.add('show');
}

function closeSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if (sb) sb.classList.remove('open');
  if (bd) bd.classList.remove('show');
}

function renderSearchResults(query) {
  const box = document.getElementById('search-results');
  if (!box) return;
  const q = String(query || '').trim().toLowerCase();
  const matches = TOOLS.filter((t) => {
    if (!q) return true;
    return (t.name + ' ' + t.desc + ' ' + t.id).toLowerCase().includes(q);
  });
  box.innerHTML = matches.length
    ? matches.map((t) => {
        const cat = categoryOf(t);
        return `<a class="search-hit" href="#/${t.id}">
          <span class="hit-icon">${t.icon}</span>
          <span class="hit-body"><strong>${t.name}</strong><small>${cat ? cat.title : 'PDF tool'}</small></span>
          <span class="hit-go">↵</span>
        </a>`;
      }).join('')
    : '<p class="search-empty">No tools match that search.</p>';
}

function openSearch() {
  const modal = document.getElementById('search-modal');
  const input = document.getElementById('search-input');
  if (!modal || !input) return;
  modal.classList.remove('hidden');
  input.value = '';
  renderSearchResults('');
  window.setTimeout(() => input.focus(), 30);
}

function closeSearch() {
  const modal = document.getElementById('search-modal');
  if (modal) modal.classList.add('hidden');
}

/* ---------------- rendering ---------------- */

function render() {
  const route = currentRoute();
  const view = document.getElementById('view');
  const tool = toolById(route);
  const prev = state.lastTool;
  state.tool = tool ? tool.id : null;

  closeSidebar();
  closeSearch();
  buildSidebar(route);

  if (!tool || tool.id !== 'scan-to-pdf') stopCamera();

  if (tool) {
    if (prev !== tool.id && state.files.length && !filesMatchAccept(state.files, tool.accept)) {
      state.files = [];
      state.pageOps = null;
    }
    state.lastTool = tool.id;
    view.innerHTML = toolPageHtml(tool);
    renderFiles();
    wireDropzone();
    afterFiles(tool.id).catch((e) => console.error(e));
  } else {
    state.lastTool = null;
    view.innerHTML = homeHtml();
    wireHomeDropzone();
    wireHomeTabs();
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function wireDropzone() {
  const dz = document.getElementById('dz');
  if (!dz) return;
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const t = toolById(state.tool || '');
    if (t && e.dataTransfer) addFiles(e.dataTransfer.files, t).catch((err) => toast(err.message, 'err'));
  });
}

function wireHomeDropzone() {
  const dz = document.getElementById('dz');
  if (!dz) return;
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    if (!e.dataTransfer) return;
    await addFiles(e.dataTransfer.files, { accept: 'pdf', multiple: true, id: 'home' });
    if (state.files.length) navigateTo('#/merge-pdf');
  });
}

function navigateTo(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

/* ---------------- global events ---------------- */

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (!el || el.id !== 'file-input') return;
  const files = Array.from(el.files || []);
  el.value = '';
  const t = toolById(state.tool || '');
  if (t) {
    await addFiles(files, t).catch((err) => toast(err.message, 'err'));
  } else {
    await addFiles(files, { accept: 'pdf', multiple: true, id: 'home' });
    if (state.files.length) navigateTo('#/merge-pdf');
  }
});

document.addEventListener('click', (e) => {
  const el = e.target;
  if (!el || !el.closest) return;
  if (el.closest('#sb-close')) { closeSidebar(); return; }
  const removeBtn = el.closest('[data-remove]');
  if (removeBtn) {
    state.files = state.files.filter((f) => f.id !== removeBtn.dataset.remove);
    renderFiles();
    if (['organize-pages', 'extract-pdf-pages', 'redact-pdf', 'fill-pdf-form', 'edit-pdf-metadata'].includes(state.tool)) {
      afterFiles(state.tool).catch(() => {});
    }
    return;
  }
  const scanRemove = el.closest('[data-scan-remove]');
  if (scanRemove) {
    state.scans.splice(parseInt(scanRemove.dataset.scanRemove, 10), 1);
    renderScanThumbs();
    return;
  }
  const moveBtn = el.closest('[data-move]');
  if (moveBtn) {
    moveFile(parseInt(moveBtn.dataset.i, 10), moveBtn.dataset.move);
    return;
  }
  const opBtn = el.closest('[data-op]');
  if (opBtn) {
    organizeOp(parseInt(opBtn.dataset.i, 10), opBtn.dataset.op);
    return;
  }
  const runBtn = el.closest('#run');
  if (runBtn) {
    runTool(state.tool || '').catch((err) => toast(err.message, 'err'));
  }
});

document.getElementById('nav-toggle')?.addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  if (sb && sb.classList.contains('open')) closeSidebar();
  else openSidebar();
});
document.getElementById('sidebar-backdrop')?.addEventListener('click', closeSidebar);
document.getElementById('search-open')?.addEventListener('click', openSearch);
document.getElementById('search-input')?.addEventListener('input', (e) => renderSearchResults(e.target.value));
document.getElementById('search-modal')?.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'search-modal') closeSearch();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
  }
  if (e.key === 'Escape') {
    closeSearch();
    closeSidebar();
  }
});

window.addEventListener('hashchange', render);
window.addEventListener('popstate', render);
document.addEventListener('DOMContentLoaded', render);
