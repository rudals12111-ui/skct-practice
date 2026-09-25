export const DEFAULT_SECTIONS=[['language','언어이해'],['data','자료해석'],['math','창의수리'],['logic','언어추리'],['sequence','수열추리']].map(([id,name])=>({id,name,minutes:15}));
// Real SKCT cognitive test (2023~2026 reports): 5 sections, 20 questions and 15 minutes each, 75 minutes total.
export const EXAM_SPEC={sections:5,questionsPerSection:20,minutes:15};
export const DEFAULT_SETTINGS={mode:'practice',allowBack:true,clearTools:true,showOmr:true,strictTools:false,limitPerSection:0,breakSeconds:60,sections:DEFAULT_SECTIONS};
export const uid=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const escapeHTML=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function formatTime(ms){const s=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
export function planFor(project,settings){const limit=Number(settings.limitPerSection)||0;return settings.sections.map(s=>{const qs=project.questions.filter(q=>q.section===s.id);return {...s,questions:limit>0?qs.slice(0,limit):qs};}).filter(s=>s.questions.length);}
export function newSession(){return {status:'ready',sectionIndex:0,index:0,answers:{},flags:{},times:{},deadline:0,accountedUntil:0,remaining:0,startedAt:null,finishedAt:null};}
export function currentQuestion(session,plan){return plan[session.sectionIndex]?.questions[session.index];}
export function accountTime(s,plan,now){if(s.status!=='running')return;const end=Math.min(now,s.deadline);const q=currentQuestion(s,plan);if(q&&end>s.accountedUntil)s.times[q.id]=(s.times[q.id]||0)+(end-s.accountedUntil);s.accountedUntil=end;}
export function startSession(s,plan,now){if(!plan.length)return;Object.assign(s,newSession(),{status:'running',startedAt:now,deadline:now+plan[0].minutes*60000,accountedUntil:now});}
export function completeSession(s,plan,now){accountTime(s,plan,now);s.status='finished';s.finishedAt=now;s.remaining=0;}
export function advanceSection(s,plan,settings,at){accountTime(s,plan,at);if(s.sectionIndex>=plan.length-1){completeSession(s,plan,at);return;}
 s.sectionIndex++;s.index=0;s.accountedUntil=at;
 const gap=settings.breakSeconds*1000;s.status=gap>0?'break':'running';s.deadline=at+(gap>0?gap:plan[s.sectionIndex].minutes*60000);
}
export function tickSession(s,plan,settings,now){let transitions=0;while(['running','break'].includes(s.status)&&s.deadline<=now&&transitions<plan.length*2+2){const at=s.deadline;if(s.status==='break'){s.status='running';s.deadline=at+plan[s.sectionIndex].minutes*60000;s.accountedUntil=at;}else advanceSection(s,plan,settings,at);transitions++;}accountTime(s,plan,now);return transitions;}
export function pauseSession(s,plan,now){if(!['running','break'].includes(s.status))return;accountTime(s,plan,now);s.remaining=Math.max(0,s.deadline-now);s.pausedPhase=s.status;s.status='paused';}
export function resumeSession(s,now){if(s.status!=='paused')return;s.status=s.pausedPhase||'running';s.deadline=now+s.remaining;s.accountedUntil=now;}
export function scoreQuestions(questions,session){return questions.reduce((r,q)=>{const a=session.answers[q.id];r.total++;if(a)r.answered++;if(q.key){r.graded++;if(a===q.key)r.correct++;else if(a)r.wrong++;else r.blank++;}else r.ungraded++;r.time+=session.times[q.id]||0;return r;},{total:0,answered:0,graded:0,correct:0,wrong:0,blank:0,ungraded:0,time:0});}
export function normalizeRect(a,b){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)};}
export function gridRects(cols,rows,margin=.025){const result=[];for(let c=0;c<cols;c++)for(let r=0;r<rows;r++)result.push({x:margin+c*(1-2*margin)/cols,y:margin+r*(1-2*margin)/rows,w:(1-2*margin)/cols,h:(1-2*margin)/rows});return result;}
export function detectQuestionRects(items,width,height,columns=1){
 const candidates=[];
 for(const item of items){const value=item.str.trim();if(!/^(?:(?:문제|문항)\s*)?(\d{1,3})\s*(?:[.．)\]]|번|$)/.test(value))continue;
  const x=item.x/width,y=item.y/height,h=Math.max(item.height/height,.012);const col=Math.min(columns-1,Math.floor(x*columns));
  if(y<.035||y>.94||x<col/columns+.005||x>col/columns+.18)continue;
  const n=Number(value.match(/\d+/)?.[0]);if(!n||n>200)continue;
  candidates.push({x,y,h,col,n});
 }
 const out=[];
 for(let col=0;col<columns;col++){
  const list=candidates.filter(v=>v.col===col).sort((a,b)=>a.y-b.y).filter((v,i,arr)=>!i||Math.abs(v.y-arr[i-1].y)>.015);
  for(let i=0;i<list.length;i++){const v=list[i],top=Math.max(.02,v.y-v.h*.9-.008),bottom=i+1<list.length?Math.max(top,list[i+1].y-list[i+1].h*.9-.012):.97;if(bottom-top<.04)continue;
   out.push({x:col/columns+.018,y:top,w:1/columns-.036,h:bottom-top,label:v.n});}
 }
 return out;
}
export class Calculator{
 constructor(){this.clear();}
 clear(){this.display='0';this.stored=null;this.op=null;this.fresh=true;this.history='';this.lastOp=null;this.lastValue=null;}
 operation(a,b,op){const v=op==='+'?a+b:op==='−'?a-b:op==='×'?a*b:b===0?NaN:a/b;return Number.isFinite(v)?Number(v.toPrecision(12)):NaN;}
 press(key){
  if(key==='C'){this.clear();return;}
  if(this.display==='오류')this.clear();
  if(/^\d{1,2}$/.test(key)){this.display=this.fresh||this.display==='0'?String(Number(key)):this.display+key;this.display=this.display.slice(0,16);this.fresh=false;return;}
  if(key==='.'){if(this.fresh){this.display='0';this.fresh=false;}if(!this.display.includes('.'))this.display+='.';return;}
  if(key==='←'){this.display=this.display.length>1?this.display.slice(0,-1):'0';if(this.display==='-')this.display='0';this.fresh=false;return;}
  if(key==='±'){if(Number(this.display)!==0)this.display=this.display.startsWith('-')?this.display.slice(1):'-'+this.display;return;}
  if(key==='%'){this.display=String(Number(this.display)/100);return;}
  const value=Number(this.display);
  if(['+','−','×','÷'].includes(key)){
   if(this.op&&!this.fresh){const result=this.operation(this.stored,value,this.op);this.history=`${this.stored} ${this.op} ${value} =`;if(!Number.isFinite(result)){this.display='오류';this.op=null;this.fresh=true;return;}this.display=String(result);}
   this.stored=Number(this.display);this.op=key;this.fresh=true;this.history=`${this.stored} ${key}`;return;
  }
  if(key==='='){
   const op=this.op||this.lastOp;if(!op)return;const left=this.op?this.stored:value,right=this.op?value:this.lastValue;
   this.history=`${left} ${op} ${right} =`;const result=this.operation(left,right,op);this.display=Number.isFinite(result)?String(result):'오류';this.lastOp=op;this.lastValue=right;this.op=null;this.stored=null;this.fresh=true;
  }
 }
}
export function validateProject(input){
 if(!input||input.format!=='skct-local-v1'||!Array.isArray(input.questions)||!input.questions.length||input.questions.length>500)throw new Error('이 앱에서 내보낸 문제집 파일(1~500문항)을 선택해 주세요.');
 const ids=new Set(),allowed=new Set(DEFAULT_SECTIONS.map(s=>s.id));
 const questions=input.questions.map((q,i)=>{
  if(!q||!allowed.has(q.section)||!Array.isArray(q.parts)||!q.parts.length||q.parts.length>20)throw new Error(`${i+1}번 문항의 영역 또는 이미지가 올바르지 않습니다.`);
  const parts=q.parts.map(p=>{if(!p||typeof p.src!=='string'||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.src)||p.src.length>22000000)throw new Error(`${i+1}번 문항 이미지가 올바르지 않습니다.`);return {src:p.src,page:Number(p.page)||0,rect:p.rect||null};});
  let id=String(q.id||uid());if(ids.has(id))id=uid();ids.add(id);
  return {id,section:q.section,label:String(q.label||`문항 ${i+1}`).slice(0,150),number:Number.isInteger(q.number)&&q.number>0&&q.number<=300?q.number:null,parts,key:[1,2,3,4,5].includes(q.key)?q.key:null,source:String(q.source||'불러온 문제집').slice(0,200)};
 });
 return {format:'skct-local-v1',id:uid(),name:String(input.name||'내 문제집').slice(0,200),questions};
}
export function csvCell(value){let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
/**
 * Apply answer keys to questions. keys: {sectionId: [answer|null by question number 1..N]}.
 * A section is matched by the recognised question numbers when they are exactly 1..N without
 * duplicates; otherwise by the order in which questions appear (the exam shows them in order).
 * Mutates q.key and returns a per-section report.
 */
export function applyAnswerKey(questions,keys){
 const report=[];
 for(const [section,list] of Object.entries(keys)){
  const qs=questions.filter(q=>q.section===section);if(!qs.length||!list?.length){report.push({section,applied:0,questions:qs.length,keys:list?.length||0,mode:'none'});continue;}
  const nums=qs.map(q=>q.number);const byNumber=nums.every(Number.isInteger)&&new Set(nums).size===nums.length&&nums.every(n=>n>=1&&n<=list.length);
  let applied=0;
  qs.forEach((q,i)=>{const n=byNumber?q.number:i+1,v=list[n-1];if([1,2,3,4,5].includes(v)){q.key=v;applied++;}});
  report.push({section,applied,questions:qs.length,keys:list.filter(Boolean).length,mode:byNumber?'number':'order'});
 }
 return report;
}
