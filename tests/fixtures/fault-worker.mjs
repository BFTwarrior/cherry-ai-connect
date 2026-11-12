import readline from 'node:readline';
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const m=JSON.parse(line);let r={v:1,id:m.id,seq:m.seq};
 if(m.op==='hello')r.version='cherry-translator-1';
 if(m.op==='request')r.payloads=[m.payload];
 if(m.op==='chunk') {
  const value=Buffer.from(m.payload,'base64').toString();
  if(value==='crash')process.exit(2);
  if(value==='malformed'){process.stdout.write('not-json\n');return;}
  if(value==='base64'){r.payloads=['!!!'];}
 }
 process.stdout.write(JSON.stringify(r)+'\n');
});
