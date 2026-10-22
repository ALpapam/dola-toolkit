; ---------------------------------------------------------------------------
; Dola Toolkit — NSIS customisation
; ---------------------------------------------------------------------------

; ---------------------------------------------------------------------------
; Shortcut naming
;
; electron-builder's `shortcutName` is a single string, so the shortcuts are first
; created under the English name and renamed here according to the language the
; installer is running in. Chinese Windows therefore ends up with 「多拉工具箱」,
; everything else with 「Dola Toolkit」.
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

; ---------------------------------------------------------------------------
; Clear leftovers before anything is written
;
; Two failure modes seen in real installs:
;
;  1. "无法打开要写入的文件 …\Uninstall Dola Toolkit.exe" — an interrupted earlier
;     attempt left the uninstaller (or NSIS's temporary uninstaller image Un_A.exe)
;     running. Its image is locked while it runs, so the retry cannot write it.
;     Those processes belong to an install that has already finished or was
;     abandoned.
;
;  2. "Dola Toolkit 正在运行，点击确定关闭" — the stock check matches any process with
;     that image name for the current user. The *portable* build runs under the same
;     image name from a temp folder, so having it open blocked a fresh install into
;     an unrelated folder. Only instances running from Temp are the portable build,
;     so only those are stopped here; an installed copy the user is actively using is
;     left alone and still reported by the stock check.
;
; Registers are saved/restored because this runs inside .onInit.
; ---------------------------------------------------------------------------
!macro customInit
  Push $0
  Push $1

  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "Un_A.exe"`
  Pop $0
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "Uninstall ${PRODUCT_NAME}.exe"`
  Pop $0

  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-Process -Name '${APP_EXECUTABLE_FILENAME}' -ErrorAction SilentlyContinue | Where-Object { $$_.Path -and $$_.Path -like '*\Temp\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  Pop $0

  Pop $1
  Pop $0
!macroend
