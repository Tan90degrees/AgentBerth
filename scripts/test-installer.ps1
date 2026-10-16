$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $repo "release/AgentBerth-$version-windows-x64-setup.exe"
$result = Join-Path $repo 'test-results/installer'
[void](New-Item -ItemType Directory -Force $result)
$root = Join-Path $env:TEMP ("berth setup test " + [guid]::NewGuid().ToString())
$target = Join-Path $root ('installed ' + [char]0x4e2d + '\AgentBerth')
$exe = Join-Path $target 'AgentBerth.exe'
$helper = $null
$active = $null
$script:caseStart = [DateTime]::UtcNow
$suiteStart = $script:caseStart

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Drawing;
public class SetupUi {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  public static string Text(IntPtr h) { var s=new StringBuilder(2048);GetWindowText(h,s,s.Capacity);return s.ToString(); }
  public static IntPtr[] Dialogs() {
    var list=new List<IntPtr>();
    EnumWindows(delegate(IntPtr h,IntPtr p) { var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);if(IsWindowVisible(h)&&s.ToString()=="#32770"&&Text(h).StartsWith("AgentBerth"))list.Add(h);return true; },IntPtr.Zero);
    return list.ToArray();
  }
  public static void Click(IntPtr parent,int id) { var b=GetDlgItem(parent,id);if(b!=IntPtr.Zero&&IsWindowEnabled(b))PostMessage(b,0xf5,IntPtr.Zero,IntPtr.Zero); }
  public static void UncheckAll(IntPtr parent) {
    EnumChildWindows(parent,delegate(IntPtr h,IntPtr p) { if((GetWindowLong(h,-16)&15)==3)SendMessage(h,0xf1,IntPtr.Zero,IntPtr.Zero);return true; },IntPtr.Zero);
  }
  public static string ChildText(IntPtr parent) {
    var s=new StringBuilder();EnumChildWindows(parent,delegate(IntPtr h,IntPtr p){s.AppendLine(Text(h));return true;},IntPtr.Zero);return s.ToString();
  }
  public static bool DetailsVisible(IntPtr parent) {
    bool found=false;EnumChildWindows(parent,delegate(IntPtr h,IntPtr p){var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);if(s.ToString()=="SysListView32"&&IsWindowVisible(h))found=true;return true;},IntPtr.Zero);return found;
  }
  public static void Capture(IntPtr h,string file) {
    Rect r;if(!GetWindowRect(h,out r)||r.R<=r.L||r.B<=r.T)return;
    using(var image=new Bitmap(r.R-r.L,r.B-r.T))using(var g=Graphics.FromImage(image)) { var dc=g.GetHdc();try{PrintWindow(h,dc,2);}finally{g.ReleaseHdc(dc);}image.Save(file); }
  }
}
'@

function Assert($condition, $message) { if (!$condition) { throw $message } }
function Wait-Until([scriptblock]$check, [string]$message, [int]$seconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do { if (& $check) { return }; Start-Sleep -Milliseconds 25 } while ([DateTime]::UtcNow -lt $deadline)
  throw $message
}
function Logs {
  foreach ($file in Get-ChildItem (Join-Path $env:TEMP "AgentBerth-setup-$version-*.log") -ErrorAction SilentlyContinue) {
    if ($file.LastWriteTimeUtc -ge $script:caseStart.AddSeconds(-1)) {
      try { [pscustomobject]@{ Path=$file.FullName; Text=[IO.File]::ReadAllText($file.FullName,[Text.Encoding]::Unicode) } } catch {}
    }
  }
}
function Has-Log([string]$text) { return @((Logs) | Where-Object { $_.Text.Contains($text) }).Count -gt 0 }
function Start-Setup([bool]$silent = $false, [string]$scope = '/currentuser') {
  $script:caseStart = [DateTime]::UtcNow
  $arguments = $scope + ' ' + $(if ($silent) { '/S ' } else { '' }) + '/D=' + $target
  $process=Start-Process -FilePath $installer -ArgumentList $arguments -PassThru
  [void]$process.Handle
  return $process
}
function Wait-Exit($process, [int]$expected, [int]$seconds = 90) {
  Assert ($process.WaitForExit($seconds * 1000)) 'Installer process did not exit before timeout'
  $process.WaitForExit()
  Assert ($process.ExitCode -eq $expected) "Unexpected installer exit code $($process.ExitCode), expected $expected"
}
function Drive-To([string]$stage) {
  Wait-Until {
    if (Has-Log $stage) { return $true }
    foreach ($window in [SetupUi]::Dialogs()) {
      if ([SetupUi]::GetDlgItem($window,1) -ne [IntPtr]::Zero) { [SetupUi]::Click($window,1) }
    }
    Start-Sleep -Milliseconds 75
    return $false
  } "Installer did not reach $stage" 45
}
function Answer-Abort([bool]$yes) {
  $script:abortWindow = [IntPtr]::Zero
  Wait-Until {
    foreach ($window in [SetupUi]::Dialogs()) {
      if ([SetupUi]::GetDlgItem($window,6) -ne [IntPtr]::Zero) { $script:abortWindow=$window; return $true }
    }
    return $false
  } 'Cancel confirmation did not appear' 5
  [SetupUi]::Capture($script:abortWindow,(Join-Path $result ('cancel-' + $yes + '.png')))
  foreach($window in [SetupUi]::Dialogs()) {
    if([SetupUi]::GetDlgItem($window,1) -ne [IntPtr]::Zero){
      Assert ([SetupUi]::DetailsVisible($window)) 'Installation details are hidden'
      Assert ([SetupUi]::ChildText($window).Contains('Preparing files:')) 'Byte percentage is not visible in the installer'
      [SetupUi]::Capture($window,(Join-Path $result ('progress-' + $yes + '.png')))
    }
  }
  [SetupUi]::Click($script:abortWindow,$(if($yes){6}else{7}))
}
function Cancel-Preparation([bool]$yes) {
  Drive-To 'Preparing files:'
  Assert (!(Has-Log 'COMMIT:')) 'Preparation completed before cancel could be tested'
  foreach ($window in [SetupUi]::Dialogs()) {
    if ([SetupUi]::GetDlgItem($window,1) -ne [IntPtr]::Zero) {
      Assert ([SetupUi]::IsWindowEnabled([SetupUi]::GetDlgItem($window,2))) 'Cancel is disabled during preparation'
      [SetupUi]::Click($window,2)
    }
  }
  Answer-Abort $yes
}
function Verify-Installed {
  $old = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $exe (Join-Path $repo 'build/verify-payload.cjs') $target (Join-Path $repo 'dist/installer-payload.json')
    Assert ($LASTEXITCODE -eq 0) 'Installed payload differs from built payload'
  } finally { $env:ELECTRON_RUN_AS_NODE = $old }
}

try {
  Write-Host 'Installer smoke: cancel fresh preparation without installing partial files'
  $active = Start-Setup
  Cancel-Preparation $true
  Wait-Exit $active 1 15
  Assert (!(Test-Path $exe)) 'Cancelled fresh install left an executable'
  Assert (Has-Log 'CANCELLED: before commit') 'Cancellation log is missing'

  Write-Host 'Installer smoke: fresh silent install and full payload verification'
  $active = Start-Setup $true
  Wait-Exit $active 0
  Assert (Has-Log 'COMPLETED:') 'Completion log is missing'
  Assert (Has-Log '100%') 'Byte percentage is missing'
  Assert (Has-Log 'VERIFIED:') 'Staged inventory verification is missing'
  Verify-Installed
  $beforeHash = (Get-FileHash $exe).Hash
  $sentinel = Join-Path $target 'preserve-on-cancel.txt'; Set-Content $sentinel 'retain old installation'
  $oldUninstaller = Join-Path $target 'Uninstall AgentBerth.exe'
  Set-Content $oldUninstaller 'Legacy uninstaller MUST NOT execute'

  Write-Host 'Installer smoke: cancel upgrade preserves old executable, uninstaller and files'
  $active = Start-Setup
  Cancel-Preparation $true
  Wait-Exit $active 1 15
  Assert ((Get-FileHash $exe).Hash -eq $beforeHash) 'Cancel changed the old executable'
  Assert (Test-Path $sentinel) 'Cancel removed an existing file'
  Assert ((Get-Content $oldUninstaller -Raw).Contains('MUST NOT execute')) 'Cancel replaced the old uninstaller'

  Write-Host 'Installer smoke: declining cancel resumes and uses current bounded uninstaller'
  $active = Start-Setup
  Cancel-Preparation $false
  Wait-Until { Has-Log 'COMPLETED:' } 'Install did not resume after declining cancel' 90
  Wait-Until {
    if($active.HasExited){return $true}
    foreach ($window in [SetupUi]::Dialogs()) { [SetupUi]::UncheckAll($window); [SetupUi]::Capture($window,(Join-Path $result 'completed.png')); [SetupUi]::Click($window,1) }
    Start-Sleep -Milliseconds 75
    return $false
  } 'Finish page did not close' 15
  Wait-Exit $active 0 15
  Assert (!(Test-Path $sentinel)) 'Old cleanup did not run'
  Verify-Installed

  Write-Host 'Installer smoke: running background app blocks silently and remains alive'
  $ready = Join-Path $root 'ready'
  $idle = Join-Path $root 'idle.cjs'
  $readyJson = ConvertTo-Json $ready -Compress
  [IO.File]::WriteAllText($idle,"require('node:fs').writeFileSync($readyJson,'ready');setInterval(()=>{},1000);")
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName=$exe; $info.Arguments='"'+$idle+'"'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
  $helper = [Diagnostics.Process]::Start($info)
  Wait-Until { Test-Path $ready } 'Background fixture did not start'
  $active = Start-Setup $true
  Wait-Exit $active 2 15
  Assert (!$helper.HasExited) 'Installer killed the running background app'
  Assert (Has-Log 'CANCELLED: application still running') 'Silent running-app failure did not log its reason'
  $active = Start-Setup
  Drive-To 'WAITING: application running'
  foreach ($window in [SetupUi]::Dialogs()) { if([SetupUi]::GetDlgItem($window,4) -ne [IntPtr]::Zero){ [SetupUi]::Click($window,2) } }
  Wait-Exit $active 2 15
  Assert (!$helper.HasExited) 'Interactive cancel killed the running background app'
  $helper.Kill(); $helper.WaitForExit(); $helper=$null

  Write-Host 'Installer smoke: silent uninstall with new native process check'
  $active = Start-Process $oldUninstaller -ArgumentList ("/S _?=" + $target) -PassThru
  Wait-Exit $active 0
  Assert (!(Test-Path $exe)) 'Uninstall left the executable'
  Write-Host 'Installer smoke: all-users install and uninstall'
  $active = Start-Setup $true '/allusers'
  Wait-Exit $active 0
  Verify-Installed
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $registry.OpenSubKey('Software\cb3a0d82-5491-53a3-b6c8-37e7324e8dd4')
    Assert ($null -ne $key) 'All-users installation registry entry is missing'
    try { Assert ($key.GetValue('InstallLocation') -eq $target) 'All-users install used the wrong directory' } finally { $key.Dispose() }
  } finally { $registry.Dispose() }
  $active = Start-Process $oldUninstaller -ArgumentList ("/S /allusers _?=" + $target) -PassThru
  Wait-Exit $active 0
  Assert (!(Test-Path $exe)) 'All-users uninstall left the executable'
  Write-Host 'Installer smoke passed: real byte percentage, persistent logs, safe fresh/upgrade cancel, decline/resume, bounded upgrade and running-app protection'
} catch {
  foreach($window in [SetupUi]::Dialogs()){ try{ [SetupUi]::Capture($window,(Join-Path $result 'failure.png')) }catch{} }
  foreach($log in Logs){ Write-Host $log.Path; Write-Host $log.Text }
  throw
} finally {
  if($helper -and !$helper.HasExited){$helper.Kill();$helper.WaitForExit()}
  foreach($log in Get-ChildItem (Join-Path $env:TEMP "AgentBerth-setup-$version-*.log") -ErrorAction SilentlyContinue){ if($log.LastWriteTimeUtc -ge $suiteStart.AddSeconds(-1)){Copy-Item $log.FullName $result -Force} }
  if($active -and !$active.HasExited){$active.Kill();$active.WaitForExit()}
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
