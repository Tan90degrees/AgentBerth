export const uiFonts=[
  {id:'system',name:'系统字体',family:'-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'},
  {id:'modern',name:'现代无衬线',family:'"Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif'},
  {id:'noto',name:'思源黑体 / Noto Sans',family:'"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif'},
  {id:'serif',name:'衬线字体',family:'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, serif'},
  {id:'mono',name:'等宽字体',family:'"Cascadia Code", "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace'},
  {id:'custom',name:'自定义字体',family:'sans-serif'},
] as const;
export interface UiFont {font:string;customFont:string}
export function normalizeUiFont(value:unknown):UiFont{
  const data=value&&typeof value==='object'?value as Partial<UiFont>:{};
  return {font:uiFonts.some(item=>item.id===data.font)?data.font!:'system',customFont:typeof data.customFont==='string'?data.customFont.replace(/[\x00-\x1f\x7f]/g,'').slice(0,100):''};
}
export function uiFontFamily(value:UiFont){
  if(value.font==='custom')return (value.customFont.trim()?JSON.stringify(value.customFont.trim())+', ':'')+uiFonts[0].family;
  return uiFonts.find(item=>item.id===value.font)?.family??uiFonts[0].family;
}
