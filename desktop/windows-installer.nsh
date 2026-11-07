!include LogicLib.nsh
!macro customInstall
  ; The Office conversion helper needs Microsoft's shared C++ runtime.
  ExecWait '"$INSTDIR\resources\shiwen\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 != 0
  ${AndIf} $0 != 1638
  ${AndIf} $0 != 3010
    MessageBox MB_OK|MB_ICONEXCLAMATION "Microsoft Visual C++ runtime installation failed (code $0). Office document conversion may not work."
  ${EndIf}
!macroend
