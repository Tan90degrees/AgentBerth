; Preserve all upstream architecture and resource macros, replace only the final
; payload installation. Preparation already happened before uninstalling anything.
!macroundef extractEmbeddedAppPackage
!macro extractEmbeddedAppPackage
  !insertmacro BerthLog "COPY: copying prepared staging files into $INSTDIR"
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\prepared\*" "$INSTDIR"
  ${If} ${Errors}
    !insertmacro BerthLog "FAILED: cannot copy staged files; check free space and permissions"
    MessageBox MB_OK|MB_ICONSTOP "无法写入安装目录，请检查磁盘空间和权限后重新运行安装包。$\r$\nCannot write installation files. Log: $BerthLogPath" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
