; AgentBerth installer extensions for electron-builder 26.15.3.
; Keep the upstream wizard, registry, shortcut and signed-uninstaller machinery.
!include LogicLib.nsh
!include FileFunc.nsh
!include nsDialogs.nsh
!include WinMessages.nsh

Var BerthLogPath
Var BerthLogHandle
Var BerthMessage
Var BerthStartTick
!ifndef BUILD_UNINSTALLER
  Var BerthStage
  Var BerthAbortDecision
  Var BerthProgress
  Var BerthCallback
  Var BerthOldNodeMode
  Var packageArch
!endif

!ifdef BUILD_UNINSTALLER
  !define BerthPrefix "un."
!else
  !define BerthPrefix ""
  !define MUI_CUSTOMFUNCTION_ABORT BerthAbort
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION BerthOpenLog
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "查看安装日志 / Open setup log"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!endif

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW BerthShowProgress
!macroend

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
  !addincludedir "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis"
  !cd "${BUILD_RESOURCES_DIR}"
  !ifndef BUILD_UNINSTALLER
    !include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\extractAppPackage.nsh"
  !endif

Function ${BerthPrefix}BerthLog
  Push $0
  ${If} $BerthLogPath == ""
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $BerthLogPath "$TEMP\AgentBerth-setup-${VERSION}-$0.log"
    System::Call 'kernel32::GetTickCount() i.r0'
    StrCpy $BerthStartTick $0
    ClearErrors
    FileOpen $BerthLogHandle "$BerthLogPath" w
    ${IfNot} ${Errors}
      FileWriteUTF16LE /BOM $BerthLogHandle "AgentBerth ${VERSION}$\r$\n"
      FileClose $BerthLogHandle
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetTickCount() i.r0'
  IntOp $0 $0 - $BerthStartTick
  ClearErrors
  FileOpen $BerthLogHandle "$BerthLogPath" a
  ${IfNot} ${Errors}
    FileWriteUTF16LE $BerthLogHandle "[$0 ms] $BerthMessage$\r$\n"
    FileClose $BerthLogHandle
  ${EndIf}
  SetDetailsPrint both
  DetailPrint "$BerthMessage"
  Pop $0
FunctionEnd

!ifndef BUILD_UNINSTALLER
  Function BerthShowProgress
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 1
    SetDetailsView show
    !insertmacro BerthLog "日志 / Log: $BerthLogPath"
  FunctionEnd
  Function BerthAbort
    ${If} $BerthStage == "commit"
      Abort
    ${EndIf}
    StrCpy $BerthAbortDecision "1"
    MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "停止安装并保留原版本？$\r$\nStop setup and keep the existing version?" IDYES berth_abort_confirmed
    StrCpy $BerthAbortDecision "0"
    Abort
    berth_abort_confirmed:
      !insertmacro BerthLog "CANCELLED: before commit; existing installation retained"
      SetErrorLevel 1
      Quit
  FunctionEnd
  Function BerthExtractProgress
    ; Nsis7z passes completed and total bytes to its callback. Its progress bar
    ; remains byte-based; Int64 arithmetic avoids overflow on large payloads.
    Pop $R8
    Pop $R9
    Push $0
    ${If} $R9 > 0
      System::Int64Op $R8 * 100
      Pop $0
      System::Int64Op $0 / $R9
      Pop $0
      ${If} $0 != $BerthProgress
        StrCpy $BerthProgress $0
        !insertmacro BerthLog "准备文件 / Preparing files: $0% ($R8 / $R9 bytes)"
      ${EndIf}
    ${EndIf}
    Pop $0
  FunctionEnd
  Function BerthPreparePayload
    StrCpy $BerthStage "prepare"
    !insertmacro BerthLog "PREPARE: extracting into temporary staging; target=$INSTDIR"
    InitPluginsDir
    !ifdef COMPRESS
      SetCompress off
    !endif
    !insertmacro identify_package
    !insertmacro compute_files_for_current_arch
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    SetOutPath "$PLUGINSDIR\prepared"
    GetFunctionAddress $BerthCallback BerthExtractProgress
    Nsis7z::ExtractWithCallback "$PLUGINSDIR\app-$packageArch.7z" $BerthCallback
    ${DoWhile} $BerthAbortDecision == "1"
      Sleep 50
    ${Loop}
    ${IfNot} ${FileExists} "$PLUGINSDIR\prepared\${APP_EXECUTABLE_FILENAME}"
    ${OrIfNot} ${FileExists} "$PLUGINSDIR\prepared\resources\app.asar"
      !insertmacro BerthLog "FAILED: incomplete staged payload; existing installation retained"
      MessageBox MB_OK|MB_ICONSTOP "文件准备失败，原版本已保留。$\r$\nPayload preparation failed. Log: $BerthLogPath" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $BerthStage "commit"
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 0
    !insertmacro BerthLog "VERIFY: 校验准备文件 / Verifying staged files"
    File /oname=$PLUGINSDIR\verify-payload.cjs "${BUILD_RESOURCES_DIR}\verify-payload.cjs"
    File /oname=$PLUGINSDIR\installer-payload.json "${PROJECT_DIR}\dist\installer-payload.json"
    ReadEnvStr $BerthOldNodeMode ELECTRON_RUN_AS_NODE
    System::Call 'kernel32::SetEnvironmentVariable(w "ELECTRON_RUN_AS_NODE", w "1")'
    nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\prepared\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\verify-payload.cjs" "$PLUGINSDIR\prepared" "$PLUGINSDIR\installer-payload.json"'
    Pop $R0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariable(w "ELECTRON_RUN_AS_NODE", w "$BerthOldNodeMode")'
    ${If} $R0 != 0
      !insertmacro BerthLog "FAILED: payload verification returned $R0; $1; existing installation retained"
      MessageBox MB_OK|MB_ICONSTOP "文件校验失败，原版本已保留。$\r$\nPayload verification failed. Log: $BerthLogPath" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro BerthLog "$1"
    !insertmacro BerthLog "COMMIT: 文件准备完成，正在替换文件和创建快捷方式 / Finishing installation"
    SetOutPath "$INSTDIR"
  FunctionEnd
  Function BerthEnsurePrepared
    ; The upstream assisted installer skips CHECK_APP_RUNNING in the elevated
    ; UAC child. Stage there too, before either old-install cleanup can run.
    ${If} $BerthStage != "commit"
      !insertmacro customCheckAppRunning
    ${EndIf}
  FunctionEnd
  Function BerthOpenLog
    Exec '"$SYSDIR\notepad.exe" "$BerthLogPath"'
  FunctionEnd
  Function .onInstFailed
    !insertmacro BerthLog "FAILED: installation did not complete; target=$INSTDIR"
  FunctionEnd
!endif
!macroend

!macro BerthLog TEXT
  StrCpy $BerthMessage "${TEXT}"
  Call ${BerthPrefix}BerthLog
!macroend

!macro customCheckAppRunning
  !insertmacro BerthLog "检查运行中的 AgentBerth / Checking running application"
  berth_check_running:
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 == 0
      !insertmacro BerthLog "WAITING: application running; 请从托盘退出后重试；安装器不会强制停止会话。"
      MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "AgentBerth 仍在运行（可能在托盘中）。$\r$\n请先从托盘退出，终端停止后点重试；或点取消保留当前版本。$\r$\n$\r$\nAgentBerth is running. Exit it from the tray, then Retry, or Cancel setup.$\r$\n日志 / Log: $BerthLogPath" /SD IDCANCEL IDRETRY berth_check_running
      !insertmacro BerthLog "CANCELLED: application still running; existing files retained"
      SetErrorLevel 2
      Quit
    ${ElseIf} $R0 != 603
      ; nsProcess returns 603 when no matching process exists. Do not interpret
      ; an enumeration failure as permission to overwrite a live installation.
      !insertmacro BerthLog "FAILED: process check returned $R0"
      MessageBox MB_OK|MB_ICONSTOP "无法检查运行中的 AgentBerth（$R0）。$\r$\nCannot check running application. Log: $BerthLogPath" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  !ifndef BUILD_UNINSTALLER
    Call BerthPreparePayload
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInit
    StrCpy $BerthStage "wizard"
    StrCpy $BerthAbortDecision "0"
    StrCpy $BerthProgress "-1"
    !insertmacro BerthLog "START: install wizard"
    !insertmacro BerthLog "日志 / Log: $BerthLogPath"
    ; Preserve a reference to the upstream compatibility function. The wrapper
    ; calls our bounded, current uninstaller rather than old WMI-based binaries.
    GetFunctionAddress $0 uninstallOldVersion
  !macroend
  !macro customInstall
    StrCpy $BerthStage "complete"
    !insertmacro BerthLog "COMPLETED: installed ${VERSION}; target=$INSTDIR"
    !insertmacro BerthLog "日志 / Log: $BerthLogPath"
  !macroend

!endif
