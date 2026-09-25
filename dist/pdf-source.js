// Read the local File in requested byte ranges. Never materialize a full-file
// ArrayBuffer or prefetch other sections of a large question book.
export const PDF_CHUNK_SIZE=1024*1024;
export const MAX_PDF_SIZE=1024*1024*1024;
export const SOURCE_CACHE_LIMIT=32*1024*1024;
export function validatePageRange(start,end,count){
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>count)throw new Error(`시작·끝 쪽을 1~${count} 사이의 올바른 범위로 입력하세요.`);
 return {start,end};
}
export async function createFileRangeSource(file,PDFDataRangeTransport,{onRead=()=>{},onError=()=>{}}={}){
 if(!file||!Number.isSafeInteger(file.size)||file.size<=0)throw new Error('비어 있는 PDF는 열 수 없습니다.');
 if(file.size>MAX_PDF_SIZE)throw new Error('현재 PDF 한도는 1GB입니다. 그보다 큰 파일은 먼저 나누어 주세요.');
 const initial=new Uint8Array(await file.slice(0,Math.min(PDF_CHUNK_SIZE,file.size)).arrayBuffer());
 const stats={bytesRead:initial.length,requests:1};onRead({...stats,total:file.size});
 class LocalFileTransport extends PDFDataRangeTransport{
  constructor(){super(file.size,initial,true,file.name||'local.pdf');this.file=file;this.stopped=false;this.failed=false;}
  requestDataRange(begin,end){
   if(this.stopped)return;
   const read=async()=>{
    try{
     if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin||end>file.size)throw new Error('PDF 읽기 범위가 올바르지 않습니다.');
     const chunk=new Uint8Array(await this.file.slice(begin,end).arrayBuffer());
     if(this.stopped)return;
     if(chunk.length!==end-begin)throw new Error('원본 파일의 일부를 읽을 수 없습니다. 파일이 이동·변경되지 않았는지 확인해 주세요.');
     stats.bytesRead+=chunk.length;stats.requests++;onRead({...stats,total:file.size});this.onDataRange(begin,chunk);
    }catch(err){if(!this.stopped&&!this.failed){this.failed=true;this.abort();onError(err);}}
   };void read();
  }
  abort(){this.stopped=true;this.file=null;}
 }
 const range=new LocalFileTransport();
 return {range,stats,options:{range,length:file.size,rangeChunkSize:PDF_CHUNK_SIZE,disableAutoFetch:true,disableStream:true}};
}
