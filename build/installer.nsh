; Custom NSIS hooks for the Alarmind installer (electron-builder `include`).
;
; The app hides to the system tray on close, so at install/update time an
; "invisible" Alarmind.exe is often still running and holds locks on the
; install directory — NSIS then fails with "Error opening file for writing".
; Kill any running instance before installing or uninstalling.

!macro customInit
  nsExec::Exec 'taskkill /F /IM Alarmind.exe /T'
  Sleep 500
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM Alarmind.exe /T'
  Sleep 500
!macroend
