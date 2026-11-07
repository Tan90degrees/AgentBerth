export async function openExtensionView(page,title){
  const escaped=title.replace(/[.*+?^${}()|[\]\\]/g,'\\export async function openExtensionView(page,title){
  await page.locator('.activity-bar .extension-activity').evaluateAll((buttons,title)=>{
    const target=buttons.find(button=>button.getAttribute('aria-label')?.endsWith(' · '+title));
    if(!target)throw new Error('Activity Bar extension icon not found: '+title);
    target.click();
  },title);
  await page.locator('.extension-page').waitFor();
}');
  await page.getByRole('button',{name:new RegExp(' · '+escaped+'
export async function openRightSidebar(page,panel){
  const tabs=page.getByRole('tablist',{name:'右侧工具',exact:true});
  if(!await tabs.isVisible().catch(()=>false)){
    await page.getByRole('button',{name:panel==='文件'?'打开文件':'打开 Git',exact:true}).click();
    await tabs.waitFor();
  }
  await tabs.getByRole('tab',{name:panel,exact:true}).click();
}
)}).click();
  await page.locator('.extension-page').waitFor({state:'visible'});
  const iframe=page.locator('.extension-page iframe').filter({has:page.locator('body')});
  const titledFrame=page.locator('.extension-page iframe[title="'+title+'"]');
  if(await titledFrame.count())await titledFrame.waitFor({state:'visible'});
}
export async function openRightSidebar(page,panel){
  const tabs=page.getByRole('tablist',{name:'右侧工具',exact:true});
  if(!await tabs.isVisible().catch(()=>false)){
    await page.getByRole('button',{name:panel==='文件'?'打开文件':'打开 Git',exact:true}).click();
    await tabs.waitFor();
  }
  await tabs.getByRole('tab',{name:panel,exact:true}).click();
}
