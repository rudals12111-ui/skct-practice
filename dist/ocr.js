// Local OCR (tesseract.js, Korean + English). Scripts, WASM and language data are
// served from ./vendor/ocr, so nothing leaves the computer. Workers are created on
// first use and reused for a whole batch, then released after a short idle period.
import {planPage, inkMaskFromRGBA, flattenOcr, prepareOcrPixels, BLOCK_OCR, blockCropSize, mapBlockLines} from './autocrop.js';

let pagePromise = null, digitPromise = null, idleTimer = null, progressFn = () => {};
const base = {
  workerPath: new URL('./vendor/ocr/worker.min.js', import.meta.url).href,
  corePath: new URL('./vendor/ocr/core/', import.meta.url).href,
  langPath: new URL('./vendor/ocr/lang', import.meta.url).href,
  workerBlobURL: false,
  logger: m => { if (m.status === 'recognizing text') progressFn(m.progress); },
};
// The bundled ESM build exposes the API only as its default export.
async function lib() { const m = await import('./vendor/ocr/tesseract.esm.min.js'); return m.default?.createWorker ? m.default : m; }
async function pageWorker() {
  pagePromise ??= (async () => { const {createWorker, PSM} = await lib(); const w = await createWorker(['kor', 'eng'], 1, base); await w.setParameters({tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1'}); return w; })();
  return pagePromise;
}
async function digitWorker() {
  digitPromise ??= (async () => { const {createWorker, PSM} = await lib(); const w = await createWorker('eng', 1, {...base, logger: () => {}}); await w.setParameters({tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.'}); return w; })();
  return digitPromise;
}
function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(releaseOcr, 90000); }
export async function releaseOcr() {
  clearTimeout(idleTimer);
  const ws = [pagePromise, digitPromise]; pagePromise = digitPromise = null;
  for (const p of ws) { try { await (await p)?.terminate(); } catch { /* already gone */ } }
}

function canvasFrom(width, height) { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; }

/**
 * Convert PDF text-layer items ({str,x,y,width,height} in canvas pixels, y = baseline)
 * into OCR-style lines so text PDFs skip OCR entirely.
 */
export function textItemsToLines(items) {
  const boxes = items.filter(i => i.str && i.str.trim()).map(i => ({text: i.str, bbox: {x0: i.x, y0: i.y - i.height, x1: i.x + Math.max(i.width || 0, i.height * 0.5 * i.str.length), y1: i.y + i.height * 0.2}}));
  boxes.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const lines = [];
  for (const b of boxes) {
    const h = b.bbox.y1 - b.bbox.y0;
    const line = lines.find(l => Math.abs(l.bbox.y0 - b.bbox.y0) < h * 0.5 && b.bbox.x0 - l.bbox.x1 < h * 3 && b.bbox.x0 >= l.bbox.x0);
    if (line) { line.parts.push(b); line.bbox.x1 = Math.max(line.bbox.x1, b.bbox.x1); line.bbox.y1 = Math.max(line.bbox.y1, b.bbox.y1); }
    else lines.push({bbox: {...b.bbox}, parts: [b]});
  }
  return lines.map(l => {
    l.parts.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const text = l.parts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
    const first = l.parts[0], word = first.text.trim().split(/\s+/)[0];
    const frac = Math.min(1, word.length / Math.max(1, first.text.trim().length));
    return {text, bbox: l.bbox, words: [{text: word, bbox: {...first.bbox, x1: first.bbox.x0 + (first.bbox.x1 - first.bbox.x0) * frac}}]};
  });
}

/**
 * Analyse the rendered page canvas and return a crop plan (see autocrop.planPage).
 * options: {columns, expectNext, hideKeywordTags, textItems, forceOcr, onProgress(stage, fraction)}
 */
export async function analyzeCanvas(canvas, options = {}) {
  const {textItems = [], forceOcr = false, onProgress = () => {}} = options;
  const W = canvas.width, H = canvas.height;
  const pixels = canvas.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, W, H);
  const mask = inkMaskFromRGBA(pixels.data, W, H);
  const textChars = textItems.reduce((n, i) => n + (i.str?.trim().length || 0), 0);
  let lines, usedOcr = false;
  if (!forceOcr && textChars > 40) {
    lines = textItemsToLines(textItems);
    onProgress('text', 1);
  } else {
    usedOcr = true;
    onProgress('load', 0);
    const worker = await pageWorker(); touch();
    const prepared = canvasFrom(W, H);
    const prep = prepareOcrPixels(pixels.data, W, H);
    const img = new ImageData(prep, W, H); prepared.getContext('2d').putImageData(img, 0, 0);
    progressFn = f => onProgress('page', f);
    const {data} = await worker.recognize(prepared, {}, {blocks: true});
    lines = flattenOcr(data);
    // Lettering inside filled boxes (section tabs, title bars) is read separately.
    if (prep.blocks.length) {
      const {PSM} = await lib();
      await worker.setParameters({tessedit_pageseg_mode: PSM.SINGLE_BLOCK});
      try {
        for (const b of prep.blocks) {
          const {w, h} = blockCropSize(b), c = canvasFrom(w, h), g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high';
          g.drawImage(prepared, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, BLOCK_OCR.pad, BLOCK_OCR.pad, (b.x1 - b.x0) * BLOCK_OCR.scale, (b.y1 - b.y0) * BLOCK_OCR.scale);
          const res = await worker.recognize(c, {}, {blocks: true});
          lines.push(...mapBlockLines(flattenOcr(res.data), b));
        }
      } finally { await worker.setParameters({tessedit_pageseg_mode: PSM.AUTO}); }
    }
    progressFn = () => {};
    prepared.width = prepared.height = 1;
  }
  const verify = async r => {
    const digits = await digitWorker(); touch();
    const w = Math.max(1, Math.round(r.x1 - r.x0)), h = Math.max(1, Math.round(r.y1 - r.y0)), pad = 12;
    const c = canvasFrom(w * 2 + pad * 2, h * 2 + pad * 2), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, r.x0, r.y0, w, h, pad, pad, w * 2, h * 2);
    const res = await digits.recognize(c);
    return res.data.text.trim() || null;
  };
  onProgress('layout', 1);
  const plan = await planPage({width: W, height: H, lines}, mask, {...options, verify});
  plan.usedOcr = usedOcr;
  plan.lineCount = lines.length;
  return plan;
}

/**
 * Read answer-key tables from canvases (screenshots, image files or a rendered PDF page).
 * Returns [{section, labelText, inferred, entries:[{number, answer, confidence}]}].
 */
export async function readAnswerKeyCanvases(canvases, {onProgress = () => {}} = {}) {
  const {readAnswerKeys, renderDigitTemplates, TEMPLATE_FONTS, labelPixels} = await import('./answerkey.js');
  // Small screenshots are enlarged so thin strokes survive binarization.
  const sources = canvases.map(src => {
    const s = Math.min(4, Math.max(1, Math.ceil(1400 / src.width)));
    if (s === 1) return src;
    const c = canvasFrom(src.width * s, src.height * s), g = c.getContext('2d', {willReadFrequently: true});
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  });
  const images = sources.map(c => ({rgba: c.getContext('2d', {willReadFrequently: true}).getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height}));
  onProgress('load', 0);
  const [page, digits, {PSM}] = await Promise.all([pageWorker(), digitWorker(), lib()]);
  touch();
  const crop = (c, r, label = -1) => {
    const w = Math.max(1, Math.round(r.x1 - r.x0)), h = Math.max(1, Math.round(r.y1 - r.y0)), k = label >= 2 ? 2 : 1;
    const o = canvasFrom(w * k + 24, h * k + 24), g = o.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, o.width, o.height);
    if (label < 0) { g.drawImage(c, r.x0, r.y0, w, h, 12, 12, w, h); return o; }
    const src = c.getContext('2d', {willReadFrequently: true}).getImageData(r.x0, r.y0, w, h);
    const t = canvasFrom(w, h); t.getContext('2d').putImageData(new ImageData(labelPixels(src.data, w, h, {stripEdges: label % 2 === 0}), w, h), 0, 0);
    g.drawImage(t, 0, 0, w, h, 12, 12, w * k, h * k);
    return o;
  };
  await page.setParameters({tessedit_pageseg_mode: PSM.SINGLE_LINE});
  try {
    const templates = renderDigitTemplates((w, h) => canvasFrom(w, h), TEMPLATE_FONTS);
    return await readAnswerKeys(images, {
      templates,
      readNumber: async (i, r) => (await digits.recognize(crop(sources[i], r))).data.text.trim() || null,
      readLabel: async (i, r, attempt) => (await page.recognize(crop(sources[i], r, attempt))).data.text.trim(),
      onProgress: (done, total) => onProgress('table', done / total),
    });
  } finally { await page.setParameters({tessedit_pageseg_mode: PSM.AUTO}); touch(); }
}
