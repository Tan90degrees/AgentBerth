import {readStored} from './storage';

export interface SidebarOrder {projects:string[];sessions:Record<string,string[]>}
export interface SidebarMove {kind:'project'|'session';id:string;targetId:string;edge:'before'|'after';projectId?:string}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ids=(value:unknown,limit:number)=>Array.isArray(value)?[...new Set(value.filter((id):id is string=>typeof id==='string'&&uuid.test(id)))].slice(0,limit):[];
export function loadSidebarOrder(storage?:Pick<Storage,'getItem'>):SidebarOrder{
  try{
    const text=readStored('berth.sidebarOrder',storage);if(!text||text.length>1024*1024)return {projects:[],sessions:{}};
    const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid order');
    return {projects:ids(value.projects,200),sessions:Object.fromEntries(Object.entries(value.sessions&&typeof value.sessions==='object'&&!Array.isArray(value.sessions)?value.sessions:{}).filter(([id])=>uuid.test(id)).slice(0,200).map(([id,order])=>[id,ids(order,2000)]))};
  }catch{return {projects:[],sessions:{}};}
}
/** New members lead saved members; unavailable saved IDs retain their slots. */
export function completeSidebarOrder(current:readonly string[],saved:readonly string[]):string[]{
  const previous=new Set(saved);return [...new Set([...current.filter(id=>!previous.has(id)),...saved])];
}
/** Record membership changes once, so activity updates cannot reshuffle new items. */
export function reconcileSidebarOrder(previous:SidebarOrder,projects:readonly string[],sessions:readonly {id:string;projectId:string}[]):SidebarOrder{
  const nextProjects=completeSidebarOrder(projects,previous.projects),nextSessions={...previous.sessions};
  let changed=nextProjects.length!==previous.projects.length;
  const groups=new Map<string,string[]>();
  for(const session of sessions){const group=groups.get(session.projectId)??[];group.push(session.id);groups.set(session.projectId,group);}
  for(const [id,current] of groups){const saved=previous.sessions[id]??[],next=completeSidebarOrder(current,saved);if(next.length!==saved.length){nextSessions[id]=next;changed=true;}}
  return changed?{projects:nextProjects,sessions:nextSessions}:previous;
}
export function orderSidebarItems<T extends {id:string}>(items:readonly T[],saved:readonly string[]):T[]{
  if(!saved.length)return [...items];const full=completeSidebarOrder(items.map(item=>item.id),saved),positions=new Map(full.map((id,index)=>[id,index]));
  return [...items].sort((a,b)=>positions.get(a.id)!-positions.get(b.id)!);
}
/** Apply a move to the complete list, rather than the current search results. */
export function moveSidebarItem(current:readonly string[],saved:readonly string[],id:string,targetId:string,edge:'before'|'after'):string[]{
  const full=completeSidebarOrder(current,saved);if(id===targetId||!current.includes(id)||!current.includes(targetId))return full;
  const rest=full.filter(item=>item!==id),index=rest.indexOf(targetId)+(edge==='after'?1:0);rest.splice(index,0,id);return rest;
}
