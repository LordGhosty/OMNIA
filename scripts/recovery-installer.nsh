!include "WinVer.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
Var omniaRecovery
Var omniaValidator
Var omniaUninstallerShortcut
Var omniaRecoveryBox
Var omniaValidatorBox
Var omniaUninstallerBox

!macro readOmniaChoice variable value
  StrCpy ${variable} ${BST_CHECKED}
  ReadRegDWORD $0 HKCU "${INSTALL_REGISTRY_KEY}" "${value}"
  ${If} $0 == 0
    StrCpy ${variable} ${BST_UNCHECKED}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
Function omniaComponents
  !insertmacro MUI_HEADER_TEXT "Choose components" "Select what to include with ${PRODUCT_NAME}."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 14u "${PRODUCT_NAME} (required)"
  Pop $0
  ${NSD_Check} $0
  EnableWindow $0 0
  ${NSD_CreateCheckbox} 0 26u 100% 14u "${PRODUCT_NAME} Recovery"
  Pop $omniaRecoveryBox
  ${NSD_SetState} $omniaRecoveryBox $omniaRecovery
  ${NSD_OnClick} $omniaRecoveryBox omniaComponentChanged
  ${NSD_CreateLabel} 12u 42u 95% 16u "Reinstall a verified backup if the application cannot start."
  Pop $0
  ${NSD_CreateCheckbox} 0 66u 100% 14u "${PRODUCT_NAME} Validator"
  Pop $omniaValidatorBox
  ${NSD_SetState} $omniaValidatorBox $omniaValidator
  ${NSD_OnClick} $omniaValidatorBox omniaComponentChanged
  ${NSD_CreateLabel} 12u 82u 95% 16u "Check installer signatures and file checksums."
  Pop $0
  ${NSD_CreateCheckbox} 0 106u 100% 14u "${PRODUCT_NAME} Uninstaller shortcut"
  Pop $omniaUninstallerBox
  ${NSD_SetState} $omniaUninstallerBox $omniaUninstallerShortcut
  ${NSD_OnClick} $omniaUninstallerBox omniaComponentChanged
  ${NSD_CreateLabel} 12u 122u 95% 25u "Add a Start menu shortcut. You can always uninstall through Windows Settings."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function omniaComponentsLeave
  ${NSD_GetState} $omniaRecoveryBox $omniaRecovery
  ${NSD_GetState} $omniaValidatorBox $omniaValidator
  ${NSD_GetState} $omniaUninstallerBox $omniaUninstallerShortcut
FunctionEnd

Function omniaComponentChanged
  Pop $0
  Call omniaComponentsLeave
FunctionEnd

  Page custom omniaComponents omniaComponentsLeave
!macroend
!endif

!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "OMNIA requires Windows 10 or Windows 11."
    Quit
  ${EndIf}
  !insertmacro readOmniaChoice $omniaRecovery "OmniaRecovery"
  !insertmacro readOmniaChoice $omniaValidator "OmniaValidator"
  !insertmacro readOmniaChoice $omniaUninstallerShortcut "OmniaUninstallerShortcut"
!macroend
!macro customInstall
  !if /FileExists "${UNINSTALLER_OUT_FILE}.sig"
    SetOutPath "$INSTDIR"
    File "/oname=Uninstall OMNIA.exe.sig" "${UNINSTALLER_OUT_FILE}.sig"
  !endif
  ${If} $omniaRecovery == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME} Recovery.lnk" "$INSTDIR\${PRODUCT_NAME} Recovery.exe"
  ${Else}
    Delete "$SMPROGRAMS\${PRODUCT_NAME} Recovery.lnk"
    Delete /REBOOTOK "$INSTDIR\${PRODUCT_NAME} Recovery.exe"
  ${EndIf}
  ${If} $omniaValidator == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME} Validator.lnk" "$INSTDIR\${PRODUCT_NAME} Validator.exe"
  ${Else}
    Delete "$SMPROGRAMS\${PRODUCT_NAME} Validator.lnk"
    Delete /REBOOTOK "$INSTDIR\${PRODUCT_NAME} Validator.exe"
  ${EndIf}
  ${If} $omniaUninstallerShortcut == ${BST_CHECKED}
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME} Uninstaller.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
  ${Else}
    Delete "$SMPROGRAMS\${PRODUCT_NAME} Uninstaller.lnk"
  ${EndIf}
  WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" "OmniaRecovery" $omniaRecovery
  WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" "OmniaValidator" $omniaValidator
  WriteRegDWORD HKCU "${INSTALL_REGISTRY_KEY}" "OmniaUninstallerShortcut" $omniaUninstallerShortcut
!macroend
!macro customUnInstall
  Delete "$SMPROGRAMS\${PRODUCT_NAME} Validator.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME} Uninstaller.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME} Recovery.lnk"
!macroend
