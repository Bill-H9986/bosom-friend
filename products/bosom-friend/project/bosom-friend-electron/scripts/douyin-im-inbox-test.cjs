const fs = require('fs');
// reuse helpers from douyin-im-test by requiring? simpler: quick inline minimal codec
function writeVarint(n){const out=[];let v=BigInt(n);while(true){const b=Number(v&0x7fn);v>>=7n;if(v===0n){out.push(b);break;}out.push(b|0x80);}return Buffer.from(out);}
function readVarint(buf,pos){let r=0n,s=0n;while(pos<buf.length){const b=buf[pos++];r|=BigInt(b&0x7f)<<s;if((b&0x80)===0)break;s+=7n;}return {value:r,pos};}
function parseFields(buf){const f=[];let pos=0;while(pos<buf.length){const tag=readVarint(buf,pos);pos=tag.pos;const num=Number(tag.value>>3n),wt=Number(tag.value&7n);let v;if(wt===0){const x=readVarint(buf,pos);pos=x.pos;v=x.value;}else if(wt===2){const l=readVarint(buf,pos);pos=l.pos;const n=Number(l.value);v=buf.subarray(pos,pos+n);pos+=n;}else if(wt===1){v=buf.subarray(pos,pos+8);pos+=8;}else if(wt===5){v=buf.subarray(pos,pos+4);pos+=4;}else break;f.push({num,wt,v});}return f;}
function encodeFields(fs){fs.sort((a,b)=>a.num-b.num);const c=[];for(const f of fs){c.push(writeVarint((BigInt(f.num)<<3n)|BigInt(f.wt)));if(f.wt===0)c.push(writeVarint(f.v));else if(f.wt===2){c.push(writeVarint(f.v.length));c.push(f.v);}else if(f.wt===1)c.push(f.v);else if(f.wt===5)c.push(f.v);}return Buffer.concat(c);}
const JAVA='C:/Users/Jay/AppData/Local/Temp/dyim/StrangerMessageFetcher.java';
const src=fs.readFileSync(JAVA,'utf8');
const b64=src.match(/base64Content = "([^"]+)"/)[1];
const template=Buffer.from(b64,'base64');
(async()=>{
  const cookieStr=fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/douyin-cookie.txt','utf8').trim();
  const sessionid=(cookieStr.match(/sessionid=([^;]+)/)||[])[1]||'';
  for(const inboxType of [0,1,2,3]){
    const root=parseFields(template);
    const f6=root.find(f=>f.num===6);
    if(f6){f6.wt=0;f6.v=BigInt(inboxType);}else{root.push({num:6,wt:0,v:BigInt(inboxType)});}
    const body=encodeFields(root);
    const res=await fetch('https://imapi.douyin.com/v1/stranger/get_conversation_list',{method:'POST',headers:{Cookie:'sessionid='+sessionid+'; sessionid_ss='+sessionid+';',accept:'application/x-protobuf','content-type':'application/x-protobuf',origin:'https://www.douyin.com',referer:'https://www.douyin.com/','user-agent':'Mozilla/5.0'},body});
    const buf=Buffer.from(await res.arrayBuffer());
    console.log('inbox_type',inboxType,'HTTP',res.status,'bytes',buf.length,'head',buf.subarray(0,20).toString('hex'));
  }
})();
