import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {findAnswerTables, fixRun, classifyGlyphs} from '../dist/answerkey.js';
import {applyAnswerKey} from '../dist/core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyDir = path.join(here, 'fixtures', 'keys');
const hasKeys = await fs.access(path.join(keyDir, 'key1.png')).then(() => true, () => false);
// Verified by eye against the screenshots (창의수리 07 is ⑤).
const TRUTH = {
  language: '13253432534441421534', data: '23245331341255542125', math: '35425153421523443153',
  logic: '12345454121425132334', sequence: '54234134253521324514',
};

test('question-number runs are consecutive even when OCR misreads some cells', () => {
  assert.deepEqual(fixRun([1, null, 3, 8, 5], 1), [1, 2, 3, 4, 5]);
  assert.deepEqual(fixRun([null, 12, 13, null], 11), [11, 12, 13, 14]);
  assert.deepEqual(fixRun([null, null], 21), [21, 22]);
  assert.deepEqual(fixRun([1, 2, 3], 11), [11, 12, 13], 'second row cannot restart at 1');
});

test('answer keys map by recognised numbers, or by order when numbers are unreliable', () => {
  const qs = [
    ...[1, 2, 3].map(n => ({id: 'a' + n, section: 'math', number: n})),
    // Same shape as the user's 언어추리: slots 3 and 4 carry wrong numbers (duplicates).
    ...[1, 2, 2, 12].map((n, i) => ({id: 'b' + i, section: 'logic', number: n})),
  ];
  const report = applyAnswerKey(qs, {math: [5, 4, 3], logic: [1, 2, 3, 4], data: [1]});
  assert.deepEqual(qs.filter(q => q.section === 'math').map(q => q.key), [5, 4, 3]);
  assert.deepEqual(qs.filter(q => q.section === 'logic').map(q => q.key), [1, 2, 3, 4]);
  assert.equal(report.find(r => r.section === 'logic').mode, 'order');
  assert.equal(report.find(r => r.section === 'math').mode, 'number');
  assert.equal(report.find(r => r.section === 'data').applied, 0);
  // Numbers out of order but unique still map by number.
  const shuffled = [3, 1, 2].map(n => ({id: 'c' + n, section: 'data', number: n}));
  applyAnswerKey(shuffled, {data: [1, 2, 3]});
  assert.deepEqual(shuffled.map(q => q.key), [3, 1, 2]);
});

test('shape classifier falls back to font templates when there are too few samples', () => {
  const grid = v => ({data: Uint8Array.from({length: 16}, (_, i) => (i % 5 === v % 5 ? 1 : 0)), w: 4, h: 4});
  const templates = [1, 2, 3, 4, 5].map(v => ({value: v, grid: grid(v)}));
  const res = classifyGlyphs([{grid: grid(3)}, {grid: grid(5)}], templates);
  assert.deepEqual(res.map(r => r.value), [3, 5]);
});

function syntheticDataTable() {
  // A shaded header row followed by plain numbers ("1,200"): a data table, not an answer key.
  const W = 800, H = 200, rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  const fill = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = v[0]; rgba[i + 2] = v[1]; } };
  fill(40, 40, 760, 70, [198, 227]);
  for (let c = 0; c < 6; c++) { const x = 40 + c * 120; fill(x, 40, x + 2, 110, [60, 90]); fill(x + 40, 50, x + 70, 60, [40, 60]); fill(x + 20, 85, x + 95, 97, [30, 40]); }
  fill(40, 110, 760, 112, [60, 90]);
  return {rgba, W, H};
}

test('tables without circled numerals (data tables inside questions) are ignored', () => {
  const {rgba, W, H} = syntheticDataTable();
  assert.deepEqual(findAnswerTables(rgba, W, H), []);
});

test('user answer-key screenshots: grid, section names, numbers and all 100 answers', {skip: !hasKeys && 'tests/fixtures/keys not present'}, async () => {
  const {readKeyFiles} = await import('../tools/ocr-node.mjs');
  const files = [1, 2, 3, 4, 5].map(i => path.join(keyDir, `key${i}.png`));
  const tables = await readKeyFiles(files);
  assert.equal(tables.length, 5);
  for (const t of tables) {
    assert(t.section, `section read for image ${t.image + 1}`);
    assert.deepEqual(t.entries.map(e => e.number), Array.from({length: 20}, (_, i) => i + 1));
    assert.equal(t.entries.map(e => e.answer).join(''), TRUTH[t.section], t.section);
  }
  assert.deepEqual(tables.map(t => t.section).sort(), Object.keys(TRUTH).sort());
  // A single screenshot on its own (no cross-image prototypes) is still read correctly.
  const [one] = await readKeyFiles([files[2]]);
  assert.equal(one.section, 'math');
  assert.equal(one.entries.map(e => e.answer).join(''), TRUTH.math);
});

test('answer pages of a PDF: several tables per page, two exam sets across pages', {skip: !hasKeys && 'tests/fixtures/keys not present'}, async () => {
  const {readKeyFiles} = await import('../tools/ocr-node.mjs');
  const {createCanvas} = await import('@napi-rs/canvas');
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({data: new Uint8Array(await fs.readFile(path.join(keyDir, 'answers.pdf'))), verbosity: 0}).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    // Same resolution rule as builder.js renderToCanvas().
    const page = await doc.getPage(n), base = page.getViewport({scale: 1});
    const v = page.getViewport({scale: Math.min(4, 2600 / base.width, 3600 / base.height)});
    const c = createCanvas(Math.ceil(v.width), Math.ceil(v.height)), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({canvasContext: g, viewport: v, canvas: c}).promise;
    pages.push(c);
  }
  await doc.destroy();
  const tables = await readKeyFiles(pages);
  assert.equal(tables.length, 10);
  for (const t of tables) assert.equal(t.entries.map(e => e.answer).join(''), TRUTH[t.section], `page ${t.image + 1} ${t.section}`);
  assert.deepEqual(tables.slice(0, 5).map(t => t.section), ['language', 'data', 'math', 'logic', 'sequence']);
});

test('real solution pages: only the answer key is read, not the other shaded tables beside it', {skip: !hasKeys && 'tests/fixtures/keys not present'}, async () => {
  const {readKeyFiles} = await import('../tools/ocr-node.mjs');
  // page-seq: key + explanations; page-logic: key + a truth table (T/F) and seating tables in the other column.
  const tables = await readKeyFiles([path.join(keyDir, 'page-seq.png'), path.join(keyDir, 'page-logic.png')]);
  assert.deepEqual(tables.map(t => t.section), ['sequence', 'logic']);
  for (const t of tables) {
    assert.deepEqual(t.entries.map(e => e.number), Array.from({length: 20}, (_, i) => i + 1));
    assert.equal(t.entries.map(e => e.answer).join(''), TRUTH[t.section]);
  }
});
