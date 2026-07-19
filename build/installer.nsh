; Custom NSIS hooks for the Alarmind installer (electron-builder `include`).
;
; The app hides to the system tray on close, so at install/update time an
; "invisible" Alarmind.exe is often still running and holds locks on the
; install directory — NSIS then fails with "Error opening file for writing".
;
; customInit runs before anything is written:
;   1. Kill any running Alarmind (including child processes).
;   2. Poll up to ~5s until the process list is actually clear — taskkill
;      returns before handles are released, so a fixed short sleep was not
;      always enough on slower machines.

!macro customInit
  ; Kill the app if running; /T takes child processes (GPU/renderer) too.
  nsExec::Exec 'taskkill /F /IM Alarmind.exe /T'
  Pop $0

  ; Wait until no Alarmind.exe remains (max 10 x 500ms).
  StrCpy $1 0
  alarmind_wait_loop:
    IntOp $1 $1 + 1
    IntCmp $1 10 alarmind_wait_done
    nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Alarmind.exe" | find /I "Alarmind.exe"'
    Pop $0
    ; find returns 0 while the process is still listed -> keep waiting.
    IntCmp $0 0 0 alarmind_wait_done alarmind_wait_done
    Sleep 500
    Goto alarmind_wait_loop
  alarmind_wait_done:
  Sleep 300
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM Alarmind.exe /T'
  Sleep 1000
!macroend
