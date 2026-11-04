import { Dialog } from './Dialog';

const groups: { title: string; items: [string, string][] }[] = [
  {
    title: '全局', items: [
      ['快速切换项目、会话与操作', 'Ctrl+Shift+P'],
      ['打开设置', 'Ctrl+,'],
      ['打开键盘快捷键（终端外）', 'Ctrl+/'],
      ['收起或展开侧栏（终端外）', 'Ctrl+B'],
    ],
  },
  {
    title: '项目与会话', items: [
      ['添加项目目录', 'Ctrl+Shift+O'],
      ['在当前项目新建会话', 'Ctrl+Shift+N'],
      ['循环切换当前项目会话', 'Ctrl+Tab / Ctrl+Shift+Tab'],
      ['调整条目顺序（聚焦项目或会话）', 'Alt+↑ / Alt+↓'],
      ['打开条目操作菜单（也可右键）', 'Shift+F10'],
    ],
  },
  {
    title: '视图与 Git', items: [
      ['切换到文件视图', 'Ctrl+Shift+E'],
      ['切换到 Git 视图', 'Ctrl+Shift+G'],
      ['提交已暂存的更改（提交框内）', 'Ctrl+Enter'],
    ],
  },
  {
    title: '列表与对话框', items: [
      ['移动选择', '↑ / ↓'],
      ['确认或打开', 'Enter'],
      ['关闭当前面板', 'Esc'],
    ],
  },
  {
    title: '终端与对话', items: [
      ['预览文件、定位目录或打开链接', 'Ctrl+点击'],
      ['发送消息 / 换行（Agent 对话）', 'Enter / Shift+Enter'],
    ],
  },
];

export function ShortcutsDialog({ onClose, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement | null }) {
  return <Dialog title="键盘快捷键" onClose={onClose} returnFocus={returnFocus}>
    <div className="shortcut-groups">
      {groups.map(group => <section key={group.title} className="shortcut-group" aria-label={group.title}>
        <h3>{group.title}</h3>
        <dl>{group.items.map(([label, keys]) => <div key={label} className="shortcut-row"><dt>{label}</dt><dd>{keys.split(' / ').map(key => <kbd key={key}>{key}</kbd>)}</dd></div>)}</dl>
      </section>)}
    </div>
    <p className="form-hint">macOS 上使用 ⌘ 替代 Ctrl。终端内的其他快捷键由当前 Shell 或 Agent 处理。</p>
  </Dialog>;
}
