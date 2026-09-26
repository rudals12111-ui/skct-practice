// Automatic question-region planner for scanned question books.
// Pure logic: takes OCR lines/words plus a binary ink mask of the rendered page
// and returns normalized crop rectangles. OCR itself lives in ocr.js so this
// module can be unit-tested in Node with recorded OCR output.

export const SECTION_KEYWORDS = [
  ['language', ['언어이해', '언어 이해']],
  ['data', ['자료해석', '자료 해석']],
  ['math', ['창의수리', '창의 수리', '응용수리']],
  ['logic', ['언어추리', '언어 추리']],
  ['sequence', ['수열추리', '수열 추리']],
];
const HEADER_WORDS = /모의고사|문항\s*수|제한\s*시간|하반기|상반기|기출복원|실전|PART|Part|CHAPTER|유형/;
const KEYWORD_TAG = /키워드|기출\s*키|하반\S{0,3}\s*기출|상반\S{0,3}\s*기출/;
// Right-aligned tag lines such as "| 2025 하반기 기출 키워드 | 면역 체계" (often OCR-garbled).
const isKeywordTag = (line, W) => KEYWORD_TAG.test(line.text) || (line.bbox.x0 > W * 0.45 && /^[^\w가-힣]{0,2}\s*[1lI|]?\s*20\d\d/.test(line.text) && /[|ㅣ]/.test(line.text.slice(1)));
const STEM_HINT = /\?|것은|고르|구하|옳은|적절한|알맞은|몇\s|얼마/;
const SHARED_MARKER = /^[\[\(【]?\s*(\d{1,3})\s*[~∼～\-–]\s*(\d{1,3})\s*[\]\)】]?/;

const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Build a 1-byte-per-pixel ink mask from RGBA pixels. Dark or strongly coloured pixels count as ink. */
export function inkMaskFromRGBA(rgba, width, height, threshold = 175) {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < data.length; i += 4, p++) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Coloured numbers (blue/red headings) have moderate luminance but high saturation.
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    data[p] = lum < threshold || (sat > 90 && lum < 215) ? 1 : 0;
  }
  return { width, height, data };
}

/**
 * Grayscale copy of the page for OCR in which solid colour blocks (section tabs,
 * title bars with white lettering) are inverted, so their text reads dark-on-light.
 * Returns a new RGBA Uint8ClampedArray.
 */
export function prepareOcrPixels(rgba, width, height, cell = 12) {
  const out = new Uint8ClampedArray(rgba.length);
  const gw = Math.ceil(width / cell), gh = Math.ceil(height / cell);
  const dense = new Uint8Array(gw * gh), frac = new Float32Array(gw * gh);
  const lum = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < lum.length; i += 4, p++) lum[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let dark = 0, n = 0;
    for (let y = gy * cell; y < Math.min(height, (gy + 1) * cell); y++) for (let x = gx * cell; x < Math.min(width, (gx + 1) * cell); x++) { n++; if (lum[y * width + x] < 150) dark++; }
    frac[gy * gw + gx] = dark / n; dense[gy * gw + gx] = dark / n > 0.5 ? 1 : 0;
  }
  // Keep only blocks (a cell whose neighbourhood is mostly dense) so bold glyphs are not inverted.
  const block = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let d = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= gw || y >= gh) continue; n++; d += dense[y * gw + x]; }
    block[gy * gw + gx] = d / n > 0.6 ? 1 : 0;
  }
  // Grow by one cell so glyph edges inside the block are covered, but never into white paper.
  const grown = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let any = 0; for (let dy = -1; dy <= 1 && !any; dy++) for (let dx = -1; dx <= 1; dx++) { const x = gx + dx, y = gy + dy; if (x >= 0 && y >= 0 && x < gw && y < gh && block[y * gw + x]) { any = 1; break; } }
    grown[gy * gw + gx] = block[gy * gw + gx] || (any && frac[gy * gw + gx] > 0.2) ? 1 : 0;
  }
  for (let y = 0, p = 0; y < height; y++) for (let x = 0; x < width; x++, p++) {
    const v = grown[Math.floor(y / cell) * gw + Math.floor(x / cell)] ? 255 - lum[p] : lum[p];
    const i = p * 4; out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  // Connected block regions (grid units -> pixels); their text is OCR'd separately
  // because layout analysis tends to skip lettering inside filled boxes.
  const seen = new Uint8Array(gw * gh), blocks = [];
  for (let i = 0; i < block.length; i++) {
    if (!block[i] || seen[i]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0; const stack = [i]; seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), gx = j % gw, gy = (j / gw) | 0;
      x0 = Math.min(x0, gx); y0 = Math.min(y0, gy); x1 = Math.max(x1, gx); y1 = Math.max(y1, gy);
      for (const k of [j - 1, j + 1, j - gw, j + gw]) if (k >= 0 && k < block.length && block[k] && !seen[k] && Math.abs((k % gw) - gx) <= 1) { seen[k] = 1; stack.push(k); }
    }
    const r = { x0: x0 * cell, y0: y0 * cell, x1: Math.min(width, (x1 + 1) * cell), y1: Math.min(height, (y1 + 1) * cell) };
    if (r.x1 - r.x0 >= cell * 2 && r.y1 - r.y0 >= cell * 2 && (r.x1 - r.x0) * (r.y1 - r.y0) < width * height * 0.25) blocks.push(r);
  }
  out.blocks = blocks;
  return out;
}

function rowProfile(mask, x0, x1, y0, y1) {
  x0 = clamp(Math.floor(x0), 0, mask.width); x1 = clamp(Math.ceil(x1), 0, mask.width);
  y0 = clamp(Math.floor(y0), 0, mask.height); y1 = clamp(Math.ceil(y1), 0, mask.height);
  const out = new Uint32Array(Math.max(0, y1 - y0));
  for (let y = y0; y < y1; y++) { let c = 0; const row = y * mask.width; for (let x = x0; x < x1; x++) c += mask.data[row + x]; out[y - y0] = c; }
  return { y0, out };
}
function colProfile(mask, x0, x1, y0, y1) {
  x0 = clamp(Math.floor(x0), 0, mask.width); x1 = clamp(Math.ceil(x1), 0, mask.width);
  y0 = clamp(Math.floor(y0), 0, mask.height); y1 = clamp(Math.ceil(y1), 0, mask.height);
  const out = new Uint32Array(Math.max(0, x1 - x0));
  for (let y = y0; y < y1; y++) { const row = y * mask.width; for (let x = x0; x < x1; x++) out[x - x0] += mask.data[row + x]; }
  return { x0, out };
}

/**
 * Is there a line of text-like ink right of a label? Used when OCR dropped the stem line entirely
 * (a bold stem next to "11." on a busy page): several separate glyphs across a good stretch of the row.
 */
function inkTextBeside(mask, x1, y0, y1) {
  const W = mask.width;
  const cp = colProfile(mask, x1 + W * 0.012, Math.min(W, x1 + W * 0.36), y0, y1);
  if (!cp.out.length) return false;
  let inked = 0, runs = 0, prev = false;
  for (const v of cp.out) { const on = v > 0; if (on) inked++; if (on && !prev) runs++; prev = on; }
  return inked / cp.out.length > 0.25 && runs >= 8;
}

/** Normalise tesseract.js block output (or a flat list of lines) to [{text,bbox,words}]. */
export function flattenOcr(data) {
  if (Array.isArray(data?.lines) && data.lines.length && data.lines[0].bbox) return data.lines;
  const lines = [];
  for (const block of data?.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    if (!line.bbox || !line.text?.trim()) continue;
    lines.push({ text: line.text.trim(), bbox: { ...line.bbox }, words: (line.words || []).filter(w => w.text?.trim()).map(w => ({ text: w.text.trim(), bbox: { ...w.bbox }, confidence: w.confidence })) });
  }
  return lines;
}

/** Filled-box lettering is OCR'd on its own padded, enlarged crop: a rectangle cut tight to the
 * text misreads it ("수열추리" -> "스열츠긴"). These give the crop geometry and map lines back. */
export const BLOCK_OCR = { pad: 16, scale: 2 };
export function blockCropSize(b) {
  const { pad, scale } = BLOCK_OCR;
  return { w: (b.x1 - b.x0) * scale + pad * 2, h: (b.y1 - b.y0) * scale + pad * 2 };
}
export function mapBlockLines(lines, b) {
  const { pad, scale } = BLOCK_OCR;
  const box = r => ({ x0: b.x0 + (r.x0 - pad) / scale, y0: b.y0 + (r.y0 - pad) / scale, x1: b.x0 + (r.x1 - pad) / scale, y1: b.y0 + (r.y1 - pad) / scale });
  return lines.map(l => ({ ...l, bbox: box(l.bbox), words: (l.words || []).map(w => ({ ...w, bbox: box(w.bbox) })), furniture: true }));
}

/** Parse a question-number token. Returns the number or null. */
export function parseNumberToken(text, { loose = false } = {}) {
  const t = String(text || '').trim().replace(/[，,．。·:]/g, '.').replace(/[Oo]/g, '0').replace(/[Iil|!]/g, '1');
  let m = t.match(/^(?:Q|문제|문항)?\s*0*(\d{1,3})\s*\.$/i) || t.match(/^(?:Q|문제|문항)\s*0*(\d{1,3})\.?$/i) || t.match(/^0(\d{1,2})$/) || t.match(/^(\d{1,3})번\.?$/);
  if (!m && loose) m = t.match(/^0*(\d{1,3})\.?$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 300 ? n : null;
}

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ', JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ', JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
function jamo(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) { out += ch; continue; }
    out += CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + (c % 28 ? JONG[c % 28] : '');
  }
  return out;
}
function editDistance(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return d[b.length];
}
/** Section name printed on the page (title bars, tabs). Tolerates small OCR errors in short labels. */
export function detectSection(lines, height) {
  let best = null;
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, '');
    const short = line.furniture || text.length <= 14;
    if (!short && line.bbox.y0 > height * 0.3) continue;
    for (const [id, words] of SECTION_KEYWORDS) {
      if (words.some(w => text.includes(w.replace(/\s+/g, '')))) return id;
      if (!short) continue;
      const key = jamo(words[0]);
      for (let i = 0; i + 4 <= text.length; i++) {
        const d = editDistance(jamo(text.slice(i, i + 4)), key);
        if (d <= Math.floor(key.length * 0.3) && (!best || d < best.d)) best = { id, d };
      }
    }
  }
  return best?.id ?? null;
}

function clusterByX(items, tol) {
  const sorted = [...items].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const clusters = [];
  for (const item of sorted) {
    const c = clusters.find(c => Math.abs(c.x - item.bbox.x0) <= tol);
    if (c) { c.items.push(item); c.x = median(c.items.map(i => i.bbox.x0)); } else clusters.push({ x: item.bbox.x0, items: [item] });
  }
  return clusters;
}

/** Top of the running footer (page number, publisher line), or H*0.975 when there is none. */
export function findFooterTop(bodyLines, H, lineH) {
  const band = bodyLines.filter(l => (l.bbox.y0 + l.bbox.y1) / 2 > H * 0.88).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (const l of band) {
    const rowTop = l.bbox.y0;
    // Nearest text above this row (anything that ends above its top and is not on the same row).
    const above = bodyLines.filter(o => o.bbox.y1 <= rowTop + lineH * 0.3 && o.bbox.y0 < rowTop - lineH * 0.5);
    const gap = above.length ? rowTop - Math.max(...above.map(o => o.bbox.y1)) : 0;
    if (gap >= lineH * 1.2) return rowTop - lineH * 0.4;
  }
  return H * 0.975;
}

/**
 * Plan crops for one page.
 * @param {{width:number,height:number,lines:Array}} ocr   OCR lines in page pixels
 * @param {{width:number,height:number,data:Uint8Array}} mask  ink mask of the same page
 * @param {object} options
 *   columns: 'auto' | 1 | 2
 *   verify: async (pixelRect) => string|null  -- digits-only re-read of a candidate number blob
 *   expectNext: number|null  -- first number expected on this page (continuity across pages)
 *   hideKeywordTags: boolean
 */
export async function planPage(ocr, mask, options = {}) {
  const { columns = 'auto', verify = null, expectNext = null, hideKeywordTags = true } = options;
  const W = ocr.width, H = ocr.height, lines = flattenOcr(ocr);
  const warnings = [];
  const bodyLines = lines.filter(l => !l.furniture && l.bbox.x1 - l.bbox.x0 > 4 && l.bbox.y1 - l.bbox.y0 > 4);
  const lineH = median(bodyLines.map(l => l.bbox.y1 - l.bbox.y0)) || H * 0.013;

  // Page furniture: running footer and the side index tab.
  // The footer is the text at the bottom that stands apart from the body: choices that run down close
  // to the page number (last row of a question near the bottom) must not be taken for the footer.
  const footerTop = findFooterTop(bodyLines, H, lineH);
  const sideLines = lines.filter(l => l.bbox.x0 > W * 0.88 && l.bbox.x1 - l.bbox.x0 < W * 0.12);
  const sideX = sideLines.length ? Math.min(...sideLines.map(l => l.bbox.x0)) - W * 0.006 : W;
  const inBody = b => (b.y0 + b.y1) / 2 < footerTop && b.x0 < sideX;

  // 1. Number tokens seen directly by OCR (first word of a line).
  const candidates = [];
  for (const line of bodyLines) {
    if (!inBody(line.bbox)) continue;
    const first = line.words?.[0] || { text: line.text.split(/\s+/)[0], bbox: line.bbox };
    let n = parseNumberToken(first.text);
    let bbox = first.bbox;
    if (n === null) { // "13." glued to text, e.g. "13.다음"
      const m = first.text.match(/^0*(\d{1,3})[.．,](?=[^\d\s,])/);
      if (m) { n = Number(m[1]); const frac = m[0].length / first.text.length; bbox = { ...first.bbox, x1: first.bbox.x0 + (first.bbox.x1 - first.bbox.x0) * frac }; }
    }
    // A lone "11" (period lost in OCR) at the start of a line, if a stem follows below (checked next).
    let loose = false;
    if (n === null && (line.words?.length ?? 1) === 1 && /^\d{1,2}$/.test(first.text.trim())) { n = Number(first.text.trim()); loose = true; }
    if (n === null) continue;
    const h = bbox.y1 - bbox.y0;
    if (h < lineH * 0.55 || h > lineH * 2.6) continue;
    // A question number is followed by stem text, not by more numbers ("2, 4, 8, 16").
    const rest = line.text.slice(line.text.indexOf(first.text) + first.text.length);
    const besideStem = bodyLines.some(o => o !== line && o.bbox.x0 > bbox.x1 && o.bbox.x0 < bbox.x1 + W * 0.2 && o.bbox.y0 < bbox.y1 && o.bbox.y1 > bbox.y0 && /[가-힣A-Za-z]{2}/.test(o.text));
    if (!/[가-힣A-Za-z]{2}/.test(rest) && !besideStem && !inkTextBeside(mask, bbox.x1, bbox.y0, bbox.y1)) continue;
    // "12." or "01" look like labels; "8:" / "11" could also be other text, so they count for less
    // when deciding which x is the number column.
    const weight = /^0?\d{1,3}[.．]$|^0\d$/.test(first.text.trim()) ? 2 : 1;
    candidates.push({ n, bbox: { ...bbox }, line, source: 'ocr', weight, loose });
  }

  // 1b. Nothing read as a number (typical on a page with a single question when OCR drops
  // or garbles "01."): anchor on question stems ("…것은?") and look for the label to their left.
  if (!candidates.length) {
    const STEM_END = /(\?|？|것은|고르시오|구하시오|고르면|옳은가)\s*[.?？]?\s*$/;
    for (const line of bodyLines) {
      if (!inBody(line.bbox) || !STEM_END.test(line.text) || line.bbox.x0 > W * 0.45) continue;
      const word = (line.words || []).find(w => /[가-힣]{2}/.test(w.text));
      const stemX = word ? word.bbox.x0 : line.bbox.x0;
      const y0 = line.bbox.y0, y1 = line.bbox.y1, h = y1 - y0;
      const cp = colProfile(mask, Math.max(0, stemX - W * 0.2), stemX - 2, y0, y1);
      const blobs = []; let start = -1, gap = 0;
      for (let i = 0; i <= cp.out.length; i++) {
        const ink = i < cp.out.length && cp.out[i] > 0;
        if (ink) { if (start < 0) start = i; gap = 0; }
        else if (start >= 0 && (++gap > W * 0.006 || i === cp.out.length)) { blobs.push([start + cp.x0, i - gap + 1 + cp.x0]); start = -1; gap = 0; }
      }
      // Leftmost glyph group of label size (skips stray marks like "、").
      for (const [bx0, bx1] of blobs) {
        if (bx1 - bx0 < W * 0.012 || bx1 - bx0 > W * 0.08) continue;
        const rp = rowProfile(mask, bx0, bx1, y0 - h * 0.3, y1 + h * 0.3);
        let r0 = -1, r1 = -1; for (let i = 0; i < rp.out.length; i++) if (rp.out[i]) { if (r0 < 0) r0 = i; r1 = i; }
        if (r0 < 0 || r1 - r0 < h * 0.5) continue;
        const rect = { x0: bx0 - 3, y0: rp.y0 + r0 - 3, x1: bx1 + 3, y1: rp.y0 + r1 + 4 };
        let text = null; try { text = verify ? await verify(rect) : null; } catch { text = null; }
        const n = text ? parseNumberToken(text, { loose: true }) : null;
        candidates.push({ n, bbox: { x0: bx0, y0: rp.y0 + r0, x1: bx1, y1: rp.y0 + r1 + 1 }, line, source: n === null ? 'stem' : 'stem+ocr' });
        break;
      }
    }
    if (candidates.length) warnings.push('OCR이 문항 번호를 읽지 못해 발문 위치로 문항을 찾았습니다. 번호를 확인하세요.');
  }

  // 2. Choose the number column(s): numbers in a book are aligned on a common x.
  const score = c => c.items.reduce((t, it) => t + (it.weight || 1), 0);
  const clusters = clusterByX(candidates, W * 0.025).sort((a, b) => score(b) - score(a) || a.x - b.x);
  let chosen = [];
  if (clusters.length) {
    // Primary column: the best-supported alignment in the left half (reading starts there).
    const primary = clusters.find(c => c.x < W * 0.45) || clusters[0];
    chosen.push(primary);
    const other = clusters.filter(c => c !== primary && Math.abs(c.x - primary.x) > W * 0.3);
    if (columns === 2 || columns === '2') { if (other[0]) chosen.push(other[0]); }
    else if (columns === 'auto') { const o = other.find(c => c.items.length >= 2 || (c.x > W * 0.4 && c.x < W * 0.62)); if (o) chosen.push(o); }
    chosen.sort((a, b) => a.x - b.x);
  }
  if (!chosen.length) {
    return { width: W, height: H, questions: [], shared: [], section: detectSection(lines, H), warnings: ['문항 번호를 찾지 못했습니다. 번호 형식(예: 01.)이 다르거나 스캔 품질이 낮을 수 있습니다.'], footerTop, sideX, leading: null };
  }

  const cols = chosen.map((c, ci) => {
    const numH = median(c.items.map(i => i.bbox.y1 - i.bbox.y0));
    const numW = median(c.items.map(i => i.bbox.x1 - i.bbox.x0));
    const numRight = Math.max(...c.items.map(i => i.bbox.x1));
    return { index: ci, x: c.x, numH, numW, gutterL: c.x - W * 0.012, gutterR: numRight + W * 0.008, items: [...c.items] };
  });
  cols.forEach((c, i) => { c.limitR = i + 1 < cols.length ? cols[i + 1].gutterL - W * 0.01 : sideX; c.limitL = i > 0 ? cols[i - 1].limitR + W * 0.01 : 0; });

  // 3. Recover numbers OCR dropped: scan the number gutter for ink blobs.
  for (const col of cols) {
    const { y0, out } = rowProfile(mask, col.gutterL, col.gutterR, 0, footerTop);
    const runs = []; let start = -1, gap = 0;
    const maxGap = Math.max(2, col.numH * 0.25);
    for (let i = 0; i <= out.length; i++) {
      const ink = i < out.length && out[i] > 0;
      if (ink) { if (start < 0) start = i; gap = 0; }
      else if (start >= 0) { gap++; if (gap > maxGap || i === out.length) { runs.push([start + y0, i - gap + 1 + y0]); start = -1; gap = 0; } }
    }
    for (const [ry0, ry1] of runs) {
      const h = ry1 - ry0;
      if (h < col.numH * 0.5 || h > col.numH * 1.8) continue;
      if (col.items.some(it => ry1 > it.bbox.y0 - 2 && ry0 < it.bbox.y1 + 2)) continue;
      const cp = colProfile(mask, col.gutterL, col.limitR, ry0, ry1);
      let bx0 = -1, bx1 = -1;
      const gutterEnd = Math.round(col.gutterR - cp.x0);
      for (let i = 0; i < Math.min(cp.out.length, gutterEnd); i++) if (cp.out[i]) { if (bx0 < 0) bx0 = i; bx1 = i; }
      if (bx0 < 0) continue;
      const x0 = bx0 + cp.x0, x1 = bx1 + cp.x0 + 1;
      if (Math.abs(x0 - col.x) > W * 0.02) continue;
      if (x1 - x0 < col.numW * 0.55 || x1 - x0 > col.numW * 1.8) continue;
      // A real label is followed by white space before the stem starts.
      let clear = 0; for (let i = gutterEnd - Math.round(W * 0.004); i < gutterEnd; i++) if (i >= 0 && i < cp.out.length && cp.out[i] === 0) clear++;
      if (clear < Math.round(W * 0.004) - 1) continue;
      const rect = { x0: x0 - 3, y0: ry0 - 3, x1: x1 + 3, y1: ry1 + 3 };
      let text = null;
      try { text = verify ? await verify(rect) : null; } catch { text = null; }
      // Whatever the digits say, a real label has a stem beside it.
      const stemBeside = bodyLines.some(l => l.bbox.y0 < ry1 + col.numH * 0.5 && l.bbox.y1 > ry0 - col.numH * 0.5 && l.bbox.x0 > x1 && l.bbox.x0 < x1 + W * 0.2 && /[가-힣A-Za-z]{2}/.test(l.text));
      let n = text ? parseNumberToken(text, { loose: true }) : null;
      // OCR sometimes loses the whole stem line; a readable number followed by a row of glyphs still counts.
      if (!stemBeside && !(n !== null && inkTextBeside(mask, x1, ry0, ry1))) continue;
      // Unreadable blob: accept only when a question stem follows on the right.
      if (n === null) {
        const right = bodyLines.filter(l => l.bbox.y0 < ry1 + col.numH * 3.2 && l.bbox.y1 > ry0 - col.numH * 0.5 && l.bbox.x0 > x1 && l.bbox.x0 < x1 + W * 0.25);
        if (!(text === null && right.some(l => STEM_HINT.test(l.text)))) continue;
      }
      col.items.push({ n, bbox: { x0, y0: ry0, x1, y1: ry1 }, source: n === null ? 'pixel' : 'pixel+ocr' });
    }
    col.items.sort((a, b) => a.bbox.y0 - b.bbox.y0);
    // Drop near-duplicates (same line recognised twice).
    col.items = col.items.filter((it, i, arr) => !i || it.bbox.y0 - arr[i - 1].bbox.y1 > -2);
  }

  // 4. Drop OCR numbers that break the increasing order (e.g. a stray "3." inside a passage).
  for (const col of cols) {
    const labeled = col.items.filter(it => it.n != null);
    const keep = new Set(longestIncreasing(labeled));
    // A label found in the number margin with a stem beside it is a real question even when its digits
    // were misread ("11." read as "8"): keep it unnumbered and let the order fill in the number.
    for (const it of col.items) if (it.n != null && !keep.has(it) && (it.source.startsWith('pixel') || it.loose)) { it.misread = it.n; it.n = null; }
    col.items = col.items.filter(it => it.n == null || keep.has(it));
  }
  // Repair numbering using reading order.
  const ordered = cols.flatMap(c => c.items.map(it => ({ it, col: c })));
  repairSequence(ordered.map(o => o.it), expectNext, warnings);
  for (const { it } of ordered) if (it.misread != null && it.n != null) warnings.push(`${it.n}번 번호가 ${it.misread}(으)로 읽혀 앞뒤 순서로 ${it.n}번을 정했습니다. 확인하세요.`);

  // 5. Shared-passage markers such as [01~02] act as boundaries too.
  const markers = [];
  for (const line of bodyLines) {
    if (!inBody(line.bbox)) continue;
    const m = line.text.match(SHARED_MARKER);
    if (!m || !/[~∼～\-–]/.test(line.text.slice(0, 12))) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (!(b > a && b - a <= 10)) continue;
    const col = cols.find(c => line.bbox.x0 >= c.gutterL - W * 0.02 && line.bbox.x0 < c.gutterL + W * 0.08);
    if (!col) continue;
    markers.push({ from: a, to: b, col, y0: line.bbox.y0 - lineH * 0.5 });
  }

  // 6. Build regions.
  const questions = [], shared = [];
  for (const col of cols) {
    const bounds = [...col.items.map(it => ({ kind: 'q', it, y: it.bbox.y0 - col.numH * 0.6 })), ...markers.filter(m => m.col === col).map(m => ({ kind: 'm', m, y: m.y0 }))].sort((a, b) => a.y - b.y);
    for (let i = 0; i < bounds.length; i++) {
      const b = bounds[i];
      const top = clamp(b.y, 0, H);
      const hardBottom = i + 1 < bounds.length ? bounds[i + 1].y - 2 : footerTop;
      const rect = fitRegion(mask, bodyLines, col, top, hardBottom, W, H);
      if (!rect) continue;
      const masks = hideKeywordTags ? bodyLines.filter(l => isKeywordTag(l, W) && l.bbox.y0 >= rect.y0 && l.bbox.y1 <= rect.y1).map(l => ({ x0: Math.max(rect.x0, l.bbox.x0 - W * 0.01), y0: l.bbox.y0 - lineH * 0.25, x1: Math.min(rect.x1, l.bbox.x1 + W * 0.01), y1: l.bbox.y1 + lineH * 0.25 })) : [];
      if (b.kind === 'q') questions.push({ label: b.it.n, column: col.index, source: b.it.source, rect: norm(rect, W, H), masks: masks.map(r => norm(r, W, H)) });
      else shared.push({ from: b.m.from, to: b.m.to, column: col.index, rect: norm(rect, W, H), masks: masks.map(r => norm(r, W, H)) });
    }
  }

  // 7. Content above the first number (other than headers) may continue the previous page.
  let leading = null;
  const firstTop = Math.min(...cols.flatMap(c => c.items.map(it => it.bbox.y0 - c.numH * 0.6)), ...markers.map(m => m.y0));
  const above = bodyLines.filter(l => l.bbox.y1 < firstTop && l.bbox.x0 >= cols[0].gutterL - W * 0.02 && l.bbox.x0 < sideX && (l.bbox.y0 + l.bbox.y1) / 2 < footerTop);
  if (above.length && !above.some(l => HEADER_WORDS.test(l.text) || SECTION_KEYWORDS.some(([, w]) => w.some(k => l.text.includes(k))))) {
    const top = Math.min(...above.map(l => l.bbox.y0)) - lineH * 0.5;
    const rect = fitRegion(mask, bodyLines, cols[0], top, firstTop - 2, W, H);
    if (rect && rect.y1 - rect.y0 > lineH * 1.2) { leading = norm(rect, W, H); warnings.push('첫 문항 위에 본문이 있습니다. 이전 쪽 문항이 이어진 것일 수 있습니다.'); }
  }

  return { width: W, height: H, questions, shared, section: detectSection(lines, H), warnings, footerTop: footerTop / H, sideX: sideX / W, leading };
}

function norm(r, W, H) {
  const x = clamp(r.x0 / W, 0, 1), y = clamp(r.y0 / H, 0, 1);
  return { x, y, w: clamp(r.x1 / W, 0, 1) - x, h: clamp(r.y1 / H, 0, 1) - y };
}

/** Tighten a question band to its ink, stopping before side tabs and neighbouring columns. */
function fitRegion(mask, lines, col, top, bottom, W, H) {
  if (bottom - top < col.numH * 1.2) return null;
  const left = Math.max(col.limitL, col.gutterL);
  const within = lines.filter(l => l.bbox.y0 >= top - 2 && l.bbox.y1 <= bottom + 2 && l.bbox.x0 >= left - W * 0.02 && l.bbox.x0 < col.limitR);
  let right = within.length ? Math.max(...within.map(l => l.bbox.x1)) : col.gutterR + W * 0.3;
  right = Math.min(right, col.limitR);
  // Extend right across graphics (tables/charts) that OCR ignores, until a clear vertical gap.
  const cp = colProfile(mask, right, col.limitR, top, bottom);
  const gapNeed = Math.round(W * 0.015); let empty = 0, lastInk = -1;
  for (let i = 0; i < cp.out.length; i++) { if (cp.out[i] > 1) { lastInk = i; empty = 0; } else if (++empty >= gapNeed) break; }
  if (lastInk >= 0) right = cp.x0 + lastInk + 1;
  // Also extend left for graphics wider than the text block.
  const lp = colProfile(mask, col.limitL, left, top, bottom);
  let l = left; empty = 0;
  for (let i = lp.out.length - 1; i >= 0; i--) { if (lp.out[i] > 1) { l = lp.x0 + i; empty = 0; } else if (++empty >= gapNeed) break; }
  // Trim trailing blank rows.
  const rp = rowProfile(mask, l, right, top, bottom);
  let last = -1, first = -1;
  for (let i = 0; i < rp.out.length; i++) if (rp.out[i] > 1) { if (first < 0) first = i; last = i; }
  if (last < 0) return null;
  const pad = Math.round(W * 0.012);
  return { x0: clamp(l - pad, 0, W), y0: clamp(rp.y0 + first - pad, 0, H), x1: clamp(right + pad, 0, Math.min(W, col.limitR + pad)), y1: clamp(rp.y0 + last + 1 + pad, 0, Math.max(0, bottom + pad * 0.5)) };
}

function longestIncreasing(items) {
  const best = items.map(() => 1), prev = items.map(() => -1);
  for (let i = 0; i < items.length; i++) for (let j = 0; j < i; j++) if (items[j].n < items[i].n && best[j] + 1 > best[i]) { best[i] = best[j] + 1; prev[i] = j; }
  let k = best.indexOf(Math.max(0, ...best)); const out = [];
  while (k >= 0) { out.unshift(items[k]); k = prev[k]; }
  return out;
}

/** Fill unreadable numbers and fix obvious OCR misreads from neighbours. Mutates items. */
export function repairSequence(items, expectNext = null, warnings = []) {
  if (!items.length) return items;
  // Misread in the middle: prev and next agree on a +2 step.
  // OCR-read numbers are trusted; the page-to-page expectation only fills blanks.
  for (let i = 0; i < items.length; i++) {
    const prev = i > 0 ? items[i - 1].n : null;
    const next = items[i + 1]?.n ?? null;
    const cur = items[i].n;
    if (prev != null && next != null && next - prev === 2 && cur !== prev + 1) items[i].n = prev + 1;
    else if (cur == null && prev != null) items[i].n = prev + 1;
    else if (cur == null && i === 0 && next == null && expectNext != null) items[i].n = expectNext;
  }
  // Leading unknowns: count back from the first known.
  for (let i = items.length - 1; i >= 0; i--) if (items[i].n == null && items[i + 1]?.n != null) items[i].n = items[i + 1].n - 1;
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].n, b = items[i].n;
    if (a != null && b != null && b - a > 1) warnings.push(`문항 번호가 ${a}번 다음 ${b}번으로 건너뜁니다. 누락 여부를 확인하세요.`);
    if (a != null && b != null && b <= a) warnings.push(`문항 번호 순서가 ${a} → ${b}로 어긋납니다.`);
  }
  if (expectNext != null && items[0].n != null && items[0].n !== expectNext && items[0].n !== 1) warnings.push(`이전 쪽 다음 번호는 ${expectNext}번인데 ${items[0].n}번부터 시작합니다.`);
  return items;
}
