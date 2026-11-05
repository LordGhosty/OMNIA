!include "WinVer.nsh"
!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "OMNIA requires Windows 10 or Windows 11."
    Quit
  ${EndIf}
!macroend
!macro customInstall
  CreateShortCut "$SMPROGRAMS\OMNIA Validator.lnk" "$INSTDIR\OMNIA Validator.exe"
  CreateShortCut "$SMPROGRAMS\OMNIA Uninstaller.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  CreateShortCut "$SMPROGRAMS\OMNIA Recovery.lnk" "$INSTDIR\OMNIA Recovery.exe"
!macroend
!macro customUnInstall
  Delete "$SMPROGRAMS\OMNIA Validator.lnk"
  Delete "$SMPROGRAMS\OMNIA Uninstaller.lnk"
  Delete "$SMPROGRAMS\OMNIA Recovery.lnk"
!macroend
