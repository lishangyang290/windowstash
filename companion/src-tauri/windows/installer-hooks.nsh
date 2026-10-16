; Capture this here: macro expansion otherwise changes __FILEDIR__ to the generated script directory.
!define WINDOWSTASH_HOOK_DIR "${__FILEDIR__}"
Var WindowStashUpdateMutex

!macro WindowStashUpdate phase
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-update.ps1" -Phase ${phase} -InstallDirectory "$INSTDIR" -SourceDirectory "$PLUGINSDIR"'
  Pop $0
  Pop $1
  DetailPrint "$1"
  ${If} $0 != 0
    SetErrorLevel 20
    IfSilent +2
      MessageBox MB_ICONSTOP|MB_OK "WindowStash 更新失败，未清除账号和工作区数据。$\r$\n技术详情：$1"
    Abort "WindowStash 更新失败：$1"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Keep competing installers out until verification (or process exit), not just until preparation ends.
  System::Call 'kernel32::CreateMutexW(p 0, i 1, w "Local\WindowStashInstallerUpdate") p .r0 ?e'
  Pop $1
  StrCpy $WindowStashUpdateMutex $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 20
    Abort "另一个 WindowStash 安装程序正在运行，或无法获取更新锁。"
  ${EndIf}
  InitPluginsDir
  SetOverwrite on
  File "/oname=$PLUGINSDIR\installer-update.ps1" "${WINDOWSTASH_HOOK_DIR}\installer-update.ps1"
  ; These are the exact payloads Tauri copies below, including its NSIS marker on the main binary.
  File "/oname=$PLUGINSDIR\windowstash-companion.exe" "${MAINBINARYSRCPATH}"
  File "/oname=$PLUGINSDIR\windowstash-native-host.exe" "${WINDOWSTASH_HOOK_DIR}\..\binaries\windowstash-native-host-x86_64-pc-windows-msvc.exe"
  !insertmacro WindowStashUpdate Prepare
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WindowStashUpdate Verify
  System::Call 'kernel32::ReleaseMutex(p $WindowStashUpdateMutex)'
  System::Call 'kernel32::CloseHandle(p $WindowStashUpdateMutex)'
!macroend
