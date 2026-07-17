; electron-builder NSIS hooks.
; On uninstall, remove the per-user "start with Windows" Run entry that the app
; registers via app.setLoginItemSettings (value name: electron.app.<app.name>).
; Best-effort — a stale entry is harmless, but leaving none is cleaner.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Claude Usage Dashboard"
!macroend
