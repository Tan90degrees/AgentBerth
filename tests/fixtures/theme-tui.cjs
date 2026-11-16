// A real process that chooses truecolors from host queries, including updates
// received without a visible renderer. Protocol bytes never become draft text.
const trace=process.argv[2],fs=require('node:fs');
const record=(kind,data)=>{if(trace)fs.appendFileSync(trace,JSON.stringify({kind,data})+'\n');};
record('start',{platform:process.platform,isTTY:process.stdin.isTTY});
process.stdin.setRawMode(true);process.stdin.resume();
let input='',draft='',theme='unknown',foreground='',background='',colors=0;
function draw(){if(!background)return;const light=theme==='light';process.stdout.write('\x1b[H\x1b[2J'+(light?'\x1b[48;2;255;255;255m\x1b[38;2;32;33;35m':'\x1b[48;2;33;33;33m\x1b[38;2;236;236;236m')+'THEME_TUI_'+theme.toUpperCase()+'\r\nFG_'+foreground+'\r\nBG_'+background+'\r\nCOLOR_REPLIES_'+colors+'\r\nDRAFT_'+draft+'\x1b[0m');}
function finish(){process.stdout.write('\x1b[?2031l\x1b[?1049lTHEME_TUI_DONE\r\n');process.exit(0);}
process.stdout.on('resize',draw);process.on('SIGINT',finish);
process.stdin.on('data',data=>{record('input',data.toString());input+=data.toString();while(input){
 if(input[0]==='\x03'){finish();return;}
 if(input[0]!=='\x1b'){draft+=input[0];input=input.slice(1);draw();continue;}
 if(input.length<2)return;
 if(input.startsWith('\x1b[')){const report=input.match(/^\x1b\[\?997;([12])n/);if(report){theme=report[1]==='1'?'dark':'light';background='';input=input.slice(report[0].length);process.stdout.write('\x1b]10;?;?\x07');continue;}const csi=input.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);if(!csi)return;input=input.slice(csi[0].length);continue;}
 if(input.startsWith('\x1b]')){const osc=input.match(/^\x1b\](10|11);rgb:([\da-f/]+)(?:\x07|\x1b\\)/i);if(!osc)return;if(osc[1]==='10')foreground=osc[2];else{background=osc[2];colors++;}input=input.slice(osc[0].length);draw();continue;}
 input=input.slice(2);
}});
process.stdout.write('\x1b[?1049h\x1b[?2031h\x1b[?996n');
setTimeout(finish,90000).unref();
