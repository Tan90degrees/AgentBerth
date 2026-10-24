import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SshSecret } from '../shared/protocol';
import { sshSecretSchema } from '../shared/protocol';

interface Encryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(bytes: Buffer): string;
}
/** Public connection configuration lives in SQLite; secrets never do. */
export class SshVault {
  private memory = new Map<string, SshSecret>();
  constructor(private file: string, private encryption: Encryption) {}
  private disk(): Record<string,string> {
    if (!existsSync(this.file)) return {};
    try { const value = JSON.parse(readFileSync(this.file,'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => typeof item !== 'string')) throw new Error(); return value; }
    catch { throw new Error('SSH 凭据存储无法读取；请重新输入登录信息'); }
  }
  get(id: string): SshSecret {
    const cached = this.memory.get(id); if (cached) return { ...cached };
    const encrypted = this.disk()[id]; if (!encrypted) return {};
    try { return sshSecretSchema.parse(JSON.parse(this.encryption.decryptString(Buffer.from(encrypted,'base64')))); }
    catch { throw new Error('无法解密 SSH 登录信息，请重新输入密码或密钥口令'); }
  }
  save(id: string, secret: SshSecret, remember: boolean): void {
    const value = sshSecretSchema.parse(secret), disk = this.disk();
    if (remember && Object.values(value).some(Boolean)) {
      if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text') throw new Error('当前系统没有可用的安全凭据存储；请取消“记住密码”，在本次运行期间使用');
      disk[id] = this.encryption.encryptString(JSON.stringify(value)).toString('base64');
    } else delete disk[id];
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(disk), {mode:0o600}); renameSync(temporary,this.file);
    this.memory.set(id,{...value});
  }
  delete(id: string): void { this.save(id,{},false); this.memory.delete(id); }
}
