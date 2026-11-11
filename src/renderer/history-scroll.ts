/** Preserve a visible message while older siblings are prepended. */
export function captureHistoryAnchor(host:HTMLElement){
  const top=host.getBoundingClientRect().top;
  const node=Array.from(host.children).find(child=>!child.classList.contains('history-load-status')&&child.getClientRects().length&&child.getBoundingClientRect().bottom>top+2);
  return {node,offset:node?node.getBoundingClientRect().top-top:0,top:host.scrollTop,height:host.scrollHeight};
}
export function restoreHistoryAnchor(host:HTMLElement,anchor:ReturnType<typeof captureHistoryAnchor>){
  if(anchor.node?.isConnected&&anchor.node.parentElement===host)host.scrollTop+=anchor.node.getBoundingClientRect().top-host.getBoundingClientRect().top-anchor.offset;
  else host.scrollTop=anchor.top+host.scrollHeight-anchor.height;
}

/** Markdown highlighting and font substitution may resize earlier messages
 * after React's layout effect. Keep the same message in view until the next
 * user gesture, rather than restoring against only the first layout. */
export function maintainHistoryAnchor(host: HTMLElement, anchor: ReturnType<typeof captureHistoryAnchor>, onRestore: () => void) {
  const restore = () => { restoreHistoryAnchor(host, anchor); onRestore(); };
  const observer = new ResizeObserver(restore);
  // Padding and borders can move the anchor without resizing the content box.
  for (const child of host.children) observer.observe(child, { box: 'border-box' });
  const events = ['wheel', 'pointerdown', 'keydown'] as const;
  const frame = requestAnimationFrame(restore);
  const stop = () => {
    observer.disconnect(); cancelAnimationFrame(frame);
    for (const event of events) host.removeEventListener(event, stop, true);
  };
  for (const event of events) host.addEventListener(event, stop, true);
  restore();
  return stop;
}
