[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Prepare', 'Verify')][string]$Phase,
  [Parameter(Mandatory)][string]$InstallDirectory,
  [Parameter(Mandatory)][string]$SourceDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$names = @('windowstash-companion.exe', 'windowstash-native-host.exe')
$retired = @()
function Get-ProgramHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

try {
  $installRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
  if (-not [IO.Path]::IsPathRooted($InstallDirectory) -or $installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\')) {
    throw 'An absolute application installation directory is required.'
  }
  # Never follow a junction into another installation or user storage.
  for ($directory = [IO.DirectoryInfo]$installRoot; $directory; $directory = $directory.Parent) {
    if ($directory.Exists -and ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation directory contains a reparse point.' }
  }
  foreach ($name in $names) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $name) -PathType Leaf)) { throw "Missing installer payload: $name" }
    $destination = Join-Path $installRoot $name
    if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing binary reparse point: $name" }
  }

  if ($Phase -eq 'Prepare') {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $targets = @($names | ForEach-Object { Join-Path $installRoot $_ })
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'windowstash-companion.exe' OR Name = 'windowstash-native-host.exe'" | Where-Object {
      $_.ExecutablePath -and $targets -contains $_.ExecutablePath
    })
    # Select by complete path first; same-name processes elsewhere are never shutdown targets.
    foreach ($process in $processes) {
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
      if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $sid) { throw "Cannot verify current-user ownership of process $($process.ProcessId)." }
    }
    $companions = @($processes | Where-Object Name -eq 'windowstash-companion.exe')
    if ($companions.Count) {
      Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WindowStashInstallerRestart {
  [StructLayout(LayoutKind.Sequential, Pack=4)]
  public struct Application { public uint pid; public System.Runtime.InteropServices.ComTypes.FILETIME created; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmRegisterResources(uint session, uint files, IntPtr names, uint count, Application[] apps, uint services, IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint session, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] static extern int RmRestart(uint session, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
  public static int Close(uint[] ids, long[] starts) {
    var apps = new Application[ids.Length];
    for (int i=0; i<ids.Length; i++) {
      using (var process = Process.GetProcessById((int)ids[i])) {
        long time = process.StartTime.ToFileTimeUtc();
        if (time != starts[i]) throw new InvalidOperationException("Process identity changed during update.");
        apps[i] = new Application { pid=ids[i], created=new System.Runtime.InteropServices.ComTypes.FILETIME { dwLowDateTime=(int)time, dwHighDateTime=(int)(time >> 32) } };
      }
    }
    uint session; int result = RmStartSession(out session, 0, new StringBuilder(33));
    if (result != 0) return result;
    try {
      result = RmRegisterResources(session, 0, IntPtr.Zero, (uint)apps.Length, apps, 0, IntPtr.Zero);
      // Zero means graceful shutdown. Never use RmForceShutdown or terminate a process.
      if (result == 0) result = RmShutdown(session, 0, IntPtr.Zero);
      if (result != 0) RmRestart(session, 0, IntPtr.Zero);
      return result;
    } finally { RmEndSession(session); }
  }
}
'@
      $ids = [uint[]]@($companions | ForEach-Object ProcessId)
      $starts = [long[]]@($companions | ForEach-Object { (Get-Process -Id $_.ProcessId).StartTime.ToFileTimeUtc() })
      $result = [WindowStashInstallerRestart]::Close($ids, $starts)
      if ($result -ne 0) { throw "Companion did not accept normal shutdown (Windows error $result). No forced termination was performed." }
      foreach ($processId in $ids) {
        $remaining = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($remaining -and -not $remaining.WaitForExit(5000)) { throw 'Companion is still running; update stopped before copying files.' }
      }
    }
    # One-shot Hosts may finish normally. Long-lived Chrome watchers have no legacy quit command:
    # retain their image instead of killing a request that could be writing data.
    foreach ($hostProcess in @($processes | Where-Object Name -eq 'windowstash-native-host.exe')) {
      $running = Get-Process -Id $hostProcess.ProcessId -ErrorAction SilentlyContinue
      if ($running) { [void]$running.WaitForExit(500) }
    }
    foreach ($name in $names) {
      $destination = Join-Path $installRoot $name
      if (Test-Path -LiteralPath $destination -PathType Leaf) {
        $backup = "$name.previous-$([guid]::NewGuid().ToString('N')).exe"
        Move-Item -LiteralPath $destination -Destination (Join-Path $installRoot $backup)
        $retired += [pscustomobject]@{ Name = $name; Backup = $backup }
      }
    }
    # Only installer bookkeeping and executable names; never account, workspace or cache paths.
    [IO.File]::WriteAllText((Join-Path $SourceDirectory 'retired.json'), (ConvertTo-Json -InputObject @($retired)), [Text.UTF8Encoding]::new($false))
    Write-Output 'Previous program images retired safely; active Host requests were not terminated.'
  } else {
    foreach ($name in $names) {
      $expected = Get-ProgramHash (Join-Path $SourceDirectory $name)
      $actual = Get-ProgramHash (Join-Path $installRoot $name)
      if ($actual -ne $expected) { throw "Installed $name does not match the bundled payload. Installation is incomplete." }
    }
    # A running old Host retains its previous image until its Chrome connection ends naturally.
    $retired = @(Get-Content -LiteralPath (Join-Path $SourceDirectory 'retired.json') -Raw | ConvertFrom-Json)
    foreach ($entry in $retired) {
      if ($entry.Backup -notmatch '^windowstash-(companion|native-host)\.exe\.previous-[a-f0-9]{32}\.exe$') { throw 'Invalid retired program filename.' }
      try { Remove-Item -LiteralPath (Join-Path $installRoot $entry.Backup) -ErrorAction Stop }
      catch { Write-Output 'Retained previous program image; its connection can finish normally.' }
    }
    Write-Output 'Companion and Native Host SHA-256 verified against the bundled payloads.'
  }
} catch {
  if ($Phase -eq 'Prepare') {
    foreach ($entry in $retired) {
      $destination = Join-Path $installRoot $entry.Name
      if (-not (Test-Path -LiteralPath $destination)) { Move-Item -LiteralPath (Join-Path $installRoot $entry.Backup) -Destination $destination }
    }
  }
  Write-Output "WindowStash update failed: $($_.Exception.Message)"
  exit 20
}
