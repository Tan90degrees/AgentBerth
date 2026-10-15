import { API_VERSION, type AppInfo } from './protocol';

export function diagnostics(info: AppInfo, connected: boolean, apiVersion: number, running: number): string {
  return [`AgentBerth ${info.version}`, `系统: ${info.platform} ${info.arch} ${info.osRelease}`, `安装方式: ${info.packaged ? '软件包' : '开发环境'}`, `Electron: ${info.electron}`, `Node: ${info.node}`, `后台连接: ${connected ? '已连接' : '未连接'}`, `后台 API: ${apiVersion} / 应用 API: ${API_VERSION}`, `运行终端: ${running}`].join('\n');
}
