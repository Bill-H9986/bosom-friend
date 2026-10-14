const fs = require('fs');
const crypto = require('crypto');
function writeVarint(n){const out=[];let v=BigInt(n);while(true){const b=Number(v&0x7fn);v>>=7n;if(v===0n){out.push(b);break;}out.push(b|0x80);}return Buffer.from(out);}
function readVarint(buf,pos){let r=0n,s=0n;while(pos<buf.length){const b=buf[pos++];r|=BigInt(b&0x7f)<<s;if((b&0x80)===0)break;s+=7n;}return {value:r,pos};}
function parseFields(buf){const f=[];let pos=0;while(pos<buf.length){const tag=readVarint(buf,pos);pos=tag.pos;const num=Number(tag.value>>3n),wt=Number(tag.value&7n);let v;if(wt===0){const x=readVarint(buf,pos);pos=x.pos;v=x.value;}else if(wt===2){const l=readVarint(buf,pos);pos=l.pos;const n=Number(l.value);v=buf.subarray(pos,pos+n);pos+=n;}else if(wt===1){v=buf.subarray(pos,pos+8);pos+=8;}else if(wt===5){v=buf.subarray(pos,pos+4);pos+=4;}else break;f.push({num,wt,v});}return f;}
function encodeFields(fs){fs.sort((a,b)=>a.num-b.num);const c=[];for(const f of fs){c.push(writeVarint((BigInt(f.num)<<3n)|BigInt(f.wt)));if(f.wt===0)c.push(writeVarint(f.v));else if(f.wt===2){c.push(writeVarint(f.v.length));c.push(f.v);}else if(f.wt===1)c.push(f.v);else if(f.wt===5)c.push(f.v);}return Buffer.concat(c);}
function setStr(fs,n,v){const b=Buffer.from(v,'utf8');const f=fs.find(x=>x.num===n);if(f){f.wt=2;f.v=b;}else fs.push({num:n,wt:2,v:b});}
function setVar(fs,n,v){const f=fs.find(x=>x.num===n);if(f){f.wt=0;f.v=BigInt(v);}else fs.push({num:n,wt:0,v:BigInt(v)});}
function upd(root,path,fn){if(path.length===0){fn(root);return root;}const num=path[0];const f=root.find(x=>x.num===num);if(!f)throw new Error('missing '+num);const p=parseFields(f.v);upd(p,path.slice(1),fn);f.v=encodeFields(p);return root;}
const src=fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/dyim/MessageSender.java','utf8');
const template=Buffer.from(src.match(/TEXT_MESSAGE_TEMPLATE = "([^"]+)"/)[1],'base64');
const queryParams=src.match(/QUERY_PARAMS = "([^"]+)"/)[1];
const freshMsToken=fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/fresh-mstoken.txt','utf8').trim();
(async()=>{
  const cookieStr=fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/douyin-cookie.txt','utf8').trim();
  const sessionid=(cookieStr.match(/sessionid=([^;]+)/)||[])[1]||'';
  const root=parseFields(template);
  upd(root,[8,100],(cf)=>{setStr(cf,1,'0:1:98478746276:744786308115968');setVar(cf,2,1);setVar(cf,3,'7672290885698159141');setStr(cf,4,JSON.stringify({mention_users:[],aweType:700,richTextInfos:[],text:'链路诊断二，请忽略。'}));setStr(cf,8,crypto.randomUUID());});
  const body=encodeFields(root);
  const query = queryParams.replace(/msToken=[^&]+/, 'msToken=' + encodeURIComponent(freshMsToken));
  const res=await fetch('https://imapi.douyin.com/v1/message/send?'+query,{method:'POST',headers:{Cookie:'sessionid='+sessionid+'; sessionid_ss='+sessionid+';',accept:'application/x-protobuf','content-type':'application/x-protobuf',origin:'https://www.douyin.com',referer:'https://www.douyin.com/','user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36','accept-language':'zh-CN,zh;q=0.9','sec-ch-ua':'"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"','sec-ch-ua-mobile':'?0','sec-ch-ua-platform':'"macOS"','sec-fetch-dest':'empty','sec-fetch-mode':'cors','sec-fetch-site':'same-site'},body});
  const buf=Buffer.from(await res.arrayBuffer());
  console.log('HTTP',res.status,'bytes',buf.length);
  console.log('TEXT',buf.toString('utf8').slice(0,200));
  if(buf.length>0){const resp=parseFields(buf);const s4=resp.find(f=>f.num===4);console.log('status_message',s4?s4.v.toString('utf8'):null);}
})();
