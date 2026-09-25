// Development tool: run the same PDF -> OCR -> auto-crop pipeline as the browser in Node.
// Usage: node tools/ocr-node.mjs <file.pdf> [startPage] [endPage] [--out=dir] [--save-ocr=dir]
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorker, PSM} from 'tesseract.js';
import {createCanvas} from '@napi-rs/canvas';
import {planPage, inkMaskFromRGBA, flattenOcr, prepareOcrPixels, BLOCK_OCR, blockCropSize, mapBlockLines} from '../dist/autocrop.js';
import {readAnswerKeys, renderDigitTemplates, TEMPLATE_FONTS, labelPixels} from '../dist/answerkey.js';
import {loadImage} from '@napi-rs/canvas';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const [file, s = '1', e] = args.filter(a => !a.startsWith('--'));
const langPath = path.join(root, 'dist/vendor/ocr/lang');

export async function renderPdfPages(pdfPath, start, end) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({data: new Uint8Array(await fs.readFile(pdfPath)), verbosity: 0, isEvalSupported: false}).promise;
  const pages = [];
  for (let n = start; n <= Math.min(end ?? doc.numPages, doc.numPages); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({scale: 1});
    // Same scale rule as builder.js renderPage().
    const scale = Math.min(2.4, 1800 / base.width, 2600 / base.height);
    const viewport = page.getViewport({scale});
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({canvasContext: ctx, viewport, canvas}).promise;
    pages.push({n, canvas});
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

export async function createOcr() {
  const opts = {langPath, gzip: true, cachePath: path.join(root, 'tests/.ocr-cache')};
  const page = await createWorker(['kor', 'eng'], 1, opts);
  await page.setParameters({tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1'});
  const digits = await createWorker('eng', 1, opts);
  await digits.setParameters({tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789.'});
  return {
    async analyze(canvas, options = {}) {
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const prepared = createCanvas(canvas.width, canvas.height);
      const pd = prepared.getContext('2d').createImageData(canvas.width, canvas.height);
      const prep = prepareOcrPixels(pixels.data, canvas.width, canvas.height); pd.data.set(prep); pd.data.blocks = prep.blocks; prepared.getContext('2d').putImageData(pd, 0, 0);
      if (process.env.DUMP_PREP) await fs.writeFile(process.env.DUMP_PREP, prepared.toBuffer('image/png'));
      const prepBuf = prepared.toBuffer('image/png');
      const {data} = await page.recognize(prepBuf, {}, {blocks: true});
      const lines = flattenOcr(data);
      // Lettering inside filled boxes (section tabs, title bars).
      const blocks = pd.data.blocks || [];
      if (blocks.length) {
        await page.setParameters({tessedit_pageseg_mode: PSM.SINGLE_BLOCK});
        for (const b of blocks) {
          const {w, h} = blockCropSize(b), c = createCanvas(w, h), g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high';
          g.drawImage(prepared, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, BLOCK_OCR.pad, BLOCK_OCR.pad, (b.x1 - b.x0) * BLOCK_OCR.scale, (b.y1 - b.y0) * BLOCK_OCR.scale);
          const res = await page.recognize(c.toBuffer('image/png'), {}, {blocks: true});
          lines.push(...mapBlockLines(flattenOcr(res.data), b));
        }
        await page.setParameters({tessedit_pageseg_mode: PSM.AUTO});
      }
      const ocr = {width: canvas.width, height: canvas.height, lines};
      const mask = inkMaskFromRGBA(pixels.data, canvas.width, canvas.height);
      const verify = async r => {
        const w = Math.round(r.x1 - r.x0), h = Math.round(r.y1 - r.y0), pad = 12;
        const c = createCanvas(w * 2 + pad * 2, h * 2 + pad * 2), g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, r.x0, r.y0, w, h, pad, pad, w * 2, h * 2);
        const res = await digits.recognize(c.toBuffer('image/png'));
        return res.data.text.trim() || null;
      };
      const plan = await planPage(ocr, mask, {verify, ...options});
      return {ocr, plan};
    },
    async terminate() { await page.terminate(); await digits.terminate(); },
  };
}

/** Read answer-key images (PNG/JPG paths or canvases). Same logic as the browser's readAnswerKeyImages(). */
export async function readKeyFiles(paths) {
  const opts = {langPath, gzip: true, cachePath: path.join(root, 'tests/.ocr-cache')};
  const label = await createWorker(['kor', 'eng'], 1, opts);
  await label.setParameters({tessedit_pageseg_mode: PSM.SINGLE_LINE});
  const digits = await createWorker('eng', 1, opts);
  await digits.setParameters({tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: '0123456789'});
  const canvases = [];
  for (const p of paths) {
    if (typeof p !== 'string') { canvases.push(p); continue; } // already a canvas (rendered PDF page)
    const img = await loadImage(p);
    const s = Math.min(4, Math.max(1, Math.ceil(1400 / img.width)));
    const c = createCanvas(img.width * s, img.height * s), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
    canvases.push(c);
  }
  const crop = (c, r, label = -1) => {
    const w = Math.round(r.x1 - r.x0), h = Math.round(r.y1 - r.y0), k = label >= 2 ? 2 : 1;
    const o = createCanvas(w * k + 24, h * k + 24), g = o.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, o.width, o.height);
    if (label < 0) { g.drawImage(c, r.x0, r.y0, w, h, 12, 12, w, h); return o.toBuffer('image/png'); }
    const src = c.getContext('2d').getImageData(r.x0, r.y0, w, h);
    const t = createCanvas(w, h), x = t.getContext('2d').createImageData(w, h);
    x.data.set(labelPixels(src.data, w, h, {stripEdges: label % 2 === 0})); t.getContext('2d').putImageData(x, 0, 0);
    g.drawImage(t, 0, 0, w, h, 12, 12, w * k, h * k);
    return o.toBuffer('image/png');
  };
  const images = canvases.map(c => ({rgba: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height}));
  const templates = renderDigitTemplates((w, h) => createCanvas(w, h), TEMPLATE_FONTS);
  const tables = await readAnswerKeys(images, {
    templates,
    readNumber: async (i, r) => (await digits.recognize(crop(canvases[i], r))).data.text.trim() || null,
    readLabel: async (i, r, attempt) => (await label.recognize(crop(canvases[i], r, attempt))).data.text.trim(),
  });
  await label.terminate(); await digits.terminate();
  return tables;
}

if (file && import.meta.url === `file://${process.argv[1]}`) {
  const out = flag('out'), saveOcr = flag('save-ocr');
  const pages = await renderPdfPages(file, Number(s), e ? Number(e) : undefined);
  const ocr = await createOcr();
  let expectNext = null;
  for (const {n, canvas} of pages) {
    const t = Date.now();
    const {ocr: raw, plan} = await ocr.analyze(canvas, {expectNext});
    console.log(`p.${n} ${canvas.width}x${canvas.height} ${Date.now() - t}ms section=${plan.section} questions=${plan.questions.map(q => q.label + '(' + q.source + ')').join(',')}${plan.shared.length ? ' shared=' + plan.shared.map(s => s.from + '~' + s.to).join(',') : ''}`);
    for (const w of plan.warnings) console.log('   ! ' + w);
    const last = plan.questions.at(-1)?.label; if (last) expectNext = last + 1;
    if (saveOcr) { await fs.mkdir(saveOcr, {recursive: true}); await fs.writeFile(path.join(saveOcr, `p${n}.ocr.json`), JSON.stringify(raw)); }
    if (out) {
      await fs.mkdir(out, {recursive: true});
      const ctx = canvas.getContext('2d');
      for (const q of plan.questions) {
        const r = q.rect, x = Math.round(r.x * canvas.width), y = Math.round(r.y * canvas.height), w = Math.round(r.w * canvas.width), h = Math.round(r.h * canvas.height);
        const c = createCanvas(w, h), g = c.getContext('2d'); g.drawImage(canvas, x, y, w, h, 0, 0, w, h);
        g.fillStyle = '#fff'; for (const m of q.masks) g.fillRect(m.x * canvas.width - x, m.y * canvas.height - y, m.w * canvas.width, m.h * canvas.height);
        await fs.writeFile(path.join(out, `p${n}-q${q.label}.png`), c.toBuffer('image/png'));
      }
      ctx.lineWidth = 4;
      for (const q of plan.questions) { ctx.strokeStyle = '#e0245e'; ctx.strokeRect(q.rect.x * canvas.width, q.rect.y * canvas.height, q.rect.w * canvas.width, q.rect.h * canvas.height); ctx.fillStyle = '#e0245e'; ctx.font = 'bold 40px sans-serif'; ctx.fillText(String(q.label), q.rect.x * canvas.width + 6, q.rect.y * canvas.height + 40); for (const m of q.masks) { ctx.strokeStyle = '#1a7f37'; ctx.strokeRect(m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height); } }
      await fs.writeFile(path.join(out, `p${n}-overlay.png`), canvas.toBuffer('image/png'));
    }
  }
  await ocr.terminate();
}
