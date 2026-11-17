export interface TaskQuestion {id:string;header:string;question:string;multiple:boolean;options:{label:string;description:string}[]}
/** Normalize common Agent question shapes; never treat an answer as tool permission. */
export function taskQuestions(value:unknown):TaskQuestion[]{
  const root=value&&typeof value==='object'?value as Record<string,unknown>:null;
  const items=Array.isArray(value)?value:Array.isArray(root?.questions)?root.questions:root?[root]:typeof value==='string'?[{question:value}]:[];
  return items.flatMap((item,index)=>{
    if(typeof item==='string')item={question:item};if(!item||typeof item!=='object')return [];
    const source=item as Record<string,unknown>,question=source.question??source.prompt??source.text??source.title;if(typeof question!=='string'||!question.trim())return [];
    const options=(Array.isArray(source.options)?source.options:Array.isArray(source.choices)?source.choices:[]).flatMap((option:unknown)=>{if(typeof option==='string')return[{label:option,description:''}];if(!option||typeof option!=='object')return[];const value=option as Record<string,unknown>,label=value.label??value.name??value.text??value.value;return typeof label==='string'&&label.trim()?[{label,description:typeof value.description==='string'?value.description:''}]:[];});
    return [{id:String(source.id??index).slice(0,100),header:typeof source.header==='string'?source.header.slice(0,100):'问题 '+(index+1),question,multiple:source.multiple===true||source.multiSelect===true||source.multi_select===true,options}];
  });
}
