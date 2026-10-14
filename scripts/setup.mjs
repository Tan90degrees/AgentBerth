import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { electronExecutable, electronInstallation, installationEnvironment, printDownloadHelp } from './electron-runtime.mjs';

const require = createRequire(import.meta.url);

function run(script, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code ?? signal}`));
    });
  });
}

async function setup() {
  const installation = electronInstallation();
  const env = installationEnvironment();
  let installed = false;
  try { electronExecutable(installation, env); installed = true; } catch {}
  if (!installed) {
    console.log(`安装 Electron ${installation.version} (${process.platform}/${process.arch})…`);
    try {
      // Use the pinned package's installer, cache and embedded checksum verification.
      await run(path.join(installation.directory, 'install.js'), [], env);
      electronExecutable(installation, env);
    } catch (error) {
      printDownloadHelp();
      throw new Error(`Electron 安装未完成：${error.message}`);
    }
  }
  console.log('为 Electron 编译 node-pty…');
  const rebuildScript = path.join(path.dirname(require.resolve('@electron/rebuild')), 'cli.js');
  try {
    await run(rebuildScript, ['-f', '-w', 'node-pty', '-v', installation.version], env);
    // Rebuilding recreates build/Release. Restore node-pty's pinned ConPTY runtime
    // beside the newly compiled addon so source and packaged apps use the same VT implementation.
    if (process.platform === 'win32') await run(require.resolve('node-pty/scripts/post-install.js'), [], env);
  } catch (error) {
    throw new Error(`node-pty 编译失败：${error.message}。Windows 请检查 Python 3、Visual Studio C++ Build Tools 与 Electron headers 网络访问；详见 README.md。`);
  }
  console.log('开发环境已就绪。运行 npm run dev。');
}

try { await setup(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
