$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $repo "release/StackIsle-$version-windows-x64-setup.exe"
$result = Join-Path $repo 'test-results/installer'
[void](New-Item -ItemType Directory -Force $result)
$root = Join-Path $env:TEMP ("berth setup test " + [guid]::NewGuid().ToString())
$target = Join-Path $root ('installed ' + [char]0x4e2d + '\StackIsle')
$exe = Join-Path $target 'StackIsle.exe'
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
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string p,IntPtr a);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string p,uint access,uint share,IntPtr a,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFileAttributesW(string p);
  public static void CreateLongFixture(string root,string folder,string file) {
    foreach(var directory in new[]{root,folder}) {
      if(!CreateDirectoryW(directory,IntPtr.Zero)&&Marshal.GetLastWin32Error()!=183)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    var handle=CreateFileW(file,0x40000000,7,IntPtr.Zero,2,0x80,IntPtr.Zero);
    if(handle==new IntPtr(-1))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    CloseHandle(handle);
  }
  public static bool FileExists(string p) { return GetFileAttributesW(p)!=0xffffffff; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc f, IntPtr p);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("user32.dll",SetLastError=true)] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  [DllImport("kernel32.dll",EntryPoint="SetLastError")] static extern void ClearLastError(uint code);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h,int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  public static string Text(IntPtr h) { var s=new StringBuilder(2048);GetWindowText(h,s,s.Capacity);return s.ToString(); }
  public static IntPtr[] Dialogs() {
    var list=new List<IntPtr>();
    EnumWindows(delegate(IntPtr h,IntPtr p) { var s=new StringBuilder(128);GetClassName(h,s,s.Capacity);if(IsWindowVisible(h)&&s.ToString()=="#32770"&&Text(h).StartsWith("StackIsle"))list.Add(h);return true; },IntPtr.Zero);
    return list.ToArray();
  }
  public static void Click(IntPtr parent,int id) { var b=GetDlgItem(parent,id);if(b!=IntPtr.Zero&&IsWindowEnabled(b))PostMessage(b,0xf5,IntPtr.Zero,IntPtr.Zero); }
  public static IntPtr[] VisibleChecks(IntPtr parent) {
    var list=new List<IntPtr>();
    EnumChildWindows(parent,delegate(IntPtr h,IntPtr p) {
      var name=new StringBuilder(128);GetClassName(h,name,name.Capacity);
      int style=GetWindowLong(h,-16)&15;
      if(IsWindowVisible(h)&&name.ToString().Equals("Button",StringComparison.OrdinalIgnoreCase)&&(style==2||style==3||style==5||style==6))list.Add(h);
      return true;
    },IntPtr.Zero);
    return list.ToArray();
  }
  public static bool UncheckAll(IntPtr parent) {
    var checks=VisibleChecks(parent);
    foreach(var check in checks) {
      ClearLastError(0);SendMessage(check,0xf1,IntPtr.Zero,IntPtr.Zero);
      if(Marshal.GetLastWin32Error()==5)throw new System.ComponentModel.Win32Exception(5);
      if(SendMessage(check,0xf0,IntPtr.Zero,IntPtr.Zero)!=IntPtr.Zero)return false;
    }
    return checks.Length>0;
  }
  public static string DescribeChecks(IntPtr parent) {
    var s=new StringBuilder();foreach(var check in VisibleChecks(parent))s.AppendLine(Text(check)+": checked="+SendMessage(check,0xf0,IntPtr.Zero,IntPtr.Zero));return s.ToString();
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
function Live-AppPids {
  foreach ($process in (@([Diagnostics.Process]::GetProcessesByName('StackIsle')) + @([Diagnostics.Process]::GetProcessesByName('AgentBerth')))) {
    try { if (!$process.HasExited) { $process.Id } } finally { $process.Dispose() }
  }
}
function Trace-AppProcesses([string]$stage) {
  foreach ($process in (@([Diagnostics.Process]::GetProcessesByName('StackIsle')) + @([Diagnostics.Process]::GetProcessesByName('AgentBerth')))) {
    try { Write-Host "$stage PID=$($process.Id) exited=$($process.HasExited) started=$($process.StartTime.ToUniversalTime().ToString('o')) title=$($process.MainWindowTitle)" } finally { $process.Dispose() }
  }
}
function Wait-Until([scriptblock]$check, [string]$message, [int]$seconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    if (& $check) { return }
    foreach ($log in Logs) {
      $failures = @($log.Text -split '\r?\n' | Where-Object { $_ -match '^\[\d+ ms\] FAILED:' })
      if ($failures.Count -gt 0) { throw "Installer reported failure: $($failures[-1]); log: $($log.Path)" }
    }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $message
}
function Logs {
  foreach ($file in Get-ChildItem (Join-Path $env:TEMP "StackIsle-setup-$version-*.log") -ErrorAction SilentlyContinue) {
    # Adjacent cases can start less than a second apart. Including older logs
    # lets Drive-To mistake the previous install's stage for this one's.
    if ($file.LastWriteTimeUtc -ge $script:caseStart) {
      $stream = $null
      $reader = $null
      try {
        # ReadAllText uses FileShare.Read, which can deny the installer's
        # concurrent FileOpen-for-append and silently lose a completion line.
        $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
        $stream = [IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,$sharing)
        $reader = [IO.StreamReader]::new($stream,[Text.Encoding]::Unicode,$true)
        [pscustomobject]@{ Path=$file.FullName; Text=$reader.ReadToEnd() }
      } catch {} finally {
        if ($reader) { $reader.Dispose() } elseif ($stream) { $stream.Dispose() }
      }
    }
  }
}
function Has-Log([string]$text) { return @((Logs) | Where-Object { $_.Text.Contains($text) }).Count -gt 0 }
function Start-Setup([bool]$silent = $false, [string]$scope = '/currentuser') {
  $script:caseStart = [DateTime]::UtcNow
  $arguments = $scope + ' ' + $(if ($silent) { '/S ' } else { '' }) + '/D=' + $target
  $process=Start-Process -FilePath $installer -ArgumentList $arguments -PassThru
  [void]$process.Handle
  Write-Host "Started installer PID $($process.Id), case started $($script:caseStart.ToString('o'))"
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
  # Electron is a Windows GUI executable even in Node mode. PowerShell 5.1's
  # call operator can return before it exits, leaving LASTEXITCODE unchanged.
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $exe
  $info.Arguments = '"' + (Join-Path $repo 'build/verify-payload.cjs') + '" "' + $target + '" "' + (Join-Path $repo 'dist/installer-payload.json') + '"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  $process = [Diagnostics.Process]::Start($info)
  try {
    [void]$process.Handle
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    Assert ($process.WaitForExit(60000)) 'Installed payload verification timed out after 60 seconds'
    $process.WaitForExit()
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    Write-Host $output
    if ($errors) { Write-Host $errors }
    Assert ($process.ExitCode -eq 0) "Installed payload differs from built payload (verifier exit $($process.ExitCode))"
  } finally {
    # Finish our verifier before the suite is allowed to remove its directory.
    if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
  }
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
  Trace-AppProcesses 'After fresh install'
  Write-Host 'Installer smoke: upgrade an installation with legacy AgentBerth filenames'
  Move-Item $exe (Join-Path $target 'AgentBerth.exe')
  Move-Item (Join-Path $target 'Uninstall StackIsle.exe') (Join-Path $target 'Uninstall AgentBerth.exe')
  $active = Start-Setup $true
  Wait-Exit $active 0
  Assert (Has-Log 'UPGRADE: bounded current uninstaller') 'Legacy executable did not trigger upgrade cleanup'
  Assert (!(Test-Path (Join-Path $target 'AgentBerth.exe'))) 'Upgrade left the legacy executable'
  Verify-Installed

  # Simulate legacy native-build files independently of current package filters.
  $legacyRoot = $target + '\legacy native cache'
  $legacyFolder = $legacyRoot + '\' + ('x' * 140)
  $legacyFile = '\\?\' + $legacyFolder + '\state.bin'
  Assert ($legacyFile.Length -gt 264) 'Legacy cleanup fixture does not exceed MAX_PATH'
  [SetupUi]::CreateLongFixture(('\\?\' + $legacyRoot),('\\?\' + $legacyFolder),$legacyFile)
  Assert ([SetupUi]::FileExists($legacyFile)) 'Long legacy file was not created'
  $beforeHash = (Get-FileHash $exe).Hash
  $sentinel = Join-Path $target 'preserve-on-cancel.txt'; Set-Content $sentinel 'retain old installation'
  $oldUninstaller = Join-Path $target 'Uninstall StackIsle.exe'
  Set-Content $oldUninstaller 'Legacy uninstaller MUST NOT execute'

  Write-Host 'Installer smoke: cancel upgrade preserves old executable, uninstaller and files'
  $active = Start-Setup
  Cancel-Preparation $true
  Wait-Exit $active 1 15
  Assert ((Get-FileHash $exe).Hash -eq $beforeHash) 'Cancel changed the old executable'
  Assert (Test-Path $sentinel) 'Cancel removed an existing file'
  Assert ((Get-Content $oldUninstaller -Raw).Contains('MUST NOT execute')) 'Cancel replaced the old uninstaller'
  Assert ([SetupUi]::FileExists($legacyFile)) 'Cancel removed the long legacy file'

  Write-Host 'Installer smoke: a genuinely locked file fails safely and restores the old payload'
  $locked = [IO.File]::Open((Join-Path $target 'resources/app.asar'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try {
    $active = Start-Setup $true
    Wait-Exit $active 2
    Assert (Has-Log 'FAILED: cannot move installed file:') 'Locked-file failure does not identify the file'
  } finally { $locked.Dispose() }
  Verify-Installed
  Assert (Test-Path $sentinel) 'Failed cleanup removed an existing user file'
  Assert ([SetupUi]::FileExists($legacyFile)) 'Failed cleanup did not restore the long legacy file'
  Trace-AppProcesses 'After rollback'

  Write-Host 'Installer smoke: declining cancel resumes and uses current bounded uninstaller'
  $active = Start-Setup
  Cancel-Preparation $false
  Wait-Until { Has-Log 'COMPLETED:' } 'Install did not resume after declining cancel' 90
  Wait-Until {
    Assert (!$active.HasExited) 'Installer exited before the finish-page options could be reviewed'
    foreach ($window in [SetupUi]::Dialogs()) {
      # Both Run and Open log must exist: Run's default state has then been set.
      if ([SetupUi]::VisibleChecks($window).Length -ge 2) {
        Write-Host "Finish options before: $([SetupUi]::DescribeChecks($window))"
        Assert ([SetupUi]::UncheckAll($window)) 'Finish-page options could not be cleared'
        Write-Host "Finish options after: $([SetupUi]::DescribeChecks($window))"
        [SetupUi]::Capture($window,(Join-Path $result 'completed.png'))
        [SetupUi]::Click($window,1)
        return $true
      }
      # MUI's finish-page macro enables AutoCloseWindow: the progress page
      # advances itself. Clicking Next here can land on the new Finish button.
    }
    return $false
  } 'Finish page did not become ready' 15
  Wait-Exit $active 0 15
  Assert (!(Test-Path $sentinel)) 'Old cleanup did not run'
  Assert (![SetupUi]::FileExists($legacyFile)) 'Upgrade left the long legacy file'
  Verify-Installed
  Trace-AppProcesses 'After finish'

  Write-Host 'Installer smoke: running background app blocks silently and remains alive'
  Assert (@(Live-AppPids).Count -eq 0) 'Finish page unexpectedly launched an application'
  $ready = Join-Path $root 'ready'
  $idle = Join-Path $root 'idle.cjs'
  $readyJson = ConvertTo-Json $ready -Compress
  [IO.File]::WriteAllText($idle,"require('node:fs').writeFileSync($readyJson,'ready');setInterval(()=>{},1000);")
  $info = New-Object Diagnostics.ProcessStartInfo
  $legacyExe = Join-Path $target 'AgentBerth.exe'
  Copy-Item $exe $legacyExe
  $info.FileName=$legacyExe; $info.Arguments='"'+$idle+'"'; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
  $helper = [Diagnostics.Process]::Start($info)
  Wait-Until { Test-Path $ready } 'Background fixture did not start'
  $active = Start-Setup $true
  Wait-Exit $active 2 15
  Assert (!$helper.HasExited) 'Installer killed the running background app'
  Assert (Has-Log 'CANCELLED: application still running') 'Silent running-app failure did not log its reason'
  $active = Start-Setup
  Drive-To 'WAITING: application running'
  # The log is written before MessageBox creates its controls.
  Wait-Until {
    foreach ($window in [SetupUi]::Dialogs()) {
      if ([SetupUi]::GetDlgItem($window,4) -ne [IntPtr]::Zero -and [SetupUi]::IsWindowEnabled([SetupUi]::GetDlgItem($window,2))) {
        [SetupUi]::Click($window,2)
        return $true
      }
    }
    return $false
  } 'Running-application warning did not become ready' 5
  Wait-Exit $active 2 15
  Assert (!$helper.HasExited) 'Interactive cancel killed the running background app'
  Write-Host "Stopping background fixture PID $($helper.Id)"
  $helper.Kill(); $helper.WaitForExit(); $helper.Dispose(); $helper=$null
  Wait-Until { @(Live-AppPids).Count -eq 0 } 'Background fixture did not fully exit' 5

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
  Write-Host 'Installer smoke passed: byte percentage, logs, safe cancellation, locked-file rollback, long-path upgrade, running-app protection and both uninstall scopes'
} catch {
  Trace-AppProcesses 'Failure'
  Write-Host "Remaining live StackIsle PIDs: $(@(Live-AppPids) -join ', ')"
  foreach($window in [SetupUi]::Dialogs()){ try{ [SetupUi]::Capture($window,(Join-Path $result 'failure.png')) }catch{} }
  foreach($log in Logs){ Write-Host $log.Path; Write-Host $log.Text }
  throw
} finally {
  if($helper){if(!$helper.HasExited){$helper.Kill();$helper.WaitForExit()};$helper.Dispose()}
  foreach($log in Get-ChildItem (Join-Path $env:TEMP "StackIsle-setup-$version-*.log") -ErrorAction SilentlyContinue){ if($log.LastWriteTimeUtc -ge $suiteStart.AddSeconds(-1)){Copy-Item $log.FullName $result -Force} }
  if($active -and !$active.HasExited){$active.Kill();$active.WaitForExit()}
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
