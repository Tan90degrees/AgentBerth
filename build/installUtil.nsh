!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\installUtil.nsh"
!macroundef uninstallOldVersion

; Reuse this release's generated uninstaller to remove the previous version.
; Older uninstallers can contain unbounded PowerShell/CIM checks; never invoke
; those during an upgrade. Keep the same application ID, registry and data flags.
!macro uninstallOldVersion ROOT_KEY
  ClearErrors
  StrCpy $R0 0
  !insertmacro readReg $installationDir "${ROOT_KEY}" "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $installationDir != ""
  ${AndIf} ${FileExists} "$installationDir\${APP_EXECUTABLE_FILENAME}"
    File /oname=$PLUGINSDIR\berth-current-uninstaller.exe "${UNINSTALLER_OUT_FILE}"
    ${If} $installMode == "CurrentUser"
    ${OrIf} "${ROOT_KEY}" == "HKEY_CURRENT_USER"
      StrCpy $0 "/currentuser"
    ${Else}
      StrCpy $0 "/allusers"
    ${EndIf}
    ${If} $keepShortcuts == "true"
      StrCpy $0 "$0 --keep-shortcuts"
    ${EndIf}
    !insertmacro BerthLog "UPGRADE: bounded current uninstaller; previous=$installationDir"
    nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\berth-current-uninstaller.exe" /S /KEEP_APP_DATA $0 --updated _?=$installationDir'
    Pop $R0
    Pop $1
    ${If} $R0 != 0
      !insertmacro BerthLog "FAILED: previous-version cleanup returned $R0; $1"
      MessageBox MB_OK|MB_ICONSTOP "旧版本清理未完成（$R0），安装已停止。请保留日志后重试。$\r$\nPrevious-version cleanup failed. Log: $BerthLogPath" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    ClearErrors
  ${EndIf}
  ClearErrors
!macroend
