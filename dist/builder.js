import {uid,escapeHTML as esc,normalizeRect,gridRects,validateProject,DEFAULT_SECTIONS,EXAM_SPEC} from './core.js';
import {readRecord,writeRecord} from './storage.js';
import {createFileRangeSource,validatePageRange,MAX_PDF_SIZE,SOURCE_CACHE_LIMIT} from './pdf-source.js';
const $=id=>document.getElementById(id);
const sectionName=id=>DEFAULT_SECTIONS.find(s=>s.id===id)?.name||id;

export function initBuilder({toast,ask,download,getProject,getSettings,onApply,openKeys}){
 let draft={format:'skct-local-v1',id:uid(),name:'내 PDF 문제집',questions:[]},pdf=null,pdfName='',pageNumber=1,pageText=[],pdfLib=null,selection=null,suggestions=[],lastPlan=null,shared=null,selectedId=null,initialized=false,busy=false,history=[],draftTimer,renderToken=0,pendingFile=null,activeRange=null,batchRunning=false,batchCancelled=false;
 // Auto-extraction continuity between pages.
 let autoShared=null,lastAuto=null,expectNext=null,autoSection=null;
 // Answer-key source: the same PDF by default, or a separate answer/solution PDF.
 let keyPdf=null,keyPdfName='',lastKeys=null,lastRenderError='';
 const clone=()=>({...draft,questions:draft.questions.map(q=>({...q,parts:[...q.parts]}))});
 function checkpoint(){history.push(clone());if(history.length>15)history.shift();}
 function saveDraft(){clearTimeout(draftTimer);draftTimer=setTimeout(()=>writeRecord('draft',clone()).catch(()=>toast('편집 내용 저장에 실패했습니다. 문제집 내보내기로 백업하세요.')),400);}
 function status(text){$('importStatus').textContent=text;}
 function setBusy(value){
  busy=value;
  document.querySelectorAll('#libraryDialog .pdf-action').forEach(b=>b.disabled=value||!pdf||!activeRange);
  $('openRange').disabled=value||!pdf;$('closePdf').disabled=value||!pdf;
  for(const id of ['rangeStart','rangeEnd','batchMode','cropSection','columnMode','importProjectBtn','demoProject','clearDraft','undoDraft','optSection','optTags','optJoin','optForceOcr','keyStart','keyEnd','keySet','keyPdfInput'])$(id).disabled=value;
  $('keysOnly').disabled=value||!(pdf||keyPdf);$('autoRangeMain').disabled=value||!pdf;
  document.querySelectorAll('#builderList input,#builderList select,#builderList button').forEach(el=>el.disabled=value);
  if(!value)$('undoDraft').disabled=!history.length;
  $('pdfInput').disabled=value;$('projectInput').disabled=value;
  $('applyProject').disabled=value||!draft.questions.length;$('exportProject').disabled=value||!draft.questions.length;
  $('autoAccept').disabled=value||!suggestions.some(s=>!s.excluded);
  $('cancelAuto').hidden=!batchRunning;
 }
 const opts=()=>({columns:$('columnMode').value==='auto'?'auto':Number($('columnMode').value),hideKeywordTags:$('optTags').checked,forceOcr:$('optForceOcr').checked});

 function markup(){
 $('libraryBody').innerHTML=`<div class="import-toolbar"><label class="file-label primary" for="pdfInput">PDF 불러오기</label><input type="file" id="pdfInput" accept="application/pdf,.pdf" aria-label="PDF 파일 선택"><button id="importProjectBtn">저장한 문제집 불러오기</button><input id="projectInput" type="file" accept="application/json,.json" hidden><button id="exportProject">문제집 내보내기</button><button id="demoProject">체험 예제로 돌아가기</button><button id="closePdf" disabled>원본 PDF 닫기</button></div>
<section class="pdf-range-box"><div><strong>① 문제 쪽 범위 (1회차)</strong><span id="pdfReadInfo" class="muted">최대 1GB · 필요한 부분만 읽기</span></div><div class="builder-config"><label>시작 쪽 <input id="rangeStart" type="number" min="1" value="1" style="width:85px"></label><span>~</span><label>끝 쪽 <input id="rangeEnd" type="number" min="1" value="1" style="width:85px"></label><button id="openRange" class="primary" disabled>선택 범위 열기</button><span id="activeRangeLabel" class="muted">파일 선택 후 범위를 지정하세요.</span></div>
<div class="key-range"><strong>② 정답 쪽 범위</strong><span class="muted">(선택) 해설의 ‘빠른 정답’ 표가 있는 쪽</span><div class="builder-config"><label>시작 쪽 <input id="keyStart" type="number" min="1" placeholder="—" style="width:85px"></label><span>~</span><label>끝 쪽 <input id="keyEnd" type="number" min="1" placeholder="—" style="width:85px"></label><label class="file-label" for="keyPdfInput" title="해설이 별도 PDF일 때">정답이 다른 PDF에 있음</label><input type="file" id="keyPdfInput" accept="application/pdf,.pdf" aria-label="정답이 있는 PDF 선택"><span id="keyPdfName" class="muted">문제와 같은 PDF</span><button id="keyPdfClear" class="text-btn" hidden>같은 PDF로 되돌리기</button><label>정답표 묶음 <select id="keySet" title="한 쪽에 여러 회차 정답표가 있을 때">${[1,2,3,4,5,6].map(n=>`<option value="${n}">${n}번째</option>`).join('')}</select></label></div></div>
<div class="builder-config run-row"><button id="autoRangeMain" class="primary">③ 통합 인식 · 문제 추출 + 정답 적용</button><button id="keysOnly" title="이미 추출한 문항에 정답만 다시 적용">정답만 인식해 적용</button></div><p class="inline-message">책의 인쇄 쪽번호가 아닌 PDF 쪽 순서입니다. 정답 쪽을 비워 두면 문항만 추출합니다. 한 쪽에 여러 회차의 정답표가 있으면 ‘정답표 묶음’에서 몇 번째 회차인지 고르세요.</p></section>
<div class="builder-config"><label>문제집 이름 <input id="projectName" value="${esc(draft.name)}" maxlength="200"></label><label>기본 영역 <select id="cropSection">${DEFAULT_SECTIONS.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label><label>편집 <select id="columnMode"><option value="auto">단 자동 판별</option><option value="1">1단</option><option value="2">2단 (왼쪽 → 오른쪽)</option></select></label></div>
<div class="auto-options" role="group" aria-label="자동 인식 옵션"><strong>자동 인식</strong><label class="check-field"><input type="checkbox" id="optSection" checked>쪽 머리의 영역명으로 영역 자동 지정</label><label class="check-field"><input type="checkbox" id="optTags" checked>‘기출 키워드’ 꼬리표 가리기</label><label class="check-field"><input type="checkbox" id="optJoin" checked>다음 쪽으로 넘어간 문항 이어 붙이기</label><label class="check-field"><input type="checkbox" id="optForceOcr">텍스트 PDF도 OCR 사용</label></div>
<p class="inline-message" id="importStatus" role="status">PDF를 선택하고 범위를 연 뒤 <b>자동 인식</b>을 누르세요. 스캔본은 기기 안에서 OCR로 문항 번호를 읽습니다.</p>
<div class="builder-layout"><div>
<div class="pdf-toolbar"><button id="pdfPrev" class="pdf-action" aria-label="PDF 이전 쪽">←</button><label>쪽 <input id="pageInput" type="number" min="1" value="1" aria-label="PDF 쪽 번호"></label><span id="pageTotal">/ 0</span><button id="pdfNext" class="pdf-action" aria-label="PDF 다음 쪽">→</button><button id="autoDetect" class="pdf-action primary" title="문항 번호를 인식해 문항 영역을 자동 지정">자동 인식 (이 쪽)</button><button id="autoRange" class="pdf-action" title="열어 둔 범위 전체를 자동으로 잘라 추가">범위 전체 자동 추출</button><button id="cancelAuto" hidden>중지</button><button id="wholePage" class="pdf-action">전체 선택</button><label>등분 <select id="splitMode"><option value="1,2">상하 2개</option><option value="2,1">좌우 2개</option><option value="2,2">2단 × 2개</option><option value="1,3">상하 3개</option></select></label><button id="splitPage" class="pdf-action">분할 미리 보기</button></div>
<div class="ocr-progress" id="ocrProgress" hidden><div id="ocrProgressBar"></div></div>
<div class="pdf-stage" id="pdfStage"><div class="pdf-empty" id="pdfEmpty"><b>PDF 한 권을, 문항별로.</b><p>자동 인식이 문항 번호를 찾아 머리말·쪽번호·측면 색인을 빼고 잘라 줍니다.<br>결과는 추가 전에 확인하고 고칠 수 있습니다.</p></div><div class="canvas-wrap" id="canvasWrap" hidden><canvas id="pdfCanvas" aria-label="문항 영역을 드래그하여 선택하는 PDF 페이지"></canvas><div id="cropOverlays"></div></div></div>
<div class="crop-actions"><button id="autoAccept" class="primary" disabled>인식 결과 추가</button><button id="addCrop" class="pdf-action">선택 영역 추가</button><button id="appendCrop" class="pdf-action">선택 문항에 이어 붙이기</button><button id="replaceCrop" class="pdf-action">선택 문항 이미지 교체</button><button id="setShared" class="pdf-action">공통 지문 지정</button><button id="clearShared" hidden>공통 지문 해제</button></div>
<p id="selectionInfo" class="inline-message">드래그하여 자를 영역을 지정하세요.</p>
<div id="autoLog" class="auto-log" hidden></div>
<details><summary style="font-size:13px;cursor:pointer">번호 인식 없이 여러 쪽을 균등 분할</summary><div class="builder-config"><span class="muted">위에서 연 쪽 범위에 적용</span><select id="batchMode" aria-label="여러 쪽 분할 방식"><option value="1,1">쪽당 1문항</option><option value="1,2">상하 2문항</option><option value="2,1">좌우 2문항</option><option value="2,2">2단 × 2문항</option></select><button id="batchAdd" class="pdf-action">범위 추가</button><button id="cancelBatch" hidden>추가 중지</button></div><p class="inline-message">문항 번호를 읽을 수 없는 편집에만 사용하세요. 균등 분할은 문항 길이를 판단하지 않습니다.</p></details>
</div><aside><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong id="draftCount">준비한 문항 0</strong><div><button id="undoDraft" title="마지막 문항 편집 되돌리기">↶ 되돌리기</button></div></div><div id="sectionCounts" class="section-counts"></div><div class="builder-list" id="builderList"></div><p class="inline-message">영역별로 묶어 시험에 표시합니다. 실제 시험은 영역마다 20문항입니다. 정답을 모르면 ‘미입력’으로 둡니다.</p><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><button id="keyFromBuilder" title="정답표 스크린샷이나 PDF 정답 쪽을 읽어 정답을 채웁니다">정답표로 정답 채우기</button><button id="clearDraft" class="text-btn danger">문항 목록 비우기</button></div></aside></div>
<div class="library-footer"><p>원본 파일 업로드 없음 · OCR도 이 기기에서 실행 · 편집 내용 자동 저장<br>현재 PDF: <span id="pdfFileName">없음</span></p><div><button data-close="libraryDialog">나중에 이어서</button><button id="applyProject" class="primary">시험에 적용</button></div></div>`;
 $('projectName').oninput=()=>{draft.name=$('projectName').value;saveDraft();};
 $('pdfInput').onchange=e=>{const file=e.target.files[0];if(file)loadFile(file);};
 $('importProjectBtn').onclick=()=>$('projectInput').click();
 $('projectInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>250*1024*1024)throw new Error('문제집 파일은 250MB 이하로 나누어 주세요.');const p=validateProject(JSON.parse(await file.text()));if(draft.questions.length&&!await ask('저장한 문제집을 불러올까요?','현재 편집 목록을 교체합니다. 되돌리기로 복구할 수 있습니다.','불러오기'))return;checkpoint();draft=p;selectedId=null;$('projectName').value=draft.name;renderList();saveDraft();toast(`${p.questions.length}문항을 불러왔습니다.`);}catch(err){toast(err.message||'파일을 읽을 수 없습니다.');}finally{e.target.value='';}};
 $('exportProject').onclick=()=>{if(!draft.questions.length)return;draft.name=$('projectName').value||'내 PDF 문제집';download('SKCT_문제집.json',JSON.stringify(draft));};
 $('demoProject').onclick=async()=>{if(await ask('체험 예제로 돌아갈까요?','현재 시험의 답안은 초기화됩니다. PDF 편집 목록은 보관됩니다.','예제 사용')){const {sampleProject}=await import('./samples.js');await onApply(sampleProject());$('libraryDialog').close();}};
 $('pdfPrev').onclick=()=>renderPage(pageNumber-1);$('pdfNext').onclick=()=>renderPage(pageNumber+1);$('pageInput').onchange=()=>renderPage(Number($('pageInput').value));
 $('wholePage').onclick=()=>{selection={x:0,y:0,w:1,h:1};clearSuggestions();drawOverlays();};
 $('autoDetect').onclick=detectCurrentPage;$('autoRange').onclick=autoRange;$('autoRangeMain').onclick=async()=>{if(busy||!pdf)return;const s=Number($('rangeStart').value),e=Number($('rangeEnd').value);if(!activeRange||activeRange.start!==s||activeRange.end!==e){await openRange();if(!activeRange||activeRange.start!==s||activeRange.end!==e)return;}autoRange();};$('keysOnly').onclick=keysOnly;
 $('keyPdfInput').onchange=e=>{const f=e.target.files[0];if(f)openKeyPdf(f);e.target.value='';};$('keyPdfClear').onclick=()=>{keyPdf?.destroy();keyPdf=null;keyPdfName='';$('keyPdfName').textContent='문제와 같은 PDF';$('keyPdfClear').hidden=true;setBusy(false);};
 $('autoLog').onclick=e=>{if(e.target.closest('[data-open-keys]')&&lastKeys)openKeys?.(draftKeyTarget(),{prefill:lastKeys});};$('cancelAuto').onclick=()=>{batchCancelled=true;status('현재 쪽까지 처리한 뒤 멈춥니다…');};
 $('splitPage').onclick=()=>{const [cols,rows]=$('splitMode').value.split(',').map(Number);clearSuggestions();suggestions=gridRects(cols,rows).map(r=>({...r,masks:[],section:$('cropSection').value}));selection=null;drawOverlays();status('균등 분할 후보입니다. 잘린 지문·선지가 없는지 확인한 뒤 추가하세요.');};
 $('addCrop').onclick=()=>addSelection('add');$('appendCrop').onclick=()=>addSelection('append');$('replaceCrop').onclick=()=>addSelection('replace');
 $('setShared').onclick=()=>{if(!selection)return toast('먼저 공통 지문 영역을 드래그하세요.');shared=cropPart(selection);$('clearShared').hidden=false;$('clearShared').textContent=`공통 지문 해제 (${pageNumber}쪽)`;status('이후 추가하는 모든 문항 앞에 공통 지문이 붙습니다. 지문이 바뀌면 해제하세요.');};
 $('clearShared').onclick=()=>{shared=null;autoShared=null;$('clearShared').hidden=true;status('공통 지문을 해제했습니다.');};
 $('autoAccept').onclick=acceptSuggestions;
 $('undoDraft').onclick=()=>{if(!history.length)return;draft=history.pop();$('projectName').value=draft.name;selectedId=null;lastAuto=null;renderList();saveDraft();};
 $('clearDraft').onclick=async()=>{if(!draft.questions.length)return;if(await ask('편집 목록을 비울까요?','원본 PDF는 유지되며, 되돌리기로 문항 목록을 복원할 수 있습니다.','목록 비우기')){checkpoint();draft.questions=[];selectedId=null;lastAuto=null;expectNext=null;renderList();saveDraft();}};
 $('builderList').onclick=e=>onListClick(e);
 $('builderList').onchange=e=>{const q=draft.questions.find(q=>q.id===e.target.dataset.q);if(!q)return;checkpoint();if(e.target.dataset.field==='section')q.section=e.target.value;if(e.target.dataset.field==='key')q.key=Number(e.target.value)||null;if(e.target.dataset.field==='label')q.label=e.target.value.slice(0,150);renderCounts();saveDraft();};
 $('applyProject').onclick=async()=>{if(!draft.questions.length||busy)return;const counts=sectionCounts();const off=DEFAULT_SECTIONS.filter(s=>counts[s.id]&&counts[s.id]!==EXAM_SPEC.questionsPerSection).map(s=>`${s.name} ${counts[s.id]}`);if(!await ask('이 문제집으로 시험을 준비할까요?',`${draft.questions.length}문항을 적용하고 기존 시험 답안과 시간을 초기화합니다.${off.length?` 실제 시험(영역당 ${EXAM_SPEC.questionsPerSection}문항)과 문항 수가 다른 영역: ${off.join(', ')}.`:''}`,'시험에 적용'))return;draft.name=$('projectName').value||'내 PDF 문제집';await onApply({...clone(),id:uid()});$('libraryDialog').close();toast('문제집을 적용했습니다. 시험 설정을 확인하고 시작하세요.');};
 $('libraryBody').querySelector('[data-close]').onclick=()=>$('libraryDialog').close();
 $('keyFromBuilder').onclick=()=>openKeys?.(draftKeyTarget(),lastKeys?{prefill:lastKeys}:{});
 $('batchAdd').onclick=batchAdd;$('openRange').onclick=openRange;$('closePdf').onclick=closeSource;
 $('cropOverlays').onclick=e=>{const b=e.target.closest('[data-drop]');if(!b||busy)return;e.stopPropagation();const s=suggestions[Number(b.dataset.drop)];if(s){s.excluded=!s.excluded;drawOverlays();}};
 $('cropOverlays').onchange=e=>{const sel=e.target.closest('[data-sug-section]');if(sel){suggestions[Number(sel.dataset.sugSection)].section=sel.value;}};
 let anchor=null;const wrap=$('canvasWrap');const getPoint=e=>{const r=$('pdfCanvas').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
 wrap.onpointerdown=e=>{if(busy||!pdf||e.button!==0||e.target.closest('.crop-rect button,.crop-rect select'))return;e.preventDefault();wrap.setPointerCapture(e.pointerId);anchor=getPoint(e);selection=null;};
 wrap.onpointermove=e=>{if(anchor){selection=normalizeRect(anchor,getPoint(e));drawOverlays();}};
 wrap.onpointerup=e=>{if(anchor){selection=normalizeRect(anchor,getPoint(e));if(selection.w<.005||selection.h<.005)selection=null;anchor=null;drawOverlays();}};
 wrap.onpointercancel=()=>{anchor=null;};
 renderList();setBusy(false);
 }

 function sectionCounts(){const c={};for(const q of draft.questions)c[q.section]=(c[q.section]||0)+1;return c;}
 function renderCounts(){const c=sectionCounts(),target=EXAM_SPEC.questionsPerSection;$('sectionCounts').innerHTML=DEFAULT_SECTIONS.map(s=>{const n=c[s.id]||0;return `<span class="count-chip ${n===target?'ok':n>target?'over':n?'part':''}" title="실제 시험 ${target}문항">${esc(s.name)} <b>${n}</b>/${target}</span>`;}).join('');}
 function renderList(){const scroll=$('builderList').scrollTop;$('draftCount').textContent=`준비한 문항 ${draft.questions.length}`;renderCounts();$('builderList').innerHTML=draft.questions.length?draft.questions.map((q,i)=>`<div class="builder-q ${q.id===selectedId?'active':''}" data-id="${esc(q.id)}"><div class="builder-q-head"><b>${String(i+1).padStart(2,'0')} · ${q.parts.map(p=>p.page).filter((v,i,a)=>a.indexOf(v)===i).join(', ')}쪽${q.parts.length>1?' · '+q.parts.length+'조각':''}</b><button data-action="up" aria-label="${i+1}번 문항 위로" ${i===0?'disabled':''}>↑</button><button data-action="down" aria-label="${i+1}번 문항 아래로" ${i===draft.questions.length-1?'disabled':''}>↓</button><button data-action="delete" aria-label="${i+1}번 문항 삭제">✕</button></div><button data-action="select" style="display:block;width:100%;padding:3px" title="이 문항을 선택하고 미리 보기">${q.parts.map(p=>`<img src="${p.src}" alt="${i+1}번 문항 미리 보기">`).join('')}</button><input data-q="${esc(q.id)}" data-field="label" aria-label="${i+1}번 문항 이름" value="${esc(q.label)}"><div class="q-fields"><select data-q="${esc(q.id)}" data-field="section" aria-label="${i+1}번 문항 영역">${DEFAULT_SECTIONS.map(s=>`<option value="${s.id}" ${s.id===q.section?'selected':''}>${s.name}</option>`).join('')}</select><select data-q="${esc(q.id)}" data-field="key" aria-label="${i+1}번 문항 정답"><option value="">정답 미입력</option>${[1,2,3,4,5].map(n=>`<option value="${n}" ${q.key===n?'selected':''}>정답 ${n}</option>`).join('')}</select></div></div>`).join(''):'<div style="padding:28px 20px;font-size:14px;color:#69768a;line-height:1.8">아직 문항이 없습니다.<br>왼쪽에서 자동 인식하거나 직접 잘라 추가하세요.</div>';$('builderList').scrollTop=scroll;$('undoDraft').disabled=!history.length;setBusy(busy);}
 function onListClick(e){if(busy)return;const row=e.target.closest('[data-id]'),button=e.target.closest('[data-action]');if(!row||!button)return;const i=draft.questions.findIndex(q=>q.id===row.dataset.id),action=button.dataset.action;if(i<0)return;if(action==='select'){selectedId=draft.questions[i].id;renderList();status(`${i+1}번 문항 선택됨 · 새 영역을 드래그하여 이어 붙이거나 이미지를 교체할 수 있습니다.`);showPreview(draft.questions[i]);return;}checkpoint();if(action==='delete')draft.questions.splice(i,1);if(action==='up'&&i>0)[draft.questions[i-1],draft.questions[i]]=[draft.questions[i],draft.questions[i-1]];if(action==='down'&&i<draft.questions.length-1)[draft.questions[i+1],draft.questions[i]]=[draft.questions[i],draft.questions[i+1]];renderList();saveDraft();}
 function showPreview(q){let dialog=$('cropPreview');if(!dialog){dialog=document.createElement('dialog');dialog.id='cropPreview';dialog.className='wide-dialog';document.body.append(dialog);}dialog.innerHTML=`<div class="dialog-heading"><h2>${esc(q.label)}</h2><button aria-label="문항 미리 보기 닫기">✕</button></div><div style="max-height:70vh;overflow:auto;text-align:center">${q.parts.map(p=>`<img src="${p.src}" alt="문항 이미지" style="display:block;max-width:100%;margin:0 auto 10px">`).join('')}</div>`;dialog.querySelector('button').onclick=()=>dialog.close();dialog.showModal();}

 /** Crop a normalized rect from the rendered page; masks (normalized page coords) are painted white. */
 function cropPart(rect,masks=[]){const source=$('pdfCanvas'),out=document.createElement('canvas'),x=Math.round(rect.x*source.width),y=Math.round(rect.y*source.height),w=Math.max(1,Math.round(rect.w*source.width)),h=Math.max(1,Math.round(rect.h*source.height));out.width=w;out.height=h;const ctx=out.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);ctx.drawImage(source,x,y,w,h,0,0,w,h);ctx.fillStyle='#fff';for(const m of masks)ctx.fillRect(Math.round(m.x*source.width)-x,Math.round(m.y*source.height)-y,Math.round(m.w*source.width),Math.round(m.h*source.height));const src=out.toDataURL('image/png');out.width=out.height=1;return{src,page:pageNumber,rect:{...rect}};}
 function pushPart(part,{section=$('cropSection').value,number=null,prefix=shared}={}){const q={id:uid(),label:number?`${sectionName(section)} ${number}번`:`문항 ${draft.questions.length+1}`,number,section,key:null,source:pdfName,parts:prefix?[prefix,part]:[part]};draft.questions.push(q);selectedId=q.id;return q;}
 function addSelection(mode){if(!pdf||busy)return;if(!selection||selection.w<.005||selection.h<.005)return toast('PDF에서 문제 전체를 드래그해 선택하세요.');if(mode==='add'&&draft.questions.length>=500)return toast('최대 500문항까지 준비할 수 있습니다.');const q=draft.questions.find(q=>q.id===selectedId);if(mode!=='add'&&!q)return toast('오른쪽 문항 미리 보기를 눌러 대상 문항을 먼저 선택하세요.');if(mode==='append'&&q.parts.length>=20)return toast('한 문항은 최대 20조각까지 이어 붙일 수 있습니다.');checkpoint();const part=cropPart(selection);if(mode==='add')pushPart(part);else if(mode==='append')q.parts.push(part);else q.parts=shared?[shared,part]:[part];selection=null;drawOverlays();renderList();saveDraft();status(mode==='append'?'선택 문항에 이미지를 이어 붙였습니다.':mode==='replace'?'선택 문항의 이미지를 교체했습니다.':'문항을 추가했습니다. 다음 영역을 드래그하세요.');}
 function clearSuggestions(){suggestions=[];lastPlan=null;}
 function drawOverlays(){
  const secOptions=v=>DEFAULT_SECTIONS.map(s=>`<option value="${s.id}" ${s.id===v?'selected':''}>${esc(s.name)}</option>`).join('');
  let html='';
  if(selection)html=`<div class="crop-rect" style="left:${selection.x*100}%;top:${selection.y*100}%;width:${selection.w*100}%;height:${selection.h*100}%"><span>선택</span></div>`;
  else{
   html=suggestions.map((r,i)=>`<div class="crop-rect suggestion ${r.excluded?'excluded':''}" style="left:${r.x*100}%;top:${r.y*100}%;width:${r.w*100}%;height:${r.h*100}%"><span>${r.number?r.number+'번':i+1}${r.section&&r.number?` <select data-sug-section="${i}" aria-label="후보 ${i+1} 영역">${secOptions(r.section)}</select>`:''}<button data-drop="${i}" title="${r.excluded?'다시 포함':'이 후보 제외'}">${r.excluded?'↺':'✕'}</button></span></div>`).join('');
   if(lastPlan){
    html+=suggestions.filter(s=>!s.excluded).flatMap(s=>s.masks||[]).map(m=>`<div class="mask-rect" style="left:${m.x*100}%;top:${m.y*100}%;width:${m.w*100}%;height:${m.h*100}%" title="가려질 꼬리표"></div>`).join('');
    html+=(lastPlan.shared||[]).map(s=>`<div class="crop-rect shared" style="left:${s.rect.x*100}%;top:${s.rect.y*100}%;width:${s.rect.w*100}%;height:${s.rect.h*100}%"><span>공통 지문 [${s.from}~${s.to}]</span></div>`).join('');
    if(lastPlan.leading)html+=`<div class="crop-rect leading" style="left:${lastPlan.leading.x*100}%;top:${lastPlan.leading.y*100}%;width:${lastPlan.leading.w*100}%;height:${lastPlan.leading.h*100}%"><span>앞 쪽에서 이어짐</span></div>`;
   }
  }
  $('cropOverlays').innerHTML=html;
  const active=suggestions.filter(s=>!s.excluded).length;
  $('selectionInfo').textContent=selection?`선택 크기 ${Math.round(selection.w*$('pdfCanvas').width)} × ${Math.round(selection.h*$('pdfCanvas').height)} px · 문항 번호부터 선지 끝까지 포함하세요.`:suggestions.length?`${active}개 후보 · ✕로 잘못된 후보를 빼고, 영역을 바꾼 뒤 ‘인식 결과 추가’를 누르세요.`:'드래그하여 자를 영역을 지정하세요.';
  $('autoAccept').disabled=busy||!active;
 }
 function progress(fraction){const bar=$('ocrProgress');if(fraction==null){bar.hidden=true;return;}bar.hidden=false;$('ocrProgressBar').style.width=Math.round(Math.max(0,Math.min(1,fraction))*100)+'%';}
 function log(html,reset=false){const el=$('autoLog');if(reset)el.innerHTML='';el.hidden=false;el.insertAdjacentHTML('beforeend',`<div>${html}</div>`);el.scrollTop=el.scrollHeight;}

 async function analyzeCurrent(label){
  const {analyzeCanvas}=await import('./ocr.js');
  const stages={load:'OCR 엔진 준비',page:'글자 인식',text:'텍스트 레이어 읽기',layout:'문항 영역 계산'};
  return analyzeCanvas($('pdfCanvas'),{...opts(),expectNext,textItems:pageText,onProgress:(stage,f)=>{status(`${label} · ${stages[stage]||stage}${stage==='page'?` ${Math.round(f*100)}%`:''}…`);if(stage==='page')progress(f);}});
 }
 function sectionFor(plan){
  if(!$('optSection').checked)return autoSection||$('cropSection').value;
  let next=plan.section;
  // Numbering restarted at 1 but the section tab was not read: the book moved on to the next part,
  // so do not count 1번 again under the previous section.
  if(!next&&autoSection&&expectNext>1&&plan.questions[0]?.label===1){
   const i=DEFAULT_SECTIONS.findIndex(s=>s.id===autoSection);
   next=DEFAULT_SECTIONS[(i+1)%DEFAULT_SECTIONS.length].id;
   plan.warnings.push(`번호가 1번부터 다시 시작해 영역을 ${sectionName(next)}(으)로 넘겼습니다. 영역 표기를 읽지 못했으니 확인하세요.`);
  }
  if(next){autoSection=next;$('cropSection').value=next;}
  return autoSection||$('cropSection').value;
 }
 function planToSuggestions(plan){const section=sectionFor(plan);return plan.questions.map(q=>({...q.rect,number:q.label,masks:q.masks,column:q.column,section}));}
 async function detectCurrentPage(){
  if(!pdf||!activeRange||busy)return;
  setBusy(true);selection=null;clearSuggestions();drawOverlays();
  try{
   const plan=await analyzeCurrent(`${pageNumber}쪽`);lastPlan=plan;suggestions=planToSuggestions(plan);drawOverlays();
   const found=plan.questions.map(q=>q.label).join(', ');
   status(plan.questions.length?`${pageNumber}쪽: ${plan.questions.length}문항 인식 (${found}번)${plan.section?' · 영역 '+sectionName(plan.section):''}${plan.usedOcr?' · OCR':' · 텍스트 레이어'}. 확인 후 ‘인식 결과 추가’를 누르세요.${plan.warnings.length?' ⚠ '+plan.warnings.join(' '):''}`:`${pageNumber}쪽에서 문항 번호를 찾지 못했습니다. ${plan.warnings.join(' ')} 직접 드래그하거나 편집 단 설정을 바꿔 보세요.`);
  }catch(err){status('자동 인식에 실패했습니다: '+(err?.message||err));}
  finally{progress(null);setBusy(false);drawOverlays();}
 }
 /** Add planned crops from the currently rendered page. Returns added questions. */
 function addPlan(plan,picked){
  const added=[];
  // Continuation of the previous page's last question.
  if(plan.leading&&$('optJoin').checked&&lastAuto&&lastAuto.page===pageNumber-1){const q=draft.questions.find(q=>q.id===lastAuto.id);if(q&&q.parts.length<20){q.parts.push(cropPart(plan.leading));log(`&nbsp;&nbsp;↳ ${pageNumber}쪽 윗부분을 ${esc(q.label)}에 이어 붙임`);}}
  const items=[...(plan.shared||[]).map(s=>({kind:'shared',s,col:s.column,y:s.rect.y})),...picked.map(q=>({kind:'q',q,col:q.column??0,y:q.y}))].sort((a,b)=>a.col-b.col||a.y-b.y);
  for(const it of items){
   if(it.kind==='shared'){autoShared={from:it.s.from,to:it.s.to,part:cropPart(it.s.rect,it.s.masks)};continue;}
   const q=it.q;if(draft.questions.length>=500)break;
   if(autoShared&&q.number>autoShared.to)autoShared=null;
   const prefix=autoShared&&q.number>=autoShared.from?autoShared.part:shared;
   const created=pushPart(cropPart(q,q.masks),{section:q.section,number:q.number,prefix});
   added.push(created);lastAuto={id:created.id,page:pageNumber};
   if(q.number)expectNext=q.number+1;
  }
  return added;
 }
 async function acceptSuggestions(){
  const picked=suggestions.filter(s=>!s.excluded);if(!picked.length||busy)return;
  if(draft.questions.length+picked.length>500)return toast('최대 500문항까지 추가할 수 있습니다.');
  checkpoint();
  if(lastPlan){const added=addPlan(lastPlan,picked);status(`${added.length}문항을 추가했습니다. 다음 쪽으로 이동해 계속 인식하세요.`);}
  else{for(const r of picked)pushPart(cropPart(r,r.masks||[]),{section:r.section||$('cropSection').value});status(`${picked.length}문항을 추가했습니다.`);}
  clearSuggestions();drawOverlays();renderList();saveDraft();
 }
 async function autoRange(){
  if(!pdf||!activeRange||busy)return;const {start,end}=activeRange;
  let kr;try{kr=keyRange();}catch(err){return toast(err.message);}
  if(!await ask(kr?'문제와 정답을 통합 인식할까요?':'열어 둔 범위를 자동 추출할까요?',`문제 ${start}~${end}쪽(${end-start+1}쪽)에서 문항을 추출${kr?`하고, 정답 ${kr.start}~${kr.end}쪽${keyPdf?`(${keyPdfName})`:''}의 정답표를 읽어 추출한 문항에 적용`:''}합니다. 스캔본은 쪽마다 수 초가 걸립니다. 끝나면 목록과 경고를 확인하세요.`,kr?'통합 인식':'자동 추출'))return;
  const before=new Set(draft.questions.map(q=>q.id));
  checkpoint();batchCancelled=false;batchRunning=true;setBusy(true);clearSuggestions();selection=null;drawOverlays();
  lastAuto=null;autoShared=null;expectNext=null;autoSection=null;
  log(`<b>${start}~${end}쪽 자동 추출</b>`,true);
  let total=0,problems=0;const previous=pageNumber;
  try{
   for(let n=start;n<=end&&!batchCancelled;n++){
    if(!await renderPage(n,true))throw new Error(`${n}쪽을 읽지 못해 멈췄습니다.${lastRenderError?' ('+lastRenderError+')':''}`);
    progress((n-start)/(end-start+1));
    const plan=await analyzeCurrent(`${n}/${end}쪽`);lastPlan=plan;
    const picked=planToSuggestions(plan);
    if(draft.questions.length+picked.length>500){log('⚠ 500문항 한도에 도달해 멈췄습니다.');break;}
    const added=addPlan(plan,picked);total+=added.length;
    const warn=plan.warnings.length?` <span class="warn">⚠ ${esc(plan.warnings.join(' '))}</span>`:'';if(warn)problems++;
    log(`${n}쪽 · ${added.length?added.map(q=>q.number+'번').join(', '):'문항 없음'}${plan.section?` · ${sectionName(plan.section)}`:''}${warn}`);
    renderList();saveDraft();
    await new Promise(r=>setTimeout(r,0));
   }
   log(`<b>문항 추출 완료: ${total}문항</b>${problems?` · 확인이 필요한 쪽 ${problems}곳`:''}${batchCancelled?' · 사용자가 중지함':''}.`);
   if(kr&&!batchCancelled){const added=draft.questions.filter(q=>!before.has(q.id));if(added.length)await recognizeAnswers(added,kr);else log('<span class="warn">추가된 문항이 없어 정답을 적용하지 않았습니다.</span>');}
   log('목록에서 잘린 내용·영역·정답을 확인하세요.');
  }catch(err){log(`<span class="warn">${esc(err.message||String(err))}</span>`);}
  finally{batchRunning=false;progress(null);clearSuggestions();setBusy(false);await renderPage(previous);status(`${total}문항을 자동 추가했습니다${kr?' (정답 적용 결과는 아래 기록 참고)':''}. 되돌리기로 한 번에 취소할 수 있습니다.`);}
 }

 // PDF.js 5.4.624 keeps the page count in a static PagesMapper shared by every open document,
 // so with a separate answer PDF open the other document would reject pages beyond its count.
 // Point the mapper at the document we are about to read.
 function usePages(doc){try{if(pdfLib?.PagesMapper?.instance&&doc)pdfLib.PagesMapper.instance.pagesNumber=doc.numPages;}catch{}}
 function draftKeyTarget(){return {getQuestions:()=>draft.questions,onApply:async keys=>{checkpoint();const {applyAnswerKey}=await import('./core.js');const report=applyAnswerKey(draft.questions,keys);renderList();saveDraft();return report;}};}
 function keyRange(){const s=Number($('keyStart').value)||0,e=Number($('keyEnd').value)||0;if(!s&&!e)return null;const doc=keyPdf||pdf;if(!doc)throw new Error('정답 쪽을 읽을 PDF가 없습니다.');return validatePageRange(s||e,e||s,doc.numPages);}
 async function openKeyPdf(file){
  if(busy)return;if(file.size>MAX_PDF_SIZE)return toast('PDF는 1GB까지 열 수 있습니다.');
  setBusy(true);status('정답 PDF 구조를 읽는 중…');
  try{const lib=await getPdfLib();const source=await createFileRangeSource(file,lib.PDFDataRangeTransport);
   const doc=await lib.getDocument({...source.options,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,isEvalSupported:false}).promise;
   keyPdf?.destroy();keyPdf=doc;keyPdfName=file.name;$('keyPdfName').textContent=`${file.name} · 총 ${doc.numPages}쪽`;$('keyPdfClear').hidden=false;$('keyEnd').max=$('keyStart').max=doc.numPages;status(`정답 PDF를 열었습니다(총 ${doc.numPages}쪽). 정답표가 있는 쪽 범위를 입력하세요.`);}
  catch(err){status('정답 PDF를 열지 못했습니다: '+(err.message||err));}finally{setBusy(false);}
 }
 /** Render any page of a document to a fresh canvas at a resolution suited to small table glyphs. */
 async function renderToCanvas(doc,n){usePages(doc);const page=await doc.getPage(n);try{const base=page.getViewport({scale:1}),scale=Math.min(4,2600/base.width,3600/base.height),vp=page.getViewport({scale});const c=document.createElement('canvas');c.width=Math.ceil(vp.width);c.height=Math.ceil(vp.height);await page.render({canvasContext:c.getContext('2d',{willReadFrequently:true}),viewport:vp,background:'rgb(255,255,255)'}).promise;return c;}finally{page.cleanup();}}
 /** Tables in reading order; a new set (one mock exam) starts whenever a section repeats. */
 function groupKeySets(tables){const sets=[];let cur=null;for(const t of tables){if(!cur||(t.section&&cur.some(x=>x.section===t.section)))sets.push(cur=[]);cur.push(t);}return sets;}
 async function recognizeAnswers(targetQs,range){
  const doc=keyPdf||pdf;
  log(`<b>정답 ${range.start}~${range.end}쪽 인식</b>${keyPdf?` · ${esc(keyPdfName)}`:''}`);
  // Solution books scatter the key tables over many pages: keep only the table regions of each
  // page (label + rows) and release the full page image right away.
  const {findAnswerTables}=await import('./answerkey.js');
  const canvases=[];let scanned=0;
  for(let n=range.start;n<=range.end;n++){
   status(`정답 ${n}쪽 찾는 중… (${n-range.start+1}/${range.end-range.start+1})`);progress((n-range.start)/(range.end-range.start+1)*0.5);
   const page=await renderToCanvas(doc,n);scanned++;
   const px=page.getContext('2d',{willReadFrequently:true}).getImageData(0,0,page.width,page.height).data;
   const found=findAnswerTables(px,page.width,page.height);
   for(const t of found){
    const pad=Math.round(page.width*0.01),r=t.rows,x0=Math.max(0,Math.min(t.labelRect?.x0??1e9,...r.map(w=>w.headerRect.x0))-pad),y0=Math.max(0,(t.labelRect?.y0??r[0].headerRect.y0)-pad),x1=Math.min(page.width,Math.max(t.labelRect?.x1??0,...r.map(w=>w.headerRect.x1))+pad),y1=Math.min(page.height,r.at(-1).answerY1+pad);
    const c=document.createElement('canvas');c.width=x1-x0;c.height=y1-y0;const g=c.getContext('2d',{willReadFrequently:true});g.fillStyle='#fff';g.fillRect(0,0,c.width,c.height);g.drawImage(page,x0,y0,c.width,c.height,0,0,c.width,c.height);canvases.push(c);
   }
   if(found.length)log(`&nbsp;&nbsp;정답 ${n}쪽 · 정답표 ${found.length}개`);
   page.width=page.height=1;await new Promise(r=>setTimeout(r,0));
  }
  if(!canvases.length){log(`<span class="warn">⚠ ${scanned}쪽에서 정답표를 찾지 못했습니다. 정답 쪽 범위를 확인하거나, 정답표 캡처를 ‘정답표로 정답 채우기’에 붙여넣으세요.</span>`);return null;}
  const {readAnswerKeyCanvases}=await import('./ocr.js');
  const tables=await readAnswerKeyCanvases(canvases,{onProgress:(stage,f)=>{status(stage==='load'?'OCR 엔진 준비 중…':`정답표 읽는 중… ${Math.round(f*100)}%`);progress(0.5+f*0.5);}});
  canvases.forEach(c=>{c.width=c.height=1;});
  if(!tables.length){log('<span class="warn">⚠ 정답표를 찾지 못했습니다. 정답 쪽 범위를 확인하거나, 정답표 캡처를 ‘정답표로 정답 채우기’에 붙여넣으세요.</span>');return null;}
  const sets=groupKeySets(tables),want=Number($('keySet').value)||1,idx=Math.min(sets.length,want)-1,set=sets[idx];
  if(sets.length>1||want>1)log(`정답표 묶음 ${sets.length}개 발견 · ${idx+1}번째 사용${want>sets.length?` <span class="warn">(요청한 ${want}번째가 없어 마지막 묶음 사용)</span>`:''}`);
  const keys={},values={};
  for(const t of set){
   if(!t.section){log(`<span class="warn">⚠ 영역명을 읽지 못한 정답표(${t.entries.length}문항)는 적용하지 않았습니다. ‘정답 확인·수정’에서 영역을 지정하세요.</span>`);continue;}
   const v=[],unsure=[];for(const e of t.entries){v[e.number-1]=e.answer||null;if(!e.answer||e.confidence<0.05)unsure.push(e.number-1);}
   values[t.section]=Array.from({length:v.length},(_,i)=>v[i]||null);keys[t.section]={values:values[t.section],unsure};
  }
  const {applyAnswerKey}=await import('./core.js');
  const report=applyAnswerKey(targetQs,values);lastKeys=keys;
  for(const r of report){const u=keys[r.section]?.unsure.length||0;log(`${sectionName(r.section)} · 정답 ${r.keys}개 → 문항 ${r.applied}/${r.questions}${r.mode==='order'?' (출제 순서 기준)':''}${r.questions&&r.keys!==r.questions?' <span class="warn">⚠ 개수 불일치</span>':''}${u?` <span class="warn">· 불확실 ${u}칸</span>`:''}${!r.questions?' <span class="warn">(해당 영역 문항 없음)</span>':''}`);}
  log('<button data-open-keys class="text-btn">정답 확인·수정 열기</button>');
  renderList();saveDraft();return report;
 }
 async function keysOnly(){
  if(busy)return;let kr;try{kr=keyRange();}catch(err){return toast(err.message);}
  if(!kr)return toast('② 정답 쪽 범위를 입력하세요.');if(!draft.questions.length)return toast('정답을 적용할 문항이 없습니다. 먼저 문제를 추출하세요.');
  checkpoint();setBusy(true);log('<b>정답만 인식</b> · 목록의 모든 문항에 적용',true);
  try{await recognizeAnswers(draft.questions,kr);status('정답을 적용했습니다. 되돌리기로 취소할 수 있습니다.');}catch(err){log(`<span class="warn">${esc(err.message||String(err))}</span>`);}finally{progress(null);setBusy(false);}
 }
 async function getPdfLib(){if(!pdfLib){pdfLib=await import('./vendor/pdf.mjs');pdfLib.GlobalWorkerOptions.workerSrc=new URL('./vendor/pdf.worker.mjs',import.meta.url).href;}return pdfLib;}
 async function passwordInput(){let d=$('passwordDialog');if(!d){d=document.createElement('dialog');d.id='passwordDialog';document.body.append(d);}d.innerHTML='<div class="dialog-heading"><h2>PDF 암호 입력</h2></div><p>이 PDF는 암호가 필요합니다. 암호는 저장하지 않습니다.</p><input type="password" id="pdfPassword" aria-label="PDF 암호" autocomplete="off"><div class="dialog-actions"><button id="passwordCancel">취소</button><button id="passwordOk" class="primary">열기</button></div>';return new Promise(resolve=>{const done=v=>{d.close();$('pdfPassword').value='';resolve(v);};$('passwordOk').onclick=()=>done($('pdfPassword').value);$('passwordCancel').onclick=()=>done(null);d.oncancel=e=>{e.preventDefault();done(null);};$('pdfPassword').onkeydown=e=>{if(e.key==='Enter')done($('pdfPassword').value);};d.showModal();$('pdfPassword').focus();});}
 async function closeSource(){
  if(busy)return;
  if(pdf)await pdf.destroy();pdf=null;activeRange=null;shared=null;autoShared=null;lastAuto=null;pageText=[];selection=null;clearSuggestions();
  $('canvasWrap').hidden=true;$('pdfCanvas').width=1;$('pdfCanvas').height=1;$('pdfEmpty').hidden=false;
  $('pdfEmpty').innerHTML='<b>원본 PDF를 선택하세요.</b><p>이미 잘라낸 문항과 시험 기록은 그대로 유지됩니다.</p>';
  $('pdfFileName').textContent='없음';$('pageTotal').textContent='/ 0';$('clearShared').hidden=true;
  $('pdfReadInfo').textContent='최대 1GB · 필요한 부분만 읽기';$('activeRangeLabel').textContent='파일 선택 후 범위를 지정하세요.';
  import('./ocr.js').then(m=>m.releaseOcr()).catch(()=>{});
  await writeRecord('sourcePdf',null).catch(()=>{});setBusy(false);status('원본 PDF를 닫았습니다. 자른 문항은 유지됩니다.');
 }
 async function loadPdf(file,name,{save=true}={}){
  setBusy(true);status('PDF 구조를 읽는 중입니다. 페이지 이미지는 아직 처리하지 않습니다…');let task,source,readError=null,passwordCancelled=false;
  try{
   const lib=await getPdfLib();
   if(pdf)await pdf.destroy();pdf=null;activeRange=null;
   $('canvasWrap').hidden=true;$('pdfCanvas').width=1;$('pdfCanvas').height=1;$('pdfEmpty').hidden=false;
   $('pdfEmpty').innerHTML='<b>PDF 구조 확인 중</b><p>원본의 필요한 데이터만 읽습니다.</p>';
   source=await createFileRangeSource(file,lib.PDFDataRangeTransport,{
    onRead:info=>{$('pdfReadInfo').textContent='원본 '+(file.size/1048576).toFixed(1)+'MB · 누적 읽기 '+(info.bytesRead/1048576).toFixed(1)+'MB';},
    onError:err=>{readError=err;status(err.message);void task?.destroy();}
   });
   task=lib.getDocument({...source.options,cMapUrl:new URL('./vendor/cmaps/',import.meta.url).href,cMapPacked:true,standardFontDataUrl:new URL('./vendor/standard_fonts/',import.meta.url).href,wasmUrl:new URL('./vendor/wasm/',import.meta.url).href,isEvalSupported:false});
   task.onPassword=async update=>{const password=await passwordInput();if(password===null){passwordCancelled=true;void task.destroy();}else update(password);};
   const next=await task.promise;pdf=next;pdfName=name;pageNumber=1;shared=null;autoShared=null;lastAuto=null;
   $('clearShared').hidden=true;$('pdfFileName').textContent=name+' ('+(file.size/1048576).toFixed(1)+'MB)';$('pageTotal').textContent='/ '+pdf.numPages;
   $('rangeStart').max=pdf.numPages;$('rangeEnd').max=pdf.numPages;$('rangeStart').value=1;$('rangeEnd').value=Math.min(20,pdf.numPages);
   $('activeRangeLabel').textContent='총 '+pdf.numPages+'쪽 · 아직 범위를 열지 않았습니다.';
   $('pdfEmpty').innerHTML='<b>필요한 회차만 골라 여세요.</b><p>총 '+pdf.numPages+'쪽 · 위에서 시작·끝 쪽을 입력하고<br>선택 범위 열기를 누르세요.</p>';
   if(!draft.questions.length){draft.name=name.replace(/\.pdf$/i,'');$('projectName').value=draft.name;}
   if(save)await writeRecord('sourcePdf',file.size<=SOURCE_CACHE_LIMIT?{blob:file,name}:{name,size:file.size,reselect:true}).catch(()=>toast('원본 정보 저장에 실패했습니다. 다음 실행 때 파일을 다시 선택하세요.'));
   status('원본 준비 완료 · 총 '+pdf.numPages+'쪽. 1회차 쪽 범위를 지정해 여세요.'+(file.size>SOURCE_CACHE_LIMIT?' 큰 원본은 자동 저장하지 않고 자른 문항만 보관합니다.':''));saveDraft();
  }catch(err){if(task)await task.destroy().catch(()=>{});source?.range.abort();pdf=null;activeRange=null;$('pdfEmpty').innerHTML='<b>PDF를 열지 못했습니다.</b><p>원본 파일을 다시 선택해 주세요.</p>';status(passwordCancelled?'암호 입력을 취소했습니다.':readError?.message||('PDF를 열지 못했습니다: '+(err.message||'읽기 오류')));}finally{setBusy(false);}
 }
 async function loadFile(file){
  if(busy)return;if(file.size>MAX_PDF_SIZE)return toast('PDF는 1GB까지 열 수 있습니다. 더 큰 파일은 먼저 나누어 주세요.');
  if(!/\.pdf$/i.test(file.name))return toast('PDF 파일을 선택하세요.');
  try{await loadPdf(file,file.name);}catch(err){status('파일을 읽지 못했습니다. '+err.message);}finally{$('pdfInput').value='';}
 }
 async function openRange(){
  if(!pdf||busy)return;
  try{activeRange=validatePageRange(Number($('rangeStart').value),Number($('rangeEnd').value),pdf.numPages);}catch(err){return toast(err.message);}
  $('activeRangeLabel').textContent=activeRange.start+'~'+activeRange.end+'쪽 사용 · '+(activeRange.end-activeRange.start+1)+'쪽';
  $('pageInput').min=activeRange.start;$('pageInput').max=activeRange.end;lastAuto=null;autoShared=null;expectNext=null;autoSection=null;
  await renderPage(activeRange.start);
 }
 async function renderPage(n,internal=false){
  if(!pdf||!activeRange||(!internal&&busy))return false;
  if(!Number.isInteger(n)||n<activeRange.start||n>activeRange.end){$('pageInput').value=pageNumber;toast('열어 둔 '+activeRange.start+'~'+activeRange.end+'쪽 범위 안에서 이동할 수 있습니다.');return false;}
  const token=++renderToken;setBusy(true);let page,off;
  try{
   usePages(pdf);page=await pdf.getPage(n);const base=page.getViewport({scale:1}),scale=Math.min(2.4,1800/base.width,2600/base.height),viewport=page.getViewport({scale});
   off=document.createElement('canvas');off.width=Math.ceil(viewport.width);off.height=Math.ceil(viewport.height);
   await page.render({canvasContext:off.getContext('2d'),viewport,background:'rgb(255,255,255)'}).promise;
   const text=await page.getTextContent();if(token!==renderToken)return false;pageNumber=n;
   const c=$('pdfCanvas');c.width=off.width;c.height=off.height;c.getContext('2d',{willReadFrequently:true}).drawImage(off,0,0);
   pageText=text.items.filter(i=>typeof i.str==='string').map(item=>{const t=pdfLib.Util.transform(viewport.transform,item.transform);return{str:item.str,x:t[4],y:t[5],width:(item.width||0)*viewport.scale,height:Math.hypot(t[2],t[3])};});
   selection=null;clearSuggestions();$('pageInput').value=n;$('canvasWrap').hidden=false;$('pdfEmpty').hidden=true;$('pdfStage').scrollTop=0;drawOverlays();
   const chars=pageText.reduce((sum,i)=>sum+i.str.trim().length,0);
   if(!internal)status(n+'/'+pdf.numPages+'쪽 · 사용 범위 '+activeRange.start+'~'+activeRange.end+'쪽 · '+(chars>40?'텍스트 PDF ('+chars+'자). 자동 인식은 텍스트 레이어를 바로 사용합니다.':'스캔형 페이지입니다. 자동 인식은 이 기기에서 OCR을 실행합니다.'));
   return true;
  }catch(err){lastRenderError=err?.message||String(err);status('페이지를 표시하지 못했습니다: '+lastRenderError);return false;}
  finally{page?.cleanup();if(off){off.width=1;off.height=1;}if(token===renderToken)setBusy(batchRunning);}
 }
 async function batchAdd(){if(!pdf||!activeRange||busy)return;const {start,end}=activeRange,[cols,rows]=$('batchMode').value.split(',').map(Number),total=(end-start+1)*cols*rows;if(total+draft.questions.length>500)return toast('추가 후 총 문항 수가 500개 이하가 되도록 범위를 줄이세요.');if(!await ask('여러 쪽을 문항으로 추가할까요?',`${start}~${end}쪽을 ${total}문항으로 자릅니다. 문항 경계는 균등 분할되므로 추가 후 반드시 확인하세요.`,'범위 추가'))return;
  checkpoint();batchCancelled=false;batchRunning=true;const previous=pageNumber;setBusy(true);$('cancelBatch').hidden=false;$('cancelBatch').onclick=()=>{batchCancelled=true;};let added=0;
  try{for(let n=start;n<=end&&!batchCancelled;n++){const rendered=await renderPage(n,true);if(!rendered)throw new Error(`${n}쪽을 읽지 못해 추가를 멈췄습니다.`);for(const r of gridRects(cols,rows))pushPart(cropPart(r));added+=cols*rows;status(`${n}/${end}쪽 처리 · ${added}문항 추가됨`);await new Promise(r=>setTimeout(r,0));}renderList();saveDraft();}catch(err){toast(err.message);renderList();saveDraft();}finally{batchRunning=false;setBusy(false);$('cancelBatch').hidden=true;await renderPage(previous);status(`${added}문항을 추가했습니다.${batchCancelled?' 중지 전까지의 문항이 보관되었습니다.':''} 오른쪽 미리 보기에서 잘린 내용을 확인하세요.`);}
 }
 return {pdfCanvas:()=>pdf&&activeRange&&!$('canvasWrap')?.hidden?$('pdfCanvas'):null,syncKeys(questions){const byId=new Map(questions.map(q=>[q.id,q.key]));let n=0;for(const q of draft.questions)if(byId.has(q.id)&&byId.get(q.id)!==q.key){q.key=byId.get(q.id);n++;}if(n){if(initialized)renderList();saveDraft();}},
  async open(){if(!initialized){try{const saved=await readRecord('draft');if(saved?.questions)draft=saved;else{const current=getProject();if(current.questions.some(q=>q.parts?.length))draft={...current,questions:current.questions.filter(q=>q.parts?.length)};}pendingFile=await readRecord('sourcePdf');}catch{}initialized=true;markup();}else{renderList();}$('libraryDialog').showModal();if(pendingFile){const p=pendingFile;pendingFile=null;if(p.reselect){$('pdfFileName').textContent=p.name+' · 원본 재선택 필요';status('이전에 사용한 큰 원본: '+p.name+'. 계속 편집하려면 PDF를 다시 선택하세요. 잘라낸 문항은 이미 보관되어 있습니다.');}else{await loadPdf(p.blob||new Blob([p.bytes],{type:'application/pdf'}),p.name,{save:false});}}}};
}
