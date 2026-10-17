; Preserve all upstream architecture and resource macros, replace only the final
; payload installation. Preparation already happened before uninstalling anything.
!macroundef extractEmbeddedAppPackage
!macro extractEmbeddedAppPackage
  !insertmacro BerthLog "COPY: copying and verifying prepared files into $INSTDIR"
  ReadEnvStr $BerthOldNodeMode ELECTRON_RUN_AS_NODE
  System::Call 'kernel32::SetEnvironmentVariable(w "ELECTRON_RUN_AS_NODE", w "1")'
  nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\prepared\${APP_EXECUTABLE_FILENAME}" "$PLUGINSDIR\verify-payload.cjs" "$PLUGINSDIR\prepared" "$PLUGINSDIR\installer-payload.json" --copy-to "$INSTDIR"'
  Pop $R0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariable(w "ELECTRON_RUN_AS_NODE", w "$BerthOldNodeMode")'
  ${If} $R0 != 0
    !insertmacro BerthLog "FAILED: payload copy or installed-file verification returned $R0; $1"
    MessageBox MB_OK|MB_ICONSTOP "文件复制或校验失败，请保留日志后重新运行安装包。$\r$\nFile copy or verification failed. Log: $BerthLogPath" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro BerthLog "$1"
!macroend
