import { WebExtensionView } from './WebExtensionView';
import { HtmlExtensionView } from './HtmlExtensionView';
import type { ExtensionInfo } from '../shared/extensions';
export { PluginNoticeContext } from './HtmlExtensionView';

export function ExtensionView(props:{plugin:ExtensionInfo;viewId:string;onError:(error:string)=>void;initialTaskId?:string;suspended?:boolean}){
  return props.plugin.manifest.views.find(v=>v.id===props.viewId)?.web?<WebExtensionView {...props}/>:<HtmlExtensionView {...props}/>;
}
