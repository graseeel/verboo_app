!macro customInit
  ; Kill running Verboo processes before installing
  ExecWait 'taskkill /F /IM verboo-desktop.exe'
  ExecWait 'taskkill /F /IM verboo-in-chrome.exe'
  Sleep 1000
!macroend
