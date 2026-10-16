import { checkPlugin } from './check';

void checkPlugin(process.argv.slice(2)).catch(error => {
  console.error('检查失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
