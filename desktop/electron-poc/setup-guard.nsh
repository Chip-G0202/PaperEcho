; Never replace an MSI-managed installation with NSIS. No user-data operations.
!macro customInit
  EnumRegKey $0 HKCU "Software\PaperEcho\Installer\Packages" 0
  ${If} $0 != ""
    MessageBox MB_OK|MB_ICONSTOP "An MSI-managed PaperEcho installation exists. Back up your data and uninstall the MSI manually before using this installer. No changes have been made."
    Abort
  ${EndIf}
!macroend
