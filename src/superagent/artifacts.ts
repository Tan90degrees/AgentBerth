export function artifactPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const paths = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || Buffer.byteLength(item) > 512 || /[:\x00-\x1f\x7f]/.test(item)) continue;
    const relative = item.replaceAll('\\', '/').replace(/^\.\//, '');
    if (relative.split('/').some(part => !part || part === '..' || part.startsWith('.') || /[. ]$/.test(part))) continue;
    paths.add(relative);
    if (paths.size === 20) break;
  }
  return [...paths];
}
