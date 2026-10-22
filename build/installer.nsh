; ---------------------------------------------------------------------------
; Dola Toolkit — NSIS customisation
;
; Shortcut naming is language-dependent and electron-builder's `shortcutName` is a
; single string, so the installer creates the shortcuts under the English name and
; this macro renames them once, based on the language the installer is running in.
; Chinese Windows therefore ends up with 「多拉工具箱」, everything else with
; 「Dola Toolkit」.
; ---------------------------------------------------------------------------

!macro renameShortcut oldName newName
  ${If} ${FileExists} "$DESKTOP\${oldName}.lnk"
    Delete "$DESKTOP\${newName}.lnk"
    Rename "$DESKTOP\${oldName}.lnk" "$DESKTOP\${newName}.lnk"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\${oldName}.lnk"
    Delete "$SMPROGRAMS\${newName}.lnk"
    Rename "$SMPROGRAMS\${oldName}.lnk" "$SMPROGRAMS\${newName}.lnk"
  ${EndIf}
  ; any folder-style start menu entry created by older builds
  ${If} ${FileExists} "$SMPROGRAMS\${oldName}\${oldName}.lnk"
    Delete "$SMPROGRAMS\${newName}.lnk"
    Rename "$SMPROGRAMS\${oldName}\${oldName}.lnk" "$SMPROGRAMS\${newName}.lnk"
    RMDir "$SMPROGRAMS\${oldName}"
  ${EndIf}
!macroend

!macro customInstall
  ; $LANGUAGE is set by the installer UI, which follows the system language.
  ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
    !insertmacro renameShortcut "Dola Toolkit" "多拉工具箱"
  ${EndIf}
!macroend
