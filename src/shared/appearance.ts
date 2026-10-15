import type { ITheme } from '@xterm/xterm';

export type AppearanceMode='system'|'light'|'dark';
export type ResolvedAppearance='light'|'dark';
export function appearanceMode(value:unknown):AppearanceMode{return value==='light'||value==='dark'?value:'system';}
export function resolveAppearance(mode:AppearanceMode,systemDark:boolean):ResolvedAppearance{return mode==='system'?(systemDark?'dark':'light'):mode;}
export const terminalThemes:Record<ResolvedAppearance,ITheme>={
  dark:{overviewRulerBorder:'#393939',scrollbarSliderBackground:'#60606080',scrollbarSliderHoverBackground:'#808080a0',scrollbarSliderActiveBackground:'#a0a0a0b0',background:'#212121',foreground:'#ececec',cursor:'#ececec',cursorAccent:'#212121',selectionBackground:'#4c5562',selectionInactiveBackground:'#3a3a3a',black:'#171717',red:'#ee8585',green:'#83c99a',yellow:'#e4c682',blue:'#8ab4f8',magenta:'#cba6e4',cyan:'#7ec5cb',white:'#d4d4d4',brightBlack:'#929292',brightRed:'#ff9c9c',brightGreen:'#a2dbad',brightYellow:'#f1dda1',brightBlue:'#adcaff',brightMagenta:'#dfc2f1',brightCyan:'#a1dce0',brightWhite:'#ffffff'},
  light:{overviewRulerBorder:'#e5e5e5',scrollbarSliderBackground:'#a0a0a080',scrollbarSliderHoverBackground:'#808080a0',scrollbarSliderActiveBackground:'#606060b0',background:'#ffffff',foreground:'#202123',cursor:'#202123',cursorAccent:'#ffffff',selectionBackground:'#d1e2f5',selectionInactiveBackground:'#e7e7e7',black:'#242424',red:'#a82132',green:'#24683b',yellow:'#805800',blue:'#2358a8',magenta:'#7e3fa1',cyan:'#006b75',white:'#656565',brightBlack:'#666666',brightRed:'#b82535',brightGreen:'#24713d',brightYellow:'#805b00',brightBlue:'#1c60b8',brightMagenta:'#8544ac',brightCyan:'#006f79',brightWhite:'#303030'},
};
