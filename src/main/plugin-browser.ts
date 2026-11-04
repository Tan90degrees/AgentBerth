import {WebContentsView,type BrowserWindow,shell} from 'electron';
import {localPluginUrl,type ExtensionSnapshot,type PluginBrowserRequest,pluginWebStateSchema} from '../shared/extensions';

/** A local application's own browser: no host preload, injection or CSP rewrite. */
export class PluginBrowser {
  private current:{id:string;viewId:string;generation:number;view:WebContentsView;url:string}|null=null;
  private sequence=0;
  private desired='';
  constructor(private window:BrowserWindow,private snapshot:()=>ExtensionSnapshot|undefined,private call:(id:string,command:string)=>Promise<unknown>){
    window.once('closed',()=>this.dispose());
    window.webContents.on('render-process-gone',()=>this.dispose());
    window.webContents.on('did-start-navigation',(_event,_url,_inPlace,isMain)=>{if(isMain)this.dispose();});
  }
  reconcile(){const item=this.current;if(!item)return;const plugin=this.snapshot()?.plugins.find(p=>p.manifest.id===item.id);if(plugin?.status!=='active'||plugin.generation!==item.generation)this.dispose();}
  private hide(){this.current?.view.setVisible(false);}
  async request(request:PluginBrowserRequest){
    const key=request.id+':'+request.view+':'+request.generation;
    if(request.action==='hide'){if(this.desired!==key)return;this.desired='';++this.sequence;if(this.current?.id===request.id&&this.current.viewId===request.view&&this.current.generation===request.generation)this.hide();return;}
    this.desired=key;const sequence=++this.sequence;
    const plugin=this.snapshot()?.plugins.find(p=>p.manifest.id===request.id&&p.generation===request.generation&&p.status==='active');
    const definition=plugin?.manifest.views.find(v=>v.id===request.view)?.web;if(!definition)throw new Error('原生 Web 插件视图不可用');
    const state=pluginWebStateSchema.parse(await this.call(request.id,definition.command));
    if(sequence!==this.sequence||this.window.isDestroyed())return;
    if(state.state!=='running'||!state.url){this.hide();return;}
    this.reconcile();const url=localPluginUrl(state.url),origin=url.origin;
    if(this.current&&(this.current.id!==request.id||this.current.viewId!==request.view||this.current.generation!==request.generation||this.current.url!==url.toString()))this.destroyCurrent();
    if(!this.current){
      const view=new WebContentsView({webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,partition:'persist:plugin-web-'+request.id,safeDialogs:true,webSecurity:true}});
      view.setVisible(false);
      view.webContents.setWindowOpenHandler(({url:target})=>{try{const link=new URL(target);if(['http:','https:'].includes(link.protocol)&&!link.username&&!link.password)void shell.openExternal(link.toString());}catch{/* Refuse non-Web protocols. */}return {action:'deny'};});
      const allow=(event:Electron.Event,target:string)=>{try{if(localPluginUrl(target).origin===origin)return;}catch{}event.preventDefault();};
      view.webContents.on('will-navigate',(event,target)=>allow(event,target));
      view.webContents.on('will-redirect',(event,target)=>allow(event,target));
      // A plugin web page never receives AgentBerth IPC or broad OS permissions.
      view.webContents.session.setPermissionRequestHandler((contents,permission,callback)=>callback(contents===view.webContents&&permission==='clipboard-sanitized-write'));
      view.webContents.on('will-attach-webview',event=>event.preventDefault());
      this.window.contentView.addChildView(view);
      this.current={id:request.id,viewId:request.view,generation:request.generation,view,url:url.toString()};
      void view.webContents.loadURL(url.toString()).catch(()=>{/* Chromium displays its normal local connection error. Reload remains available. */});
    }else if(request.action==='reload')this.current.view.webContents.reload();
    const bounds=request.bounds;if(!bounds){this.hide();return;}
    const scale=this.window.webContents.getZoomFactor(),[width,height]=this.window.getContentSize();
    const x=Math.max(0,Math.min(width,Math.round(bounds.x*scale))),y=Math.max(0,Math.min(height,Math.round(bounds.y*scale)));
    const right=Math.max(x,Math.min(width,Math.round((bounds.x+bounds.width)*scale))),bottom=Math.max(y,Math.min(height,Math.round((bounds.y+bounds.height)*scale)));
    this.current.view.setBounds({x,y,width:right-x,height:bottom-y});
    this.current.view.setVisible(right>x&&bottom>y);
  }
  private destroyCurrent(){const item=this.current;this.current=null;if(!item)return;
    if(!this.window.isDestroyed())this.window.contentView.removeChildView(item.view);
    if(!item.view.webContents.isDestroyed())item.view.webContents.close();
  }
  dispose(){this.desired='';++this.sequence;this.destroyCurrent();}
}
