import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {elicitationForm,elicitationError} from '../src/shared/acp-elicitation';
import {elicitationControls} from '../src/shared/elicitation-controls';
import {validateElicitationPatterns} from '../src/daemon/elicitation-patterns';

const request=()=>elicitationForm('request-1',{mode:'form',message:'请选择范围',requestedSchema:{type:'object',properties:{strategy:{type:'string',title:'方案',oneOf:[{const:'safe',title:'安全修改'},{const:'fast',title:'快速修改'}]},checks:{type:'array',title:'检查项',items:{type:'string',anyOf:[{const:'unit',title:'单元测试'},{const:'ui',title:'界面回归'}]},minItems:1,maxItems:2},count:{type:'integer',title:'轮数',minimum:1,maximum:5,default:2},enabled:{type:'boolean',title:'日志',default:false},note:{type:'string',title:'备注'}},required:['strategy','checks','count','enabled']}});
test('elicitation preserves wire values, multiple selections, false booleans and optional empty fields',()=>{
  const form=request();assert.equal(form.fields[0].choices![0].value,'safe');assert.equal(form.fields[0].choices![0].label,'安全修改');
  assert.equal(elicitationError(form,{strategy:'safe',checks:['unit','ui'],count:2,enabled:false}),null);
  for(const content of [{strategy:'安全修改',checks:['unit'],count:2,enabled:false},{strategy:'safe',checks:[],count:2,enabled:false},{strategy:'safe',checks:['unit','unit'],count:2,enabled:false},{strategy:'safe',checks:['unit'],count:1.5,enabled:false}])assert.ok(elicitationError(form,content));
  assert.throws(()=>elicitationForm('x',{mode:'form',requestedSchema:{properties:{nested:{type:'object'}}}}),/不支持/);
  assert.throws(()=>elicitationForm('x',{mode:'url',url:'https://example.invalid'}),/尚不支持/);
});
test('one shared clickable form retains answers after failed submission and returns values rather than translated labels',async()=>{
  const dom=new JSDOM('<body><main></main>'),host=dom.window.document.querySelector('main')!,submissions:any[]=[];let failing=true;
  const dispose=elicitationControls(host,request(),async(action,content)=>{submissions.push({action,content});if(failing)throw new Error('FIXTURE_REPLY_FAILED');});
  try{
    const doc=dom.window.document,form=doc.querySelector('form')!;doc.querySelector<HTMLInputElement>('input[value="safe"]')!.click();doc.querySelector<HTMLInputElement>('input[value="unit"]')!.click();doc.querySelector<HTMLInputElement>('input[value="ui"]')!.click();
    const submit=()=>form.dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));submit();await new Promise(resolve=>setTimeout(resolve,0));assert.match(doc.querySelector('[role=alert]')!.textContent!,/FIXTURE_REPLY_FAILED/);assert.equal(doc.querySelector<HTMLInputElement>('input[value="unit"]')!.checked,true);
    failing=false;submit();await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual({...submissions[1].content},{strategy:'safe',checks:['unit','ui'],count:2,enabled:false});
    (Array.from(doc.querySelectorAll('button')).find(node=>node.textContent==='拒绝回答')!).click();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(submissions.at(-1).action,'decline');assert.equal(submissions.at(-1).content,undefined);
  }finally{dispose();dom.window.close();}
});
test('Agent patterns cannot block the daemon and validation failures keep the question answerable',async()=>{
  const form=elicitationForm('pattern',{mode:'form',requestedSchema:{properties:{name:{type:'string',pattern:'^[a-z]+$'}}}});await validateElicitationPatterns(form,{name:'valid'});await assert.rejects(validateElicitationPatterns(form,{name:'INVALID'}),/格式/);
  form.fields[0].pattern='^(a+)+$';await assert.rejects(validateElicitationPatterns(form,{name:'a'.repeat(12000)+'!'}),/超时/);
});
