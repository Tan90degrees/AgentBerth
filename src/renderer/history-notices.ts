export interface HistoryNotice { original: string; text: string; count: number; kind: 'scan' | 'selection' | 'partial' | 'info' }

/** Presentation only: retain plugin diagnostics in the stored history. */
export function historyNotices(warnings: readonly string[]): HistoryNotice[] {
  const groups=new Map<string,HistoryNotice>();
  for(const value of warnings){
    const original=value.trim();if(!original)continue;
    const previous=groups.get(original);if(previous){previous.count++;continue;}
    let text=original,kind:HistoryNotice['kind']='info';
    if(original==='Skipped an invalid or foreign-project session file.'){
      text='已跳过无效或不属于当前项目的候选记录。';kind='scan';
    }else if(original==='Multiple conversations found; showing the most recent one. Use the session list to select a specific conversation.'){
      text='发现多条对话，读取器默认展示最新一条；如需其他对话，请选择会话列表中的记录或导入指定文件。';kind='selection';
    }else if(original==='Only recent conversation text is shown.'){
      text='仅显示最近的部分对话文本。';kind='partial';
    }else if(/^仅显示最近|^跳过\s*\d+\s*行/.test(original))kind='partial';
    groups.set(original,{original,text,count:1,kind});
  }
  return [...groups.values()];
}
