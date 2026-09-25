import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFileRangeSource,validatePageRange,MAX_PDF_SIZE,PDF_CHUNK_SIZE} from '../dist/pdf-source.js';

test('only requested file slices are read; complete-file arrayBuffer is never used',async()=>{
 const reads=[];let delivered;
 const deliveredPromise=new Promise(r=>delivered=r);
 const file={size:300*1048576,name:'large.pdf',arrayBuffer(){throw new Error('Full read forbidden');},slice(start,end){reads.push([start,end]);return{arrayBuffer:async()=>new ArrayBuffer(end-start)};}};
 class Transport{constructor(length,initial,done){this.length=length;this.initial=initial;this.done=done;}onDataRange(begin,data){delivered({begin,length:data.length});}}
 const source=await createFileRangeSource(file,Transport);
 assert.equal(source.options.disableAutoFetch,true);assert.equal(source.options.disableStream,true);
 assert.deepEqual(reads,[[0,PDF_CHUNK_SIZE]]);
 source.range.requestDataRange(file.size-PDF_CHUNK_SIZE,file.size);
 assert.deepEqual(await deliveredPromise,{begin:file.size-PDF_CHUNK_SIZE,length:PDF_CHUNK_SIZE});
 assert.equal(source.stats.bytesRead,2*PDF_CHUNK_SIZE);
 source.range.abort();source.range.requestDataRange(100,200);assert.equal(reads.length,2);
});

test('range and size validation reject invalid input before reading or processing',async()=>{
 assert.deepEqual(validatePageRange(41,60,200),{start:41,end:60});
 for(const [start,end]of [[0,20],[20,19],[1,201],[1.5,4],[NaN,4]])assert.throws(()=>validatePageRange(start,end,200));
 await assert.rejects(createFileRangeSource({size:MAX_PDF_SIZE+1},class{}),/1GB/);
 let fail;const rejected=new Promise(r=>fail=r);
 class Transport{constructor(){}onDataRange(){assert.fail('Invalid range must not be delivered');}}
 const source=await createFileRangeSource(new Blob(['test']),Transport,{onError:fail});
 source.range.requestDataRange(2,10);assert.match((await rejected).message,/범위/);assert.equal(source.range.stopped,true);
});

test('real PDF.js opens a valid 300MiB PDF and reads page 2 without eagerly reading the filler stream',async()=>{
 const {PDFDataRangeTransport,getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const filename=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','range-300mb.pdf');
 await fs.mkdir(path.dirname(filename),{recursive:true});
 const h=await fs.open(filename,'w+');let position=0;const offsets=[0];
 const append=async text=>{const buf=Buffer.from(text,'ascii');await h.write(buf,0,buf.length,position);position+=buf.length;};
 const object=async(id,text)=>{offsets[id]=position;await append(id+' 0 obj\n'+text+'\nendobj\n');};
 const first='BT /F1 16 Tf 50 750 Td (FIRST PAGE FOR RANGE QA) Tj ET';
 const second='BT /F1 16 Tf 50 750 Td (SECOND PAGE FOR RANGE QA) Tj ET';
 await append('%PDF-1.7\n');
 await object(1,'<< /Type /Catalog /Pages 2 0 R >>');
 await object(2,'<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>');
 await object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>');
 await object(4,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>');
 await object(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 await object(6,'<< /Length '+first.length+' >>\nstream\n'+first+'\nendstream');
 await object(7,'<< /Length '+second.length+' >>\nstream\n'+second+'\nendstream');
 offsets[8]=position;const filler=300*1048576;
 await append('8 0 obj\n<< /Length '+filler+' >>\nstream\n');position+=filler;await h.truncate(position);await append('\nendstream\nendobj\n');
 const xref=position;await append('xref\n0 9\n0000000000 65535 f \n');
 for(let i=1;i<=8;i++)await append(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
 await append('trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
 const size=position;const file={size,name:'range-300mb.pdf',slice(start,end){return{arrayBuffer:async()=>{const bytes=new Uint8Array(end-start);let n=0;while(n<bytes.length){const r=await h.read(bytes,n,bytes.length-n,start+n);if(!r.bytesRead)throw new Error('Short read');n+=r.bytesRead;}return bytes.buffer;}};}};
 let task;
 try{
  const source=await createFileRangeSource(file,PDFDataRangeTransport,{onError:e=>{void task?.destroy();throw e;}});
  task=getDocument({...source.options,isEvalSupported:false,verbosity:0});
  const doc=await task.promise;assert.equal(doc.numPages,2);
  const page=await doc.getPage(2);const text=await page.getTextContent();assert.match(text.items.map(x=>x.str).join(' '),/SECOND PAGE FOR RANGE QA/);
  assert(source.stats.bytesRead<5*1048576,'Should read only PDF structure and requested page bytes');
  console.log('Large PDF range check:',JSON.stringify({fileMB:(size/1048576).toFixed(2),readMB:(source.stats.bytesRead/1048576).toFixed(2),requests:source.stats.requests,page:2}));
  page.cleanup();await doc.destroy();
 }finally{await task?.destroy().catch(()=>{});await h.close();await fs.unlink(filename);}
});
