export async function openExtensionView(page,title){
  const trigger=page.getByRole('button',{name:'扩展应用',exact:true});
  if(await trigger.getAttribute('aria-expanded')!=='true'){await trigger.focus();await trigger.press('Enter');}
  const launcher=page.getByRole('dialog',{name:'扩展应用',exact:true});await launcher.waitFor();
  await launcher.getByRole('button',{name:title,exact:true}).click();await launcher.waitFor({state:'hidden'});
}
