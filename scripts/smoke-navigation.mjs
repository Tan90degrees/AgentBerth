export async function openExtensionView(page,title){
  await page.locator('.activity-bar .extension-activity').evaluateAll((buttons,title)=>{
    const target=buttons.find(button=>button.getAttribute('aria-label')?.endsWith(' · '+title));
    if(!target)throw new Error('Activity Bar extension icon not found: '+title);
    target.click();
  },title);
  await page.locator('.extension-page').waitFor();
}
export async function openRightSidebar(page,panel){
  const tabs=page.getByRole('tablist',{name:'右侧工具',exact:true});
  if(!await tabs.isVisible().catch(()=>false)){
    await page.getByRole('button',{name:panel==='文件'?'打开文件':'打开 Git',exact:true}).click();
    await tabs.waitFor();
  }
  await tabs.getByRole('tab',{name:panel,exact:true}).click();
}
