; Never replace an MSI-managed installation with NSIS. No user-data operations.
!macro customInit
  EnumRegKey $0 HKCU "Software\PaperEcho\Installer\Packages" 0
  ${If} $0 != ""
    MessageBox MB_OK|MB_ICONSTOP "An MSI-managed PaperEcho installation exists. Back up your data and uninstall the MSI manually before using this installer. No changes have been made."
    Abort
  ${EndIf}
!macroend

; Upgrades keep the task; the next normal launch repairs its path/definition.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    ClearErrors
    ExecWait '"$INSTDIR\PaperEcho.exe" --headless --schedule-remove-installation' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "PaperEcho could not confirm removal of its scheduled tasks. Close any running PaperEcho task and retry uninstall. Your data has not been removed."
      Abort
    ${EndIf}
  ${EndIf}
!macroend
