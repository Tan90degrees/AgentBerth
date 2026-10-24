import type { McpCallMetric, McpMetrics } from '../shared/protocol';

/** Per-backend counters. No tool arguments, output, paths or credentials. */
export class McpCallStats {
  private since=new Date().toISOString();
  private seen=new Set<string>();
  private counts=new Map<string,{tool:string;total:number;succeeded:number;failed:number}>();
  record(value:McpCallMetric):void {
    if(this.seen.has(value.callId))return;
    this.seen.add(value.callId);if(this.seen.size>10000)this.seen.delete(this.seen.values().next().value!);
    const tool=this.counts.has(value.tool)||this.counts.size<64?value.tool:'other';
    const row=this.counts.get(tool)??{tool,total:0,succeeded:0,failed:0};
    row.total++;if(value.success)row.succeeded++;else row.failed++;this.counts.set(tool,row);
  }
  snapshot():McpMetrics {
    const tools=[...this.counts.values()].map(row=>({...row})).sort((a,b)=>b.total-a.total||a.tool.localeCompare(b.tool));
    const total=tools.reduce((sum,row)=>sum+row.total,0),succeeded=tools.reduce((sum,row)=>sum+row.succeeded,0);
    return {since:this.since,total,succeeded,failed:total-succeeded,successRate:total?succeeded/total:null,tools};
  }
}
