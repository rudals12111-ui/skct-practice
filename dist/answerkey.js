// Answer-key table reader ("빠른 정답" tables: shaded row of question numbers,
// a white row of circled answers ①~⑤ below it, a section label above the table).
// Pure pixel logic; digit reading is injected so it can run in the browser or Node.
import { detectSection } from './autocrop.js';

const lumOf = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/**
 * Find answer tables in an RGBA image.
 * Returns [{ labelRect, rows: [{ headerRect, cells: [{ numberRect, answerRect, glyphRect|null }] }] }]
 * All rects are pixel {x0,y0,x1,y1}.
 */
export function findAnswerTables(rgba, W, H) {
  const lum = new Float32Array(W * H), sat = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = lumOf(rgba, i);
    sat[p] = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) - Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  const isFill = p => lum[p] > 150 && lum[p] < 238;          // tinted header background
  const isDark = p => lum[p] < 150;                            // text, lines, glyphs

  // 1. Header bands: rows containing a long run of tinted fill (short breaks for digits and
  //    separators allowed). Using run length, not page fraction, keeps small tables on a full
  //    solution page and side-by-side tables detectable.
  const runRow = new Uint32Array(H);
  const brk = Math.max(4, Math.round(W * 0.004));
  for (let y = 0; y < H; y++) {
    let best = 0, cur = 0, gap = 0;
    for (let x = 0, p = y * W; x < W; x++, p++) {
      if (isFill(p)) { cur += gap + 1; gap = 0; }
      else if (cur && (isDark(p) || ++gap <= brk)) { if (isDark(p)) { cur += gap + 1; gap = 0; } }
      else { if (cur > best) best = cur; cur = 0; gap = 0; }
    }
    if (cur > best) best = cur;
    runRow[y] = best;
  }
  const minRun = Math.max(60, W * 0.1);
  const bands = [];
  let start = -1, gap = 0;
  for (let y = 0; y <= H; y++) {
    const on = y < H && runRow[y] >= minRun;
    if (on) { if (start < 0) start = y; gap = 0; }
    else if (start >= 0 && (++gap > 2 || y === H)) { const end = y - gap + 1; if (end - start >= 6) bands.push({ y0: start, y1: end }); start = -1; gap = 0; }
  }
  if (!bands.length) return [];
  // A band may also contain a label tab directly above the header row (shorter tinted run);
  // keep only the rows whose run is close to the band's longest run.
  const split = [];
  for (const b of bands) {
    let maxRun = 0; for (let y = b.y0; y < b.y1; y++) if (runRow[y] > maxRun) maxRun = runRow[y];
    let s0 = -1, g = 0;
    for (let y = b.y0; y <= b.y1; y++) {
      const on = y < b.y1 && runRow[y] >= maxRun * 0.6;
      if (on) { if (s0 < 0) s0 = y; g = 0; }
      else if (s0 >= 0 && (++g > 2 || y === b.y1)) { const e = y - g + 1; if (e - s0 >= 6) split.push({ y0: s0, y1: e }); s0 = -1; g = 0; }
    }
  }
  bands.length = 0; bands.push(...split);

  const rows = [];
  const tinted = p => isFill(p) || isDark(p);
  for (const band of bands) {
    const h0 = band.y1 - band.y0;
    const colFill = new Uint32Array(W), colDark = new Uint32Array(W);
    for (let y = band.y0; y < band.y1; y++) for (let x = 0, p = y * W; x < W; x++, p++) { if (isFill(p)) colFill[x]++; else if (isDark(p)) colDark[x]++; }
    // Horizontal segments (one per table placed side by side). Loose test: tables beside each
    // other may have different heights inside the same band.
    const segs = []; let sx = -1, sg = 0;
    for (let x = 0; x <= W; x++) {
      const on = x < W && colFill[x] >= Math.max(3, h0 * 0.2);
      if (on) { if (sx < 0) sx = x; sg = 0; }
      else if (sx >= 0 && (++sg > Math.max(6, W * 0.01) || x === W)) { const ex = x - sg; if (ex - sx >= 60) segs.push([sx, ex]); sx = -1; sg = 0; }
    }
    for (const [sx0, sx1] of segs) {
      // Rows of this segment that are tinted across most of its width.
      const sw = sx1 - sx0 + 1, sub = []; let r0 = -1, rg = 0;
      for (let y = band.y0; y <= band.y1; y++) {
        let f = 0, t = 0;
        if (y < band.y1) for (let x = sx0, p = y * W + sx0; x <= sx1; x++, p++) { if (isFill(p)) f++; if (tinted(p)) t++; }
        const on = y < band.y1 && t >= sw * 0.8 && f >= sw * 0.4;
        if (on) { if (r0 < 0) r0 = y; rg = 0; }
        else if (r0 >= 0 && (++rg > 2 || y === band.y1)) { const e = y - rg + 1; if (e - r0 >= 6) sub.push({ y0: r0, y1: e }); r0 = -1; rg = 0; }
      }
      for (const sb of sub) {
        const cf = new Uint32Array(W), cd = new Uint32Array(W);
        for (let y = sb.y0; y < sb.y1; y++) for (let x = sx0, p = y * W + sx0; x <= sx1; x++, p++) { if (isFill(p)) cf[x]++; else if (isDark(p)) cd[x]++; }
        const h = sb.y1 - sb.y0;
        let x0 = sx0, x1 = sx1;
        while (x0 < x1 && cf[x0] + cd[x0] < h * 0.6) x0++;
        while (x1 > x0 && cf[x1] + cd[x1] < h * 0.6) x1--;
        if (x1 - x0 < h * 4) continue;
        const row = readRow(lum, W, H, sb, x0, x1, cd, [...bands, ...sub], isDark);
        if (row) rows.push(row);
      }
    }
  }

  // 3. Group rows into tables and locate each table's label above it.
  const tables = [];
  rows.sort((a, b) => a.headerRect.y0 - b.headerRect.y0 || a.headerRect.x0 - b.headerRect.x0);
  for (const row of rows) {
    const bandH = row.headerRect.y1 - row.headerRect.y0;
    const t = tables.find(t => { const last = t.rows.at(-1); return row.headerRect.y0 - last.answerY1 < bandH * 1.5 && row.headerRect.y0 > last.headerRect.y0 && Math.abs(row.headerRect.x0 - last.headerRect.x0) < bandH * 1.5; });
    if (t) t.rows.push(row); else tables.push({ rows: [row] });
  }
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti], first = t.rows[0].headerRect, bandH = first.y1 - first.y0;
    const above = tables.slice(0, ti).filter(o => o.rows[0].headerRect.x0 < first.x1 && o.rows[0].headerRect.x1 > first.x0);
    const top = Math.max(above.length ? Math.max(...above.map(o => o.rows.at(-1).answerY1)) : 0, first.y0 - bandH * 3);
    // Label: the ink block just above the table (tab with white lettering, or plain text).
    let y1 = first.y0 - 1; while (y1 > top && rowInk(lum, W, first.x0, first.x1, y1) > (first.x1 - first.x0) * 0.5) y1--; // skip the top rule
    let ly1 = y1; while (ly1 > top && rowInk(lum, W, first.x0, first.x1, ly1) === 0) ly1--;
    let ly0 = ly1; while (ly0 > top && rowInk(lum, W, first.x0, first.x1, ly0) > 0) ly0--;
    if (ly1 - ly0 >= 4) {
      // Horizontal extent from strong ink only (tab fill or lettering), ignoring rules.
      let lx0 = first.x1, lx1 = first.x0;
      for (let y = ly0; y <= ly1; y++) {
        if (rowInk(lum, W, first.x0, first.x1, y) > (first.x1 - first.x0) * 0.8) continue;
        for (let x = first.x0; x < first.x1; x++) if (lum[y * W + x] < 130) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; }
      }
      if (lx1 > lx0) t.labelRect = { x0: Math.max(0, lx0 - 4), y0: Math.max(0, ly0 - 2), x1: Math.min(W, lx1 + 5), y1: Math.min(H, ly1 + 3) };
    }
  }
  tables.sort((a, b) => a.rows[0].headerRect.y0 - b.rows[0].headerRect.y0 || a.rows[0].headerRect.x0 - b.rows[0].headerRect.x0);
  return tables;
}

/** Cells of one header segment plus the answer row beneath it; null when it is not an answer-key row. */
function readRow(lum, W, H, band, x0, x1, colDark, bands, isDark) {
  const h = band.y1 - band.y0;
  const seps = [];
  for (let x = x0; x <= x1; x++) if (colDark[x] >= h * 0.7) { if (seps.length && x - seps.at(-1).x1 <= 2) seps.at(-1).x1 = x; else seps.push({ x0: x, x1: x }); }
  let edges = [x0, ...seps.map(s => (s.x0 + s.x1) / 2), x1 + 1];
  edges = edges.filter((e, i) => !i || e - edges[i - 1] > h * 0.6);
  if (edges.length < 4) edges = splitByGlyphs(colDark, x0, x1, h);
  const cells = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const cx0 = Math.round(edges[i]), cx1 = Math.round(edges[i + 1]);
    if (cx1 - cx0 < h * 0.6) continue;
    let ink = 0; for (let x = cx0 + 2; x < cx1 - 2; x++) ink += colDark[x] > 0 && colDark[x] < h * 0.7 ? 1 : 0;
    if (ink) cells.push({ x0: cx0, x1: cx1 });
  }
  if (cells.length < 2) return null;
  // Answer row: below the band until the next rule line (measured inside this segment only).
  const ruleAt = y => { let d = 0; for (let x = x0, p = y * W + x0; x <= x1; x++, p++) if (lum[p] < 190) d++; return d > (x1 - x0) * 0.5; };
  let ay0 = band.y1; while (ay0 < H && ruleAt(ay0)) ay0++;
  const nextBand = bands.find(b => b.y0 >= band.y1);
  const limit = Math.min(H, nextBand ? nextBand.y0 : H, band.y1 + h * 3);
  let ay1 = ay0; while (ay1 < limit && !ruleAt(ay1)) ay1++;
  if (ay1 - ay0 < h * 0.4) return null;
  const row = { headerRect: { x0, y0: band.y0, x1: x1 + 1, y1: band.y1 }, answerY0: ay0, answerY1: ay1, cells: [] };
  for (const c of cells) row.cells.push({ numberRect: { x0: c.x0, y0: band.y0, x1: c.x1, y1: band.y1 }, answerRect: { x0: c.x0, y0: ay0, x1: c.x1, y1: ay1 }, glyphRect: glyphBox(lum, W, c.x0 + 2, c.x1 - 2, ay0 + 1, ay1 - 1) });
  // A real key row holds circled numerals: near-square glyphs of uniform size in most cells.
  const glyphs = row.cells.map(c => c.glyphRect).filter(Boolean);
  const square = glyphs.filter(g => { const a = (g.x1 - g.x0) / (g.y1 - g.y0); return a > 0.75 && a < 1.33; });
  const sizes = square.map(g => g.y1 - g.y0).sort((a, b) => a - b), med = sizes[sizes.length >> 1] || 0;
  const uniform = square.filter(g => Math.abs((g.y1 - g.y0) - med) <= med * 0.2).length;
  if (glyphs.length < row.cells.length * 0.6 || uniform < Math.max(2, glyphs.length * 0.7) || med > h * 1.6) return null;
  // Answers are circled numerals: most glyphs must show a round outline.
  const ringed = glyphs.filter(g => ringScore(lum, W, g) >= 0.6).length;
  if (ringed < glyphs.length * 0.7) return null;
  return row;
}

/** Fraction of directions (out of 48) in which a dark pixel lies near the glyph's outer circle. */
export function ringScore(lum, W, g) {
  const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2, r = Math.min(g.x1 - g.x0, g.y1 - g.y0) / 2;
  let hit = 0;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2; let found = false;
    for (let d = r * 0.72; d <= r * 1.02 && !found; d += 0.5) {
      const x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d);
      if (x >= g.x0 - 1 && x <= g.x1 && y >= g.y0 - 1 && y <= g.y1 && lum[y * W + x] < 190) found = true;
    }
    if (found) hit++;
  }
  return hit / 48;
}

function rowInk(lum, W, x0, x1, y) { let n = 0; for (let x = x0, p = y * W + x0; x < x1; x++, p++) if (lum[p] < 200) n++; return n; }

function splitByGlyphs(colDark, x0, x1, h) {
  const groups = []; let s = -1, gap = 0;
  for (let x = x0; x <= x1 + 1; x++) {
    const ink = x <= x1 && colDark[x] > 0;
    if (ink) { if (s < 0) s = x; gap = 0; } else if (s >= 0 && ++gap > h * 0.35) { groups.push([s, x - gap]); s = -1; gap = 0; }
  }
  if (groups.length < 2) return [x0, x1 + 1];
  const edges = [x0];
  for (let i = 1; i < groups.length; i++) edges.push((groups[i - 1][1] + groups[i][0]) / 2);
  edges.push(x1 + 1);
  return edges;
}

/** Bounding box of the glyph in a cell: dark components that do not touch the cell border (rules do). */
function glyphBox(lum, W, x0, x1, y0, y1) {
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const on = new Uint8Array(w * h), seen = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) on[y * w + x] = lum[(y0 + y) * W + x0 + x] < 175 ? 1 : 0;
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  const stack = [];
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || seen[s]) continue;
    let cx0 = w, cy0 = h, cx1 = -1, cy1 = -1, n = 0, touches = false;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const j = stack.pop(), x = j % w, y = (j / w) | 0; n++;
      if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= on.length || seen[k] || !on[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    if (touches || n < 3) continue;
    if (cx0 < bx0) bx0 = cx0; if (cx1 > bx1) bx1 = cx1; if (cy0 < by0) by0 = cy0; if (cy1 > by1) by1 = cy1;
  }
  if (bx1 < 0 || bx1 - bx0 < 3 || by1 - by0 < 3) return null;
  return { x0: x0 + bx0, y0: y0 + by0, x1: x0 + bx1 + 1, y1: y0 + by1 + 1 };
}

/** Binarized inner digit of a circled numeral (ring removed), resampled to n×n. */
export function glyphGrid(rgba, W, rect, n = 24) {
  const inner = innerDigitMask(rgba, W, rect);
  let a = inner.width, b = inner.height, e = -1, f = -1;
  for (let y = 0; y < inner.height; y++) for (let x = 0; x < inner.width; x++) if (inner.data[(y * inner.width + x) * 4] < 160) { if (x < a) a = x; if (x > e) e = x; if (y < b) b = y; if (y > f) f = y; }
  if (e < 0) return null;
  return binarizeTo(inner.data, inner.width, { x0: a, y0: b, x1: e + 1, y1: f + 1 }, n, otsu(inner.data, inner.width, { x0: a, y0: b, x1: e + 1, y1: f + 1 }));
}

/** Otsu threshold of the luminance inside rect (blurred scans need a per-glyph cut-off). */
function otsu(rgba, W, r) {
  const hist = new Uint32Array(256); let n = 0;
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) { hist[Math.round(lumOf(rgba, (y * W + x) * 4))]++; n++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 160;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sumB += i * hist[i]; const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return Math.min(200, Math.max(90, t + 1));
}

/**
 * Read answer keys from one or more images (screenshots or rendered pages).
 * images: [{rgba, width, height}]
 * options.templates: [{value:1..5, grid}] rendered digit templates (see glyphGrid size)
 * options.readNumber(imageIndex, rect) -> digits string|null
 * options.readLabel(imageIndex, rect)  -> text|null
 * Returns [{image, section, labelText, entries:[{number, answer, confidence, image, rect}]}]
 */
export async function readAnswerKeys(images, { templates = [], readNumber, readLabel, onProgress = () => {} } = {}) {
  const tables = [], glyphs = [], refs = [];
  for (let ii = 0; ii < images.length; ii++) {
    const { rgba, width: W, height: H } = images[ii];
    for (const t of findAnswerTables(rgba, W, H)) {
      let labelText = '', section = null;
      if (t.labelRect && readLabel) {
        // readLabel may try several renderings; stop at the first that names a section.
        for (let attempt = 0; attempt < 4 && !section; attempt++) {
          const text = await readLabel(ii, t.labelRect, attempt);
          if (text == null) break;
          if (!labelText) labelText = text;
          section = detectSection([{ text, bbox: { y0: 0 }, furniture: true }], H);
          if (section) labelText = text;
        }
      }
      const table = { image: ii, section, labelText, entries: [] };
      let expected = 1;
      for (const row of t.rows) {
        const nums = [];
        for (let ci = 0; ci < row.cells.length; ci++) {
          // Reading three cells is enough to anchor a consecutive run.
          const txt = readNumber && (ci < 2 || ci === row.cells.length - 1) ? await readNumber(ii, row.cells[ci].numberRect) : null;
          const m = txt && String(txt).match(/\d{1,3}/);
          nums.push(m ? Number(m[0]) : null);
        }
        fixRun(nums, expected);
        row.cells.forEach((cell, ci) => {
          const entry = { number: nums[ci], answer: null, confidence: 0, image: ii, rect: cell.answerRect };
          const grid = cell.glyphRect ? glyphGrid(rgba, W, cell.glyphRect) : null;
          if (grid) { glyphs.push({ grid }); refs.push(entry); }
          table.entries.push(entry);
        });
        expected = nums.at(-1) + 1;
      }
      tables.push(table);
      onProgress(ii + 1, images.length);
    }
  }
  // One unnamed table among otherwise distinct sections: it must be the remaining one.
  const named = new Set(tables.map(t => t.section).filter(Boolean)), unnamed = tables.filter(t => !t.section);
  const remaining = ['language', 'data', 'math', 'logic', 'sequence'].filter(s => !named.has(s));
  if (unnamed.length === 1 && remaining.length === 1 && named.size === tables.length - 1) { unnamed[0].section = remaining[0]; unnamed[0].inferred = true; }
  if (glyphs.length && templates.length) classifyGlyphs(glyphs, templates).forEach((r, i) => { refs[i].answer = r.value; refs[i].confidence = r.confidence; });
  return tables;
}

/** Question numbers in a row are consecutive; repair unread or misread ones. */
export function fixRun(nums, expected = 1) {
  // Find the offset most numbers agree with (value - index).
  const votes = new Map();
  nums.forEach((n, i) => { if (n != null) votes.set(n - i, (votes.get(n - i) || 0) + 1); });
  let best = expected, bestVotes = 0;
  for (const [k, v] of votes) if (v > bestVotes || (v === bestVotes && k === expected)) { best = k; bestVotes = v; }
  // Within one table numbering only moves forward: a lower start means OCR dropped a digit ("11" read as "1").
  if (best < expected) best = expected;
  for (let i = 0; i < nums.length; i++) nums[i] = best + i;
  return nums;
}

/** Keep only pixels near the centre of a circled numeral so the ring does not confuse digit reading. */
export function innerDigitMask(rgba, W, rect, keep = 0.64) {
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  const r = Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0) / 2;
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = rect.x0 + x, sy = rect.y0 + y, i = (sy * W + sx) * 4, o = (y * w + x) * 4;
    const inside = Math.hypot(sx + 0.5 - cx, sy + 0.5 - cy) <= r * keep;
    const v = inside ? lumOf(rgba, i) : 255;
    out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/**
 * Classify circled numerals by shape.
 * glyphs: [{grid}] binarized inner digits (n×n); fontTemplates: [{value, grid}].
 * Pass 1 compares with rendered font templates; pass 2 builds prototypes from this
 * book's own confidently-classified glyphs (same typeface throughout) and re-scores.
 * Returns [{value, confidence}] (confidence = margin between best and runner-up digit).
 */
export function classifyGlyphs(glyphs, fontTemplates, { minMargin = 0.04 } = {}) {
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { const x = a[k] > 0.5, y = b[k] > 0.5; if (x && y) i++; if (x || y) u++; } return u ? i / u : 0; };
  const corr = (a, proto) => { let dot = 0, na = 0, nb = 0; for (let k = 0; k < a.length; k++) { const x = a[k] - 0.5, y = proto[k] - 0.5; dot += x * y; na += x * x; nb += y * y; } return na && nb ? dot / Math.sqrt(na * nb) : 0; };
  const byDigit = (scores) => { const best = {}; for (const { value, s } of scores) best[value] = Math.max(best[value] ?? -1, s); const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]); return { value: Number(ranked[0][0]), score: ranked[0][1], margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) }; };
  const pass1 = glyphs.map(g => byDigit(fontTemplates.map(t => ({ value: t.value, s: iou(g.grid.data, t.grid.data) }))));
  // Prototypes from confident pass-1 results.
  const protos = {};
  glyphs.forEach((g, i) => { if (pass1[i].margin < minMargin) return; const v = pass1[i].value; const p = protos[v] ??= { sum: new Float32Array(g.grid.data.length), n: 0 }; for (let k = 0; k < g.grid.data.length; k++) p.sum[k] += g.grid.data[k]; p.n++; });
  const protoList = Object.entries(protos).filter(([, p]) => p.n >= 2).map(([v, p]) => ({ value: Number(v), data: p.sum.map(x => x / p.n) }));
  return glyphs.map((g, i) => {
    if (protoList.length < 3) return { value: pass1[i].value, confidence: pass1[i].margin };
    // Combine font evidence and book-specific prototypes.
    const scores = [];
    for (let v = 1; v <= 5; v++) {
      const f = Math.max(-1, ...fontTemplates.filter(t => t.value === v).map(t => iou(g.grid.data, t.grid.data)));
      const p = protoList.find(p => p.value === v);
      scores.push({ value: v, s: p ? 0.4 * f + 0.6 * corr(g.grid.data, p.data) : 0.4 * f });
    }
    const r = byDigit(scores);
    return { value: r.value, confidence: r.margin };
  });
}

/** Compare a binarized glyph with rendered templates (both {data:Uint8Array 0/1, w, h}); returns best index and score. */
export function matchTemplates(glyph, templates) {
  let best = -1, bestScore = -1, second = -1;
  templates.forEach((t, k) => {
    let inter = 0, uni = 0;
    for (let i = 0; i < glyph.data.length; i++) { const a = glyph.data[i], b = t.data[i]; if (a && b) inter++; if (a || b) uni++; }
    const s = uni ? inter / uni : 0;
    if (s > bestScore) { second = bestScore; bestScore = s; best = k; } else if (s > second) second = s;
  });
  return { index: best, score: bestScore, margin: bestScore - Math.max(0, second) };
}

/** Resample the dark pixels of rect to an n×n binary grid (aspect preserved, centred). */
export function binarizeTo(rgba, W, rect, n = 32, threshold = 160) {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0, s = Math.max(w, h);
  const ox = (s - w) / 2, oy = (s - h) / 2, data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = Math.floor(rect.x0 - ox + (x + 0.5) * s / n), sy = Math.floor(rect.y0 - oy + (y + 0.5) * s / n);
    if (sx < rect.x0 || sy < rect.y0 || sx >= rect.x1 || sy >= rect.y1) continue;
    data[y * n + x] = lumOf(rgba, (sy * W + sx) * 4) < threshold ? 1 : 0;
  }
  return { data, w: n, h: n };
}

/** Render digit templates 1~5 in several typefaces. makeCanvas(w,h) returns a 2D canvas. */
export function renderDigitTemplates(makeCanvas, fonts, n = 24) {
  const out = [];
  for (const font of fonts) for (let v = 1; v <= 5; v++) {
    const size = 200, c = makeCanvas(size, size), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000';
    g.font = `120px ${font}`; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(String(v), size / 2, size / 2);
    const d = g.getImageData(0, 0, size, size).data;
    let x0 = size, y0 = size, x1 = -1, y1 = -1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (d[(y * size + x) * 4] < 160) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 > x0) out.push({ value: v, font, grid: binarizeTo(d, size, { x0, y0, x1: x1 + 1, y1: y1 + 1 }, n) });
  }
  return out;
}
export const TEMPLATE_FONTS = ['"Malgun Gothic"', '"Apple SD Gothic Neo"', '"Noto Sans KR"', '"Noto Sans CJK KR"', '"Noto Sans CJK JP"', 'Arial', '"Liberation Sans"', '"DejaVu Sans"', 'sans-serif'];

/**
 * Prepare a label crop for OCR: lettering becomes black on white whether the label is
 * dark-on-light text or light lettering on a filled tab. Returns new RGBA.
 */
export function labelPixels(rgba, w, h, { stripEdges = true } = {}) {
  const out = new Uint8ClampedArray(rgba.length);
  let sum = 0; const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) { lum[p] = lumOf(rgba, i); sum += lum[p]; }
  const filled = sum / lum.length < 150;
  const ink = new Uint8Array(w * h);
  for (let p = 0; p < lum.length; p++) ink[p] = (filled ? lum[p] > 195 : lum[p] < 120) ? 1 : 0;
  // Remove anything touching the crop edge (tab outline, neighbouring rules).
  const stack = [];
  if (!stripEdges) stack.length = 0;
  if (stripEdges) { for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x); for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const j = stack.pop(); if (j < 0 || j >= ink.length || !ink[j]) continue; ink[j] = 0;
    const x = j % w; stack.push(j - w, j + w); if (x > 0) stack.push(j - 1); if (x < w - 1) stack.push(j + 1);
  }
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) { out[i] = out[i + 1] = out[i + 2] = ink[p] ? 0 : 255; out[i + 3] = 255; }
  return out;
}
