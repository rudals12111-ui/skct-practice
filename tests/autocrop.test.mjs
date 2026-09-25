import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planPage, inkMaskFromRGBA, parseNumberToken, detectSection, repairSequence, prepareOcrPixels} from '../dist/autocrop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const userDir = path.join(here, 'fixtures', 'user');
const hasUserFixture = await fs.access(path.join(userDir, 'book-sample.pdf')).then(() => true, () => false);

test('question-number tokens: accepts book styles, rejects choices and years', () => {
  for (const [t, n] of [['13.', 13], ['08.', 8], ['08,', 8], ['05', 5], ['Q3.', 3], ['12번', 12], ['O7.', 7]]) assert.equal(parseNumberToken(t), n, t);
  for (const t of ['0)', '(8)', '®', '@', '2025', '①', '1)', 'Part']) assert.equal(parseNumberToken(t), null, t);
});

test('section labels survive small OCR errors but do not cross-match', () => {
  const L = t => [{text: t, bbox: {y0: 50}, furniture: true}];
  assert.equal(detectSection(L('얻어이애'), 2000), 'language');
  assert.equal(detectSection(L('자료헤석'), 2000), 'data');
  assert.equal(detectSection(L('언어추리'), 2000), 'logic');
  assert.equal(detectSection(L('기출복원 모의고사'), 2000), null);
});

test('sequence repair fills unreadable numbers and flags gaps', () => {
  const items = [{n: null}, {n: 5}, {n: null}, {n: 9}];
  const warnings = [];
  repairSequence(items, null, warnings);
  assert.deepEqual(items.map(i => i.n), [4, 5, 6, 9]);
  assert(warnings.some(w => w.includes('6번 다음 9번')));
  const misread = [{n: 11}, {n: 17}, {n: 13}];
  repairSequence(misread);
  assert.deepEqual(misread.map(i => i.n), [11, 12, 13]);
});

test('filled title blocks are inverted for OCR and reported as blocks', () => {
  const W = 120, H = 60, rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 12; y < 48; y++) for (let x = 24; x < 96; x++) { const i = (y * W + x) * 4; rgba[i] = 30; rgba[i + 1] = 60; rgba[i + 2] = 160; }
  const out = prepareOcrPixels(rgba, W, H, 6);
  assert(out[(30 * W + 60) * 4] > 150, 'block interior becomes light');
  assert(out[(2 * W + 2) * 4] > 200, 'paper stays light');
  assert.equal(out.blocks.length, 1);
});

// Synthetic two-column page with a shared passage marker and a figure wider than the text.
function syntheticPage() {
  const W = 1000, H = 1400, data = new Uint8Array(W * H);
  const ink = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[y * W + x] = 1; };
  const lines = [];
  const line = (text, x0, y0, x1, h = 20, words) => { ink(x0, y0 + 4, x1, y0 + h - 4); lines.push({text, bbox: {x0, y0, x1, y1: y0 + h}, words: words || [{text: text.split(' ')[0], bbox: {x0, y0, x1: x0 + 30, y1: y0 + h}}]}); };
  // left column
  line('[01~02] 다음 자료를 보고 물음에 답하시오.', 60, 100, 460);
  ink(60, 140, 470, 300); // table without OCR text
  line('01. 다음 중 옳은 것은?', 60, 330, 440, 20, [{text: '01.', bbox: {x0: 60, y0: 330, x1: 90, y1: 350}}]);
  line('① 가 ② 나 ③ 다', 110, 370, 400);
  ink(60, 600, 90, 620); // number the OCR missed
  line('다음 설명 중 알맞은 것은?', 110, 600, 440);
  line('① 가 ② 나', 110, 640, 380);
  // right column
  line('03. 빈칸에 들어갈 수는?', 540, 100, 930, 20, [{text: '03.', bbox: {x0: 540, y0: 100, x1: 570, y1: 120}}]);
  line('① 1 ② 2', 590, 140, 800);
  line('04. 다음 수열의 규칙은?', 540, 500, 930, 20, [{text: '04.', bbox: {x0: 540, y0: 500, x1: 570, y1: 520}}]);
  line('① 3 ② 4', 590, 540, 800);
  // footer + side tab
  line('Part 02 모의고사 33', 700, 1330, 950);
  ink(960, 200, 1000, 400);
  lines.push({text: '02', bbox: {x0: 965, y0: 220, x1: 995, y1: 260}, words: [{text: '02', bbox: {x0: 965, y0: 220, x1: 995, y1: 260}}], furniture: true});
  return {ocr: {width: W, height: H, lines}, mask: {width: W, height: H, data}};
}

test('two-column page: reading order, missed number recovered, shared passage, furniture excluded', async () => {
  const {ocr, mask} = syntheticPage();
  const plan = await planPage(ocr, mask, {columns: 'auto', verify: async () => '02.'});
  assert.deepEqual(plan.questions.map(q => q.label), [1, 2, 3, 4]);
  assert.deepEqual(plan.questions.map(q => q.column), [0, 0, 1, 1]);
  assert.equal(plan.shared.length, 1);
  assert.deepEqual([plan.shared[0].from, plan.shared[0].to], [1, 2]);
  const [q1, q2, q3] = plan.questions;
  assert(plan.shared[0].rect.y + plan.shared[0].rect.h <= q1.rect.y + 0.001, 'shared passage ends before question 1');
  assert(q1.rect.y + q1.rect.h <= q2.rect.y + 0.001, 'question 1 stops at question 2');
  assert(q1.rect.x + q1.rect.w < q3.rect.x, 'left column does not bleed into right column');
  for (const q of plan.questions) {
    assert(q.rect.y + q.rect.h < 1330 / 1400, 'footer excluded');
    assert(q.rect.x + q.rect.w < 0.96, 'side tab excluded');
  }
});

test('forced single column ignores the right-hand numbers', async () => {
  const {ocr, mask} = syntheticPage();
  const plan = await planPage(ocr, mask, {columns: 1, verify: async () => null});
  assert.deepEqual(plan.questions.map(q => q.label), [1, 2]);
});

test('no numbers found returns a clear warning instead of guesses', async () => {
  const plan = await planPage({width: 100, height: 100, lines: []}, {width: 100, height: 100, data: new Uint8Array(10000)});
  assert.equal(plan.questions.length, 0);
  assert.match(plan.warnings[0], /번호를 찾지/);
});

test('user book pages (recorded OCR): numbers, section, tight crops without page furniture', {skip: !hasUserFixture && 'tests/fixtures/user not present'}, async () => {
  const {renderPdfPages} = await import('../tools/ocr-node.mjs');
  const pages = await renderPdfPages(path.join(userDir, 'book-sample.pdf'), 1, 4);
  const expected = {1: [13], 2: [8], 3: [1], 4: [4, 5, 6, 7]};
  for (const {n, canvas} of pages) {
    const ocr = JSON.parse(await fs.readFile(path.join(userDir, `p${n}.ocr.json`), 'utf8'));
    const ctx = canvas.getContext('2d');
    const mask = inkMaskFromRGBA(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    // No digit re-read: pixel-only numbers must still be recovered from the stem beside them.
    const plan = await planPage(ocr, mask, {verify: null});
    assert.deepEqual(plan.questions.map(q => q.label), expected[n], `page ${n}`);
    for (const q of plan.questions) {
      assert(q.rect.y + q.rect.h <= plan.footerTop + 0.01, `p${n} q${q.label} excludes footer`);
      assert(q.rect.x + q.rect.w < 0.9, `p${n} q${q.label} excludes side tab`);
      assert(q.rect.h > 0.05 && q.rect.w > 0.6, `p${n} q${q.label} is a full question`);
      assert.equal(q.masks.length, 1, `p${n} q${q.label} hides the keyword tag`);
    }
    if (n === 3) { assert.equal(plan.section, 'language'); assert(plan.questions[0].rect.y > 0.25, 'title block excluded'); }
    if (n === 4) for (let i = 1; i < 4; i++) assert(plan.questions[i - 1].rect.y + plan.questions[i - 1].rect.h <= plan.questions[i].rect.y + 0.002);
  }
});

test('sequence and choice lines aligned with the numbers are not mistaken for questions', async () => {
  const W = 600, H = 800, data = new Uint8Array(W * H), lines = [];
  const add = (text, x0, y0, x1) => { for (let y = y0 + 4; y < y0 + 16; y++) for (let x = x0; x < x1; x++) data[y * W + x] = 1; lines.push({text, bbox: {x0, y0, x1, y1: y0 + 20}, words: [{text: text.split(' ')[0], bbox: {x0, y0, x1: x0 + 24, y1: y0 + 20}}]}); };
  add('01. 다음 수열의 빈칸에 들어갈 수를 고르시오.', 40, 60, 500); add('2, 4, 8, 16, ( ? )', 40, 100, 300); add('3. 20 ② 24 ③ 28', 40, 140, 400);
  add('02. 다음 수열의 빈칸에 들어갈 수를 고르시오.', 40, 400, 500); add('3, 6, 12, 24', 40, 440, 300);
  const plan = await planPage({width: W, height: H, lines}, {width: W, height: H, data});
  assert.deepEqual(plan.questions.map(q => q.label), [1, 2]);
});

test('single-question page still found when OCR drops or garbles the only number', {skip: !hasUserFixture && 'tests/fixtures/user not present'}, async () => {
  const {renderPdfPages} = await import('../tools/ocr-node.mjs');
  const [{canvas}] = await renderPdfPages(path.join(userDir, 'book-sample.pdf'), 3, 3);
  const mask = inkMaskFromRGBA(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  const ocr = JSON.parse(await fs.readFile(path.join(userDir, 'p3.ocr.json'), 'utf8'));
  const base = await planPage(ocr, mask, {verify: null});
  const numberLine = ocr.lines.find(l => /^01\./.test(l.text));
  const stemLine = ocr.lines.find(l => l.text.startsWith('다음 글을 읽고'));
  const variants = {
    missing: ocr.lines.filter(l => l !== numberLine),
    garbled: ocr.lines.map(l => l === numberLine ? {...l, text: '이.', words: [{...l.words[0], text: '이.'}]} : l),
  };
  for (const [name, lines] of Object.entries(variants)) {
    const plan = await planPage({...ocr, lines}, mask, {verify: async () => '01.'});
    assert.deepEqual(plan.questions.map(q => q.label), [1], name);
    assert(Math.abs(plan.questions[0].rect.y - base.questions[0].rect.y) < 0.01, `${name}: same top edge`);
    assert(plan.warnings.some(w => w.includes('발문 위치')), `${name}: warns`);
  }
  // Digits unreadable too: the question is still cropped, just without a number.
  const plan = await planPage({...ocr, lines: variants.missing}, mask, {verify: async () => null});
  assert.equal(plan.questions.length, 1);
  assert(stemLine);
});

test('filled-box OCR lines are mapped back from the padded, enlarged crop', async () => {
  const {mapBlockLines, BLOCK_OCR, blockCropSize, detectSection} = await import('../dist/autocrop.js');
  const b = {x0: 1044, y0: 132, x1: 1200, y1: 168};
  const {pad, scale} = BLOCK_OCR;
  assert.deepEqual(blockCropSize(b), {w: 156 * scale + 2 * pad, h: 36 * scale + 2 * pad});
  const [line] = mapBlockLines([{text: '수열추리', bbox: {x0: pad + 40, y0: pad + 14, x1: pad + 248, y1: pad + 72}, words: []}], b);
  assert.deepEqual(line.bbox, {x0: 1064, y0: 139, x1: 1168, y1: 168});
  assert.equal(line.furniture, true);
  assert.equal(detectSection([line], 1942), 'sequence');
});
