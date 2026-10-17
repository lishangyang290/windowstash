param([Parameter(Mandatory)][string]$ParentIds)
$ErrorActionPreference = 'Stop'
$parents = @($ParentIds.Split(',') | ForEach-Object { [uint32]$_ })
$children = @(Get-CimInstance Win32_Process -Filter "Name = 'curl.exe'" | Where-Object { $parents -contains $_.ParentProcessId })
if ($children.Count -ne 1) { throw "Expected one active authentication curl, found $($children.Count)." }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowStashConsoleProbe {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
[void][WindowStashConsoleProbe]::FreeConsole()
$attached = [WindowStashConsoleProbe]::AttachConsole($children[0].ProcessId)
$code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
$window = [IntPtr]::Zero
$visible = $false
# CREATE_NO_WINDOW may still allow attachment to a headless console; check the window itself.
if ($attached) {
    $window = [WindowStashConsoleProbe]::GetConsoleWindow()
    $visible = [WindowStashConsoleProbe]::IsWindowVisible($window)
    [void][WindowStashConsoleProbe]::FreeConsole()
    $code = 0
}
@{
    pid = $children[0].ProcessId
    parentPid = $children[0].ParentProcessId
    executable = $children[0].ExecutablePath
    consoleAttached = $attached
    error = $code
    window = $window.ToInt64()
    visible = $visible
} | ConvertTo-Json -Compress
