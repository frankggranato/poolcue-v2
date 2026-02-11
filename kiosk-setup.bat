@echo off
echo ========================================
echo   Pool Cue Kiosk Setup
echo ========================================
echo.

:: Create startup shortcut that launches Chrome in kiosk mode
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "URL=https://pool-cue.onrender.com/board/table1"

:: Create a VBS script to make the shortcut (batch can't make .lnk files directly)
echo Set ws = CreateObject("WScript.Shell") > "%TEMP%\mkshortcut.vbs"
echo Set sc = ws.CreateShortcut("%STARTUP%\PoolCue.lnk") >> "%TEMP%\mkshortcut.vbs"
echo sc.TargetPath = "%CHROME%" >> "%TEMP%\mkshortcut.vbs"
echo sc.Arguments = "--kiosk --noerrdialogs --disable-translate --no-first-run --disable-infobars --disable-features=TranslateUI %URL%" >> "%TEMP%\mkshortcut.vbs"
echo sc.Save >> "%TEMP%\mkshortcut.vbs"
cscript //nologo "%TEMP%\mkshortcut.vbs"
del "%TEMP%\mkshortcut.vbs"

:: Disable sleep when plugged in
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0

echo.
echo Done! Pool Cue will launch fullscreen when this PC starts.
echo Screen sleep has been disabled.
echo.
echo Reboot to test, or just double-click the shortcut in:
echo   %STARTUP%
echo.
pause
