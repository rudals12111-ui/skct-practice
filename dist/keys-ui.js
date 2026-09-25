// Answer-key dialog: paste / choose screenshots or use the open PDF page, recognise the
// "빠른 정답" tables, review and correct, then apply to the questions for automatic grading.
import {DEFAULT_SECTIONS,escapeHTML as esc} from './core.js';
const $=id=>document.getElementById(id);
const CIRCLED=['','①','②','③','④','⑤'];
const UNSURE=0.05;

export function initKeyDialog({toast,getPdfCanvas}){
 let images=[],keys={},sectionsFound=[],busy=false,getQuestions=()=>[],onApply=async()=>[];
 const dialog=document.createElement('dialog');dialog.id='keyDialog';dialog.className='wide-dialog';document.body.append(dialog);
 function markup(){
  dialog.innerHTML=`<div class="dialog-heading"><div><span class="eyebrow">ANSWER KEY</span><h2>정답표로 자동 채점</h2></div><button data-close-key aria-label="정답표 창 닫기">✕</button></div>
<div class="key-inputs"><button id="keyPasteHint" class="primary" title="정답표 스크린샷을 복사한 뒤 Ctrl+V">클립보드에서 붙여넣기 (Ctrl+V)</button><label class="file-label" for="keyFiles">이미지 파일 선택</label><input type="file" id="keyFiles" accept="image/*" multiple aria-label="정답표 이미지 선택"><button id="keyPdfPage" ${getPdfCanvas()?'':'hidden'}>PDF 문제집의 현재 쪽 사용</button><button id="keyClear" class="text-btn">이미지 비우기</button></div>
<div id="keyThumbs" class="key-thumbs"><p class="muted">영역명과 번호가 보이도록 정답표를 캡처해 넣으세요. 여러 장을 한 번에 넣으면 인식이 더 정확해집니다.</p></div>
<div class="dialog-actions" style="margin-top:10px;justify-content:flex-start"><button id="keyRead" class="primary" disabled>정답표 인식</button><span id="keyStatus" class="muted" role="status"></span></div>
<h3 style="font-size:16px;margin:18px 0 6px">영역별 정답 <small class="muted">숫자 20자리로 직접 입력·수정할 수 있습니다. 노란 칸은 인식이 불확실한 문항입니다.</small></h3>
<div id="keyTable"></div>
<div class="dialog-actions"><button data-close-key>닫기</button><button id="keyApply" class="primary">문항에 적용하고 채점</button></div>`;
  dialog.querySelectorAll('[data-close-key]').forEach(b=>b.onclick=()=>dialog.close());
  $('keyFiles').onchange=async e=>{for(const f of e.target.files)await addBlob(f);e.target.value='';};
  $('keyPasteHint').onclick=async()=>{try{const items=await navigator.clipboard.read();let n=0;for(const it of items)for(const t of it.types)if(t.startsWith('image/')){await addBlob(await it.getType(t));n++;}if(!n)toast('클립보드에 이미지가 없습니다. 정답표를 캡처(Win+Shift+S)한 뒤 다시 누르거나 Ctrl+V를 누르세요.');}catch{toast('이 창에서 Ctrl+V를 눌러 붙여넣으세요.');}};
  $('keyPdfPage').onclick=()=>{const c=getPdfCanvas();if(!c)return toast('PDF 문제집에서 정답표 쪽을 먼저 여세요.');const copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;copy.getContext('2d').drawImage(c,0,0);images.push({canvas:copy,name:'PDF 현재 쪽'});renderThumbs();};
  $('keyClear').onclick=()=>{images=[];renderThumbs();};
  $('keyRead').onclick=recognize;$('keyApply').onclick=apply;
  $('keyTable').oninput=e=>{const inp=e.target.closest('[data-key-text]');if(!inp)return;const s=inp.dataset.keyText;const digits=inp.value.replace(/[^1-5]/g,'').slice(0,40).split('').map(Number);keys[s]={values:digits,unsure:[]};drawRow(s);};
  renderThumbs();renderTable();
 }
 dialog.addEventListener('paste',async e=>{const files=[...(e.clipboardData?.files||[])].filter(f=>f.type.startsWith('image/'));if(!files.length)return;e.preventDefault();for(const f of files)await addBlob(f);});
 async function addBlob(blob){try{const bmp=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(bmp,0,0);bmp.close?.();images.push({canvas:c,name:blob.name||'붙여넣은 이미지'});renderThumbs();}catch{toast('이미지를 읽지 못했습니다.');}}
 function renderThumbs(){$('keyThumbs').innerHTML=images.length?images.map((im,i)=>`<figure><img src="${im.canvas.toDataURL('image/png')}" alt="정답표 ${i+1}"><figcaption>${esc(im.name)} <button data-remove="${i}" aria-label="이미지 ${i+1} 제거">✕</button></figcaption></figure>`).join(''):'<p class="muted">영역명과 번호가 보이도록 정답표를 캡처해 넣으세요. 여러 장을 한 번에 넣으면 인식이 더 정확해집니다.</p>';$('keyThumbs').querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{images.splice(Number(b.dataset.remove),1);renderThumbs();});$('keyRead').disabled=busy||!images.length;}
 function counts(){const c={};for(const q of getQuestions())c[q.section]=(c[q.section]||0)+1;return c;}
 function renderTable(){const c=counts();$('keyTable').innerHTML=DEFAULT_SECTIONS.map(s=>`<div class="key-row"><div class="key-row-head"><b>${esc(s.name)}</b><span class="muted">문항 ${c[s.id]||0}개${sectionsFound.find(f=>f.section===s.id)?.inferred?' · 영역명 추정':''}</span></div><input data-key-text="${s.id}" inputmode="numeric" aria-label="${esc(s.name)} 정답 숫자" placeholder="예) 13253432534441421534" value="${(keys[s.id]?.values||[]).map(v=>v||'?').join('')}"><div class="key-cells" id="keyCells-${s.id}"></div></div>`).join('');for(const s of DEFAULT_SECTIONS)drawRow(s.id);}
 function drawRow(id){const el=$('keyCells-'+id);if(!el)return;const k=keys[id];el.innerHTML=k?.values?.length?k.values.map((v,i)=>`<span class="key-cell ${k.unsure?.includes(i)?'unsure':''} ${v?'':'missing'}" title="${i+1}번"><small>${i+1}</small>${v?CIRCLED[v]:'?'}</span>`).join(''):'';}
 async function recognize(){
  if(busy||!images.length)return;busy=true;$('keyRead').disabled=true;$('keyStatus').textContent='OCR 준비 중…';
  try{
   const {readAnswerKeyCanvases}=await import('./ocr.js');
   const tables=await readAnswerKeyCanvases(images.map(i=>i.canvas),{onProgress:(stage,f)=>{$('keyStatus').textContent=stage==='load'?'OCR 엔진 준비 중…':`정답표 읽는 중… ${Math.round(f*100)}%`;}});
   if(!tables.length){$('keyStatus').textContent='정답표를 찾지 못했습니다. 번호 줄(음영)과 동그라미 정답이 함께 보이도록 캡처해 주세요.';return;}
   sectionsFound=tables;const unknown=[];
   for(const t of tables){
    const target=t.section||DEFAULT_SECTIONS.find(s=>!keys[s.id]&&!tables.some(x=>x.section===s.id))?.id;
    if(!t.section)unknown.push(t);
    if(!target)continue;
    const values=[],unsure=[];for(const e of t.entries){values[e.number-1]=e.answer||null;if(!e.answer||e.confidence<UNSURE)unsure.push(e.number-1);}
    keys[target]={values:Array.from({length:values.length},(_,i)=>values[i]||null),unsure};
   }
   renderTable();
   const total=tables.reduce((n,t)=>n+t.entries.length,0),unsure=Object.values(keys).reduce((n,k)=>n+(k.unsure?.length||0),0);
   $('keyStatus').textContent=`정답표 ${tables.length}개 · ${total}문항 인식${unsure?` · 확인 필요 ${unsure}칸(노란색)`:''}${unknown.length?` · 영역명을 못 읽은 표 ${unknown.length}개는 빈 영역에 넣었습니다. 영역이 맞는지 확인하세요.`:''}`;
  }catch(err){$('keyStatus').textContent='인식에 실패했습니다: '+(err?.message||err);}
  finally{busy=false;$('keyRead').disabled=!images.length;}
 }
 async function apply(){
  const payload={};for(const [s,k] of Object.entries(keys))if(k?.values?.some(Boolean))payload[s]=k.values;
  if(!Object.keys(payload).length)return toast('적용할 정답이 없습니다. 정답표를 인식하거나 숫자를 입력하세요.');
  const report=await onApply(payload);
  const name=id=>DEFAULT_SECTIONS.find(s=>s.id===id)?.name||id;
  const lines=report.filter(r=>r.questions).map(r=>`${name(r.section)} ${r.applied}/${r.questions}${r.mode==='order'?'(순서 기준)':''}`);
  const off=report.filter(r=>r.questions&&r.keys!==r.questions).map(r=>`${name(r.section)} ${r.keys}/${r.questions}`);
  toast(`정답 적용: ${lines.join(', ')}${off.length?' · 정답 수와 문항 수가 다른 영역(정답/문항): '+off.join(', '):''}`);
  dialog.close();
 }
 /** target: {getQuestions(), onApply(keysBySection) -> report} — the exam or the builder draft. */
 return {open(target,{prefill}={}){getQuestions=target.getQuestions;onApply=target.onApply;if(prefill)keys=structuredClone(prefill);markup();if(prefill)$('keyStatus').textContent='통합 인식에서 읽은 정답입니다. 노란 칸을 확인하고 필요하면 고친 뒤 적용하세요.';dialog.showModal();}};
}
