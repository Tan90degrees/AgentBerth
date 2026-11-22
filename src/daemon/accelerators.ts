import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import { MAX_MONITORED_NODES, type AcceleratorDevice, type AcceleratorSample } from '../shared/accelerator';
import type { SshConnection, SshSecret } from '../shared/protocol';

const NVIDIA_START = '__AGENTBERTH_NVIDIA__';
const HOST_START = '__AGENTBERTH_HOST__';
const ASCEND_START = '__AGENTBERTH_ASCEND__';
const END = '__AGENTBERTH_END__';
const OUTPUT_LIMIT = 256 * 1024;

// The command is fixed. No connection fields or remote output enter the shell.
export const acceleratorProbe = [
  'export LC_ALL=C',
  "printf '\\n" + HOST_START + "\\n'",
  "awk '/^(cpu |btime )/' /proc/stat 2>/dev/null",
  "awk '/^(MemTotal|MemAvailable):/' /proc/meminfo 2>/dev/null",
  "printf '\\n" + NVIDIA_START + "\\n'",
  'if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits; else (exit 127); fi',
  "printf '\\n" + ASCEND_START + " %s\\n' \"$?\"",
  'if command -v npu-smi >/dev/null 2>&1; then npu-smi info; else (exit 127); fi',
  "printf '\\n" + END + " %s\\n' \"$?\"",
].join('\n');

function number(value: string | undefined, max = Infinity): number | null {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= max ? parsed : null;
}

function memoryValue(used: string | undefined, total: string | undefined, kind: NonNullable<AcceleratorDevice['memory']>['kind']) {
  const current = number(used), capacity = number(total);
  return current !== null && capacity && current <= capacity ? { used: current, total: capacity, kind } : null;
}

export function parseNvidiaSmi(output: string): AcceleratorDevice[] {
  const devices = new Map<string, AcceleratorDevice>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+)\s*,\s*(?:"([^"]+)"|(.+?))\s*,\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+)$/.exec(line.trim());
    if (!match) continue;
    const [, id, quoted, name, utilization, used, total, temperature] = match;
    devices.set(id, { id, kind: 'gpu', model: (quoted ?? name).trim().slice(0, 100),
      utilization: number(utilization, 100), memory: memoryValue(used, total, 'VRAM'), temperature: number(temperature, 200) });
  }
  return [...devices.values()];
}

export function parseAscendSmi(output: string): AcceleratorDevice[] {
  const devices = new Map<string, AcceleratorDevice>();
  let board: { id: string; model: string; health: string; temperature: number | null } | undefined;
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split('|').slice(1, -1).map(column => column.trim());
    if (columns.some(column => /process (?:id|name)/i.test(column))) break;
    if (columns.length < 3) continue;
    const [identity, status, metrics, extra] = columns;
    const chip = /^(\d+)(?:\s+.+)?$/.exec(identity);
    const first = /^(\d+)\s+(\S.{0,99})$/.exec(identity);
    const pci = /^(?:[\da-f]{4,8}:[\da-f]{2}:[\da-f]{2}\.[\da-f]|N\/A|NA|--|-)$/i;
    if (board && chip && pci.test(status)) {
      const utilization = number(metrics.split(/\s+/)[0], 100);
      const ddr = /(\d+)\s*\/\s*(\d+)/.exec(metrics);
      const hbm = extra && /(\d+)\s*\/\s*(\d+)/.exec(extra);
      const id = board.id + ':' + chip[1];
      devices.set(id, { id, kind: 'npu', model: board.model, health: board.health, temperature: board.temperature,
        utilization, memory: (hbm && memoryValue(hbm[1], hbm[2], 'HBM')) || (ddr && memoryValue(ddr[1], ddr[2], 'DDR')) || null });
    } else if (first && status && !pci.test(status)) {
      board = { id: first[1], model: first[2], health: status.slice(0, 45), temperature: number(metrics.split(/\s+/)[1], 200) };
    }
  }
  return [...devices.values()];
}

interface CpuCounters { total: number; idle: number; boot: number | null }

function readCpuCounters(lines: string[]): CpuCounters | undefined {
  const values = lines.find(line => /^cpu\s/.test(line))?.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!values || values.length < 4 || values.some(value => !Number.isSafeInteger(value) || value < 0)) return;
  // user and nice already include guest time, which is listed again later.
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + (values[4] ?? 0);
  const boot = number(lines.find(line => line.startsWith('btime '))?.slice(6));
  return { total, idle, boot };
}

function cpuUtilization(current?: CpuCounters, previous?: CpuCounters): number | null {
  if (!current || !previous || current.boot !== previous.boot) return null;
  const total = current.total - previous.total, idle = current.idle - previous.idle;
  return total > 0 && idle >= 0 && idle <= total ? Math.round((total - idle) * 1000 / total) / 10 : null;
}

export function parseAcceleratorProbe(output: string, previous?: CpuCounters, recordCpu?: (value: CpuCounters | undefined) => void): AcceleratorSample {
  const lines = output.split(/\r?\n/);
  const start = lines.indexOf(NVIDIA_START);
  const middle = lines.findIndex((line, i) => i > start && line.startsWith(ASCEND_START + ' '));
  const finish = lines.findIndex((line, i) => i > middle && line.startsWith(END + ' '));
  if (start < 0 || middle < 0 || finish < 0) throw new Error('远端监控命令输出不完整');
  const gpuCode = lines[middle].slice(ASCEND_START.length + 1), npuCode = lines[finish].slice(END.length + 1);
  const gpu = gpuCode === '0' ? parseNvidiaSmi(lines.slice(start + 1, middle).join('\n')) : [];
  const npu = npuCode === '0' ? parseAscendSmi(lines.slice(middle + 1, finish).join('\n')) : [];
  const devices = [...gpu, ...npu];
  const problem = [gpuCode !== '127' && !gpu.length ? 'NVIDIA GPU' : '', npuCode !== '127' && !npu.length ? '昇腾 NPU' : ''].filter(Boolean);
  const hostStart = lines.indexOf(HOST_START);
  const hostLines = hostStart >= 0 ? lines.slice(hostStart + 1, start) : [];
  const counters = readCpuCounters(hostLines);
  const memoryValue = (key: string) => number(hostLines.find(line => line.startsWith(key + ':'))?.match(/:\s*(\d+)\s+kB\s*$/)?.[1]);
  const totalKiB = memoryValue('MemTotal'), available = memoryValue('MemAvailable');
  const memory = totalKiB && available !== null && available <= totalKiB ? { usedKiB: totalKiB - available, totalKiB } : null;
  const host = counters || memory ? { cpu: cpuUtilization(counters, previous), memory } : undefined;
  recordCpu?.(counters);
  if (!devices.length && !host) {
    if (!problem.length) throw new Error('未找到 nvidia-smi 或 npu-smi，请检查驱动工具及 SSH 登录环境的 PATH');
    throw new Error(problem.join('、') + ' 未返回可识别的设备信息，请检查驱动、设备权限或工具版本');
  }
  return { devices, sampledAt: Date.now(), ...(host ? { host } : {}), ...(problem.length ? { warning: problem.join('、') + ' 未返回可用数据' } : {}) };
}

export class RemoteAcceleratorSampler {
  private readonly active = new Map<string, { result: Promise<AcceleratorSample>; controller: AbortController }>();
  private readonly cpu = new Map<string, CpuCounters>();

  sample(profile: SshConnection, fingerprint: string, credentials: (signal: AbortSignal) => Promise<SshSecret>, signal: AbortSignal): Promise<AcceleratorSample> {
    const pending = this.active.get(profile.id);
    if (pending) return pending.result;
    if (this.active.size >= MAX_MONITORED_NODES) throw new Error('最多同时采集三个远程节点');
    const controller = new AbortController();
    const result = this.collect(profile, fingerprint, credentials, AbortSignal.any([signal, controller.signal, AbortSignal.timeout(12_000)]))
      .finally(() => { if (this.active.get(profile.id)?.controller === controller) this.active.delete(profile.id); });
    this.active.set(profile.id, { result, controller });
    return result;
  }

  invalidate(id: string): void {
    this.active.get(id)?.controller.abort(new Error('SSH 连接配置已变化'));
    this.active.delete(id);
    this.cpu.delete(id);
  }

  private async collect(profile: SshConnection, fingerprint: string, credentials: (signal: AbortSignal) => Promise<SshSecret>, signal: AbortSignal) {
    signal.throwIfAborted();
    const secret = profile.authentication === 'agent' ? {} : await credentials(signal);
    signal.throwIfAborted();
    if (profile.authentication === 'password' && !secret.password) throw new Error('请在 SSH 连接设置中输入并保存密码');
    let privateKey: Buffer | undefined;
    if (profile.authentication === 'key') {
      try { privateKey = await readFile(profile.privateKeyPath, { signal }); }
      catch { signal.throwIfAborted(); throw new Error('无法读取 SSH 私钥'); }
    }
    signal.throwIfAborted();
    const output = await new Promise<string>((resolve, reject) => {
      const client = new Client();
      let settled = false, verified = false;
      const end = (error?: Error, value = '') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        client.destroy();
        if (error) reject(error); else resolve(value);
      };
      const cancel = () => end(new Error(signal.reason?.name === 'TimeoutError' ? '远程监控采集超时' : '远程监控采集已取消'));
      signal.addEventListener('abort', cancel, { once: true });
      client.on('error', (error: Error & { level?: string; code?: string }) => end(new Error(
        error.level === 'client-authentication' ? 'SSH 认证失败，请检查登录信息' :
          error.level === 'handshake' && !verified ? 'SSH 主机指纹或握手验证失败，请检查连接' : 'SSH 连接失败，请检查网络或远端服务')));
      client.on('close', () => end(new Error('SSH 连接已断开')));
      client.on('keyboard-interactive', (_name, _instructions, _language, prompts, finish) => {
        finish(prompts.length === 1 && !prompts[0].echo && /password|密码/i.test(prompts[0].prompt) && secret.password ? [secret.password] : []);
      });
      client.once('ready', () => client.exec(acceleratorProbe, (error, channel) => {
        if (error) { end(new Error('SSH 服务拒绝执行监控查询')); return; }
        if (settled) { channel.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0, exitCode: number | undefined;
        channel.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > OUTPUT_LIMIT) end(new Error('远端监控输出超过采集上限'));
          else chunks.push(chunk);
        });
        channel.stderr.resume();
        channel.on('error', () => end(new Error('远程监控查询已中断')));
        channel.on('exit', (code: number) => { exitCode = code; });
        channel.on('close', () => exitCode !== undefined && exitCode !== 0 ? end(new Error('远端监控查询失败')) : end(undefined, Buffer.concat(chunks).toString('utf8')));
      }));
      try {
        client.connect({
          host: profile.hostname, port: profile.port, username: profile.username,
          password: profile.authentication === 'password' ? secret.password : undefined,
          privateKey, passphrase: secret.passphrase, tryKeyboard: profile.authentication === 'password',
          agent: profile.authentication === 'agent' ? process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined) : undefined,
          readyTimeout: 10_000,
          hostVerifier: (key: Buffer) => (verified = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === fingerprint),
        });
      } catch { end(new Error('SSH 登录配置无效，请检查私钥格式、密钥口令或登录方式')); }
    });
    signal.throwIfAborted();
    return parseAcceleratorProbe(output, this.cpu.get(profile.id), counters => {
      if (counters) this.cpu.set(profile.id, counters);
      else this.cpu.delete(profile.id);
    });
  }
}
