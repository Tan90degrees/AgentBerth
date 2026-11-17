export interface ElicitationChoice {value:string;label:string;description?:string}
export interface ElicitationField {
  key:string;title:string;description?:string;type:'string'|'number'|'integer'|'boolean'|'array';required:boolean;
  choices?:ElicitationChoice[];default?:string|number|boolean|string[];format?:string;pattern?:string;
  minLength?:number;maxLength?:number;minimum?:number;maximum?:number;minItems?:number;maxItems?:number;
}
export type ElicitationContent=Record<string,string|number|boolean|string[]>;
export interface AcpElicitation {id:string;message:string;toolCallId?:string;fields:ElicitationField[];schema?:Record<string,unknown>}

/** ACP form elicitation is distinct from permission to execute a tool. */
export function elicitationForm(id:string,params:Record<string,any>):AcpElicitation{
  if(params.mode!=='form')throw new Error('此客户端尚不支持该提问方式：'+String(params.mode));
  const schema=params.requestedSchema;if(!schema||typeof schema!=='object'||Array.isArray(schema)||schema.properties===null)throw new Error('Agent 提问缺少有效的表单结构');
  const properties=schema.properties??{};if(typeof properties!=='object'||Array.isArray(properties))throw new Error('Agent 提问字段无效');
  if(new TextEncoder().encode(JSON.stringify(params)).byteLength>64000||Object.keys(properties).length>64)throw new Error('Agent 提问表单过大，请拆分问题');
  const required:unknown[]=Array.isArray(schema.required)?schema.required:[];
  if(required.some(key=>typeof key!=='string'||!Object.hasOwn(properties,key)))throw new Error('Agent 提问包含未定义的必填字段');
  const fields=Object.entries(properties).map(([key,raw])=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Agent 提问字段无效：'+key);
    const value=raw as Record<string,any>,type=value.type;
    if(!['string','number','integer','boolean','array'].includes(type))throw new Error('暂不支持该提问字段类型：'+key+' ('+String(type)+')');
    const field:ElicitationField={key,title:typeof value.title==='string'?value.title:key,type,required:required.includes(key),...(typeof value.description==='string'?{description:value.description}:{})};
    const options=type==='array'?value.items:value;
    if(type==='array'&&(!options||options.type!=='string'))throw new Error('多选字段必须提供字符串选项：'+key);
    if(Array.isArray(options?.enum))field.choices=options.enum.map((item:unknown)=>{if(typeof item!=='string')throw new Error('选项值必须为字符串');return {value:item,label:item};});
    else if(Array.isArray(type==='array'?options?.anyOf:options?.oneOf))field.choices=(type==='array'?options.anyOf:options.oneOf).map((item:any)=>{if(typeof item?.const!=='string')throw new Error('选项缺少有效值');return {value:item.const,label:typeof item.title==='string'?item.title:item.const,...(typeof item.description==='string'?{description:item.description}:{})};});
    if(type==='array'&&!field.choices?.length||field.choices&&new Set(field.choices.map(item=>item.value)).size!==field.choices.length)throw new Error('提问选项为空或重复：'+key);
    for(const name of ['minLength','maxLength','minimum','maximum','minItems','maxItems'] as const)if(value[name]!==undefined){if(typeof value[name]!=='number'||!Number.isFinite(value[name]))throw new Error('提问约束无效：'+key);field[name]=value[name];}
    if(typeof value.format==='string')field.format=value.format;
    if(typeof value.pattern==='string')field.pattern=value.pattern;
    if(value.default!==undefined)field.default=value.default;
    return field;
  });
  return {id,message:String(params.message??schema.title??'Agent 需要你的回答'),...(typeof params.toolCallId==='string'?{toolCallId:params.toolCallId}:{}),fields,schema};
}

export function elicitationError(request:AcpElicitation,content:ElicitationContent):string|null{
  if(Object.keys(content).some(key=>!request.fields.some(field=>field.key===key)))return '回答包含未声明的字段';
  for(const field of request.fields){
    if(!Object.hasOwn(content,field.key)){if(field.required)return '请回答：'+field.title;continue;}
    const value=content[field.key],fail=(reason:string)=>field.title+'：'+reason;
    if(field.type==='array'){
      if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!field.choices?.some(choice=>choice.value===item))||new Set(value).size!==value.length)return fail('请选择有效选项');
      if(value.length<(field.minItems??(field.required?1:0)))return fail('至少选择 '+(field.minItems??1)+' 项');
      if(field.maxItems!==undefined&&value.length>field.maxItems)return fail('最多选择 '+field.maxItems+' 项');
    }else if(field.type==='string'){
      if(typeof value!=='string')return fail('请填写文本');
      if(field.required&&!value.trim()||value.length<(field.minLength??0))return fail('请填写完整回答');
      if(field.maxLength!==undefined&&value.length>field.maxLength)return fail('最多 '+field.maxLength+' 个字符');
      if(field.choices&&!field.choices.some(choice=>choice.value===value))return fail('请选择有效选项');
      if(field.format==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return fail('请填写有效邮箱');
      if(field.format==='uri'){try{new URL(value);}catch{return fail('请填写有效地址');}}
    }else if(field.type==='boolean'){if(typeof value!=='boolean')return fail('请选择是或否');}
    else if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isInteger(value)||field.minimum!==undefined&&value<field.minimum||field.maximum!==undefined&&value>field.maximum)return fail('请填写范围内的'+(field.type==='integer'?'整数':'数字'));
  }
  return null;
}
