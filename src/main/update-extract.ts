import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const execute = promisify(execFile);

// Use the system PowerShell/.NET ZIP reader; no extra runtime is installed.
// Validate every entry before writing, and use extended Windows paths.
export const extractScript = String.raw`param([string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
function LongPath([string]$p) {
  $p = [IO.Path]::GetFullPath($p)
  if ($p.StartsWith('\\?\')) { return $p }
  if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }
  return '\\?\' + $p
}
$root = LongPath $Destination
$inputFile = [IO.File]::OpenRead((LongPath $Archive))
try {
  $zip = New-Object IO.Compression.ZipArchive($inputFile, [IO.Compression.ZipArchiveMode]::Read)
  try {
    if ($zip.Entries.Count -gt 25000) { throw 'Too many update entries' }
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($name.StartsWith('/') -or $name.Contains(':') -or $name.Length -gt 1024) { throw 'Invalid update path' }
      $folder = $name.EndsWith('/'); $name = $name.TrimEnd('/')
      if (!$name -or !$seen.Add($name)) { throw 'Duplicate update path' }
      foreach ($part in $name.Split('/')) {
        if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>:"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Invalid update path' }
      }
      $unixType = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixType -eq 0xA000) { throw 'Links are not allowed in updates' }
      $total += $entry.Length
      if ($total -gt 4294967296) { throw 'Update is too large' }
    }
    foreach ($entry in $zip.Entries) {
      $target = $root + '\' + $entry.FullName.Replace('/', '\').TrimEnd('\')
      if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
      $source = $entry.Open()
      try {
        $output = New-Object IO.FileStream($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $source.CopyTo($output) } finally { $output.Dispose() }
      } finally { $source.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $inputFile.Dispose() }
`;
export async function extractUpdate(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'win32') throw new Error('软件内更新目前支持 Windows 安装包和 ZIP 版');
  const script = path.join(path.dirname(destination), `extract-${randomUUID()}.ps1`);
  await writeFile(script, '\uFEFF' + extractScript, { flag: 'wx', mode: 0o600 });
  try {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Archive', archive, '-Destination', destination], { windowsHide: true, signal, timeout: 300000, maxBuffer: 1024 * 1024 });
  } finally { await rm(script, { force: true }); }
}
