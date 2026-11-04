const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,child:child.pid})+'\n');
process.stdout.write('SERVICE_READY '+process.pid+'\n');
setInterval(()=>process.stdout.write('SERVICE_TICK\n'),1000);
