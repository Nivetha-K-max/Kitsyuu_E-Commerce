const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'dist'),c=JSON.parse(fs.readFileSync(path.join(root,'content.json'),'utf8'));
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
let html=fs.readFileSync(path.join(root,'index.html'),'utf8');
html=html.replace(/(<([a-z0-9]+)\b[^>]*data-copy="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/gi,(match,start,tag,key,old,end)=>{const v=key.split('.').reduce((o,k)=>o?.[k],c);return typeof v==='string'?start+escape(v)+end:match;});
fs.writeFileSync(path.join(root,'index.html'),html);console.log('Static HTML synchronized with content.json');
