/** Preserve a visible message while older siblings are prepended. */
export function captureHistoryAnchor(host:HTMLElement){
  const top=host.getBoundingClientRect().top;
  const node=Array.from(host.children).find(child=>!child.classList.contains('history-load-status')&&child.getClientRects().length&&child.getBoundingClientRect().bottom>top+2);
  return {node,offset:node?.getBoundingClientRect().top??0,top:host.scrollTop,height:host.scrollHeight};
}
export function restoreHistoryAnchor(host:HTMLElement,anchor:ReturnType<typeof captureHistoryAnchor>){
  if(anchor.node?.isConnected&&anchor.node.parentElement===host)host.scrollTop+=anchor.node.getBoundingClientRect().top-anchor.offset;
  else host.scrollTop=anchor.top+host.scrollHeight-anchor.height;
}
