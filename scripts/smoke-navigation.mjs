export async function openExtensionView(page,title){
  const buttons=page.locator('.activity-bar .extension-activity');
  let target=-1;
  for(let index=0;index<await buttons.count();index++){
    if((await buttons.nth(index).getAttribute('aria-label'))?.endsWith(' · '+title)){target=index;break;}
  }
  if(target<0)throw new Error('Activity Bar extension icon not found: '+title);
  await buttons.nth(target).click();
  // Re-clicking the active icon intentionally collapses the sidebar. Smoke
  // flows re-open a view to assert on the session tree, so expand it again.
  const expand=page.locator('.activity-bar button[aria-label="展开会话侧栏"]');
  if(await expand.count())await expand.click();
  await page.locator('.extension-page').waitFor({state:'visible'});
  const iframe=page.locator('.extension-page iframe[title="'+title+'"]');
  if(await iframe.count())await iframe.waitFor({state:'visible'});
}
export async function openRightSidebar(page,panel){
  const sessions=page.locator('.activity-bar').getByRole('button',{name:'会话',exact:true});
  if(await sessions.getAttribute('aria-pressed')!=='true')await sessions.click();
  const tabs=page.getByRole('tablist',{name:'右侧工具',exact:true});
  if(!await tabs.isVisible().catch(()=>false)){
    await page.getByRole('button',{name:panel==='文件'?'打开文件':'打开 Git',exact:true}).click();
    await tabs.waitFor();
  }
  await tabs.getByRole('tab',{name:panel,exact:true}).click();
}

export async function selectProjectForSessions(page,button=page.locator('.projects .project-item')){
  await button.click();const toggle=button.locator('..').locator('.project-toggle');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
}
export async function openNotifications(page){const button=page.getByRole('button',{name:/^通知中心/});if(await button.getAttribute('aria-expanded')!=='true')await button.click();await page.locator('.notification-panel').waitFor();}
