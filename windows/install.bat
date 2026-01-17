@echo off
title github.com/heitorrosa/.files

::
:: Execute the script as administrator (Not needeed, UAC already disabled)
::
cd /d "%~dp0" && ( if exist "%temp%\getadmin.vbs" del "%temp%\getadmin.vbs" ) && fsutil dirty query %systemdrive% 1>nul 2>nul || (  echo Set UAC = CreateObject^("Shell.Application"^) : UAC.ShellExecute "cmd.exe", "/k cd ""%~sdp0"" && %~s0 %params%", "", "runas", 1 >> "%temp%\getadmin.vbs" && "%temp%\getadmin.vbs" && exit /B )

powershell Set-ExecutionPolicy Unrestricted

SETLOCAL EnableExtensions DisableDelayedExpansion
for /F %%a in ('echo prompt $E ^| cmd') do (
  set "ESC=%%a"
)
SETLOCAL EnableDelayedExpansion
chcp 65001 >NUL 2>&1



::----------------------------------------------------------------



::
:: Parameters Setup
::

set "PARAM_PACKAGES=ON"
set "PARAM_CONFIGURATIONS=ON"
set "PARAM_TWEAKS=ON"

:paramSetup
cls

echo   heitorrosa/.files
echo.
echo         !ESC![93m_____ __!ESC![0m         
echo        !ESC![93m/ __(_) /__  _____!ESC![0m
echo       !ESC![93m/ /_/ / / _ \/ ___/!ESC![0m
echo    !ESC![93m_ / __/ / /  __(__  )!ESC![0m
echo   !ESC![93m(_)_/ /_/_/\___/____/!ESC![0m  !ESC![4mWindows Installer!ESC![0m
echo.
echo   Select the following parameters to be executed
echo.
echo   !ESC![93m1!ESC![0m - [!ESC![93m%PARAM_PACKAGES%!ESC![0m] Packages
echo   !ESC![93m2!ESC![0m - [!ESC![93m%PARAM_CONFIGURATIONS%!ESC![0m] Configurations (Make sure to have everything already installed)
echo   !ESC![93m3!ESC![0m - [!ESC![93m%PARAM_TWEAKS%!ESC![0m] Tweaks and Optimizations
echo.
echo   !ESC![93m4!ESC![0m - Confirm and Execute
echo.
set /p choice="   Select an option (!ESC![93m1-4!ESC![0m): "

if "%choice%"=="1" (
    if "%PARAM_PACKAGES%"=="ON" (
        set "PARAM_PACKAGES=OFF"
    ) else (
        set "PARAM_PACKAGES=ON"
    )
    goto paramSetup
)

if "%choice%"=="2" (
    if "%PARAM_CONFIGURATIONS%"=="ON" (
        set "PARAM_CONFIGURATIONS=OFF"
    ) else (
        set "PARAM_CONFIGURATIONS=ON"
    )
    goto paramSetup
)

if "%choice%"=="3" (
    if "%PARAM_TWEAKS%"=="ON" (
        set "PARAM_TWEAKS=OFF"
    ) else (
        set "PARAM_TWEAKS=ON"
    )
    goto paramSetup
)

if "%choice%"=="4" (
    echo Confirmed. Proceeding with selected options...
) else (
    goto paramSetup
)



::----------------------------------------------------------------


if "%PARAM_PACKAGES%"=="ON" (
    goto packages
) else goto configurations

:packages


::
:: Packages and Dependencies Installer
::

:: Chocolatey Installation
set "choco=C:\ProgramData\chocolatey\choco.exe"
powershell Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
%choco% feature enable -n=allowGlobalConfirmation
%choco% feature enable -n useFipsCompliantChecksums
%choco% upgrade all

:: Chocolatey Dependancies
%choco% install chocolatey-core.extension

:: Dependancies and Drivers
%choco% install nvidia-display-driver --params "/MSVCRT /ShadowPlay /NVApp /NoAudio /NoUSBC"

%choco% install directx
%choco% install vcredist-all
%choco% install dotnet-all

%choco% install python

%choco% install 7zip
%choco% install git

%choco% install hwinfo

:: Terminal Emulator
%choco% install powershell-core --install-arguments='"DISABLE_TELEMETRY=1 ADD_FILE_CONTEXT_MENU_RUNPOWERSHELL=1 ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=1"

:: Fastfetch
%choco% install fastfetch

:: Everything
%choco% install everything --params "/run-on-system-startup /client-service"

:: Ricing Tools
%choco% install windhawk
%choco% install altsnap --ignore-checksums
%choco% install powertoys
%choco% install everythingpowertoys --ignore-checksums
%choco% install everythingcmdpal --ignore-checksums
%choco% install glazewm

:: Remote Access Tool (Parsec and Apollo)
%choco% install parsec --ignore-checksums
%choco% install apollo

:: VPN
%choco% install tailscale

:: Programs
%choco% install discord
%choco% install thorium

%choco% install mysql.workbench

:: MSI Afterburner
:: curl -g -k -L -# -o "C:\Windows\Temp\MSI Afterburner.zip" "https://www.guru3d.com/getdownload/2c1b2414f56a6594ffef91236a87c0e976d52e0518b43f3846bab016c2f20c7c4d6ce7dfe19a0bc843da8d448bbb670058b0c9ee9a26f5cf49bc39c97da070e6eb314629af3da2d24ab0413917f73b946419b5af447da45cefb517a0840ad3003abff4f9d5fe7828bbbb910ee270b20632035fba6a450da22325b6bc5b6ecf760e598e0a09bb89139806376c01a72748cf45d6a798a241ec0787b63b8696336ce1e485eef0fbcdb6340fa3d74b142d1660f4038f9b6a10bd4d30634e03bb2790016d3b73e764a02a0e1d0633216fa76c5c1a0f8ee6671f41415a"

:: "C:\Program Files\7-Zip\7z.exe" e "C:\Windows\Temp\MSI Afterburner.zip" -oC:\Windows\Temp *.exe -r
:: "C:\Windows\Temp\MSIAfterburnerSetup466Beta3.exe" /S

:: del /f "C:\Windows\Temp\MSI Afterburner.zip"
:: del /f "C:\Windows\Temp\MSIAfterburnerSetup466Beta3.exe"

::----------------------------------------------------------------


if "%PARAM_CONFIGURATIONS%"=="ON" (
    goto configurations
) else goto tweaks

:configurations


::
:: Clone Repository
::
git clone https://github.com/heitorrosa/.files
cd .files


::
:: Import Git settings
::
git config --global user.name "heitorrosa"
git config --global user.email "76885858+heitorrosa@users.noreply.github.com"


::
:: Import 7Zip reg files
::
reg add "HKCU\SOFTWARE\7-Zip\FM\Columns" /v "RootFolder" /t REG_BINARY /d "0100000000000000010000000400000001000000a0000000" /f

reg add "HKCU\SOFTWARE\7-Zip\Options" /v "CascadeMenu" /t REG_DWORD /d "0" /f
reg add "HKCU\SOFTWARE\7-Zip\Options" /v "ContextMenu" /t REG_DWORD /d "261" /f
reg add "HKCU\SOFTWARE\7-Zip\Options" /v "CascadedMenu" /t REG_DWORD /d "0" /f
reg add "HKCU\SOFTWARE\7-Zip\Options" /v "MenuIcons" /t REG_DWORD /d "1" /f
reg add "HKCU\SOFTWARE\7-Zip\Options" /v "ElimDupExtract" /t REG_DWORD /d "1" /f


::
:: Restore Windhawk Settings
::

:: Get the current directory (which should be .files after cd)
set "CURRENT_DIR=%cd%"
set "BACKUP_ZIP=%CURRENT_DIR%\windows\Windhawk\windhawk-backup.zip"
set "WINDHAWK_ROOT=C:\ProgramData\Windhawk"
set "EXTRACT_FOLDER=%TEMP%\WindhawkRestore"

echo Searching for backup in:
echo   %BACKUP_ZIP%
echo.

:: Check for backup file
if not exist "%BACKUP_ZIP%" (
    echo Error: Backup file not found
    echo Please ensure this exists:
    echo   %BACKUP_ZIP%
    pause
    exit /b 1
)

:: Create extraction directory
if exist "%EXTRACT_FOLDER%" rmdir /s /q "%EXTRACT_FOLDER%"
mkdir "%EXTRACT_FOLDER%" >nul 2>&1

:: Extract backup
echo Extracting backup...
powershell -command "Expand-Archive -LiteralPath '%BACKUP_ZIP%' -DestinationPath '%EXTRACT_FOLDER%' -Force"

:: Restore ModsSource
if exist "%EXTRACT_FOLDER%\ModsSource\" (
    echo Restoring ModsSource...
    if not exist "%WINDHAWK_ROOT%\" mkdir "%WINDHAWK_ROOT%"
    xcopy /e /i /y "%EXTRACT_FOLDER%\ModsSource" "%WINDHAWK_ROOT%\ModsSource\" >nul
)

:: Restore Engine\Mods
if exist "%EXTRACT_FOLDER%\Engine\Mods\" (
    echo Restoring Engine\Mods...
    if not exist "%WINDHAWK_ROOT%\Engine\" mkdir "%WINDHAWK_ROOT%\Engine"
    xcopy /e /i /y "%EXTRACT_FOLDER%\Engine\Mods" "%WINDHAWK_ROOT%\Engine\Mods\" >nul
)

:: Restore registry settings
if exist "%EXTRACT_FOLDER%\Windhawk.reg" (
    echo Importing registry settings...
    reg import "%EXTRACT_FOLDER%\Windhawk.reg" >nul
)

:: Cleanup
rmdir /s /q "%EXTRACT_FOLDER%"

echo.
echo Restore completed successfully!
echo Mods and settings restored from:
echo   %BACKUP_ZIP%
echo.


::
:: Restore GlazeWM Settings and configures it to run at startup
::
set "CURRENT_DIR=%cd%"
xcopy "%CURRENT_DIR%\windows\glazewm\" "%userprofile%\.glzr\glazewm\" /y

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "GlazeWM" /t REG_SZ /d "C:\Program Files\glzr.io\GlazeWM\glazewm.exe" /f


::
:: Move PowerToys Settings to the Backup Folder
::
set "CURRENT_DIR=%cd%"
xcopy "%CURRENT_DIR%\windows\PowerToys\" "%userprofile%\Documents\PowerToys\Backup" /y


::
:: Set AltSnap to run at startup
::
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "AltSnap" /t REG_SZ /d "%userprofile%\AppData\Roaming\AltSnap\AltSnap.exe" /f


::
:: Restore MSI Afterburner Settings
::
:: set "CURRENT_DIR=%cd%"
:: xcopy "%CURRENT_DIR%\windows\MSI Afterburner\Profiles\" "C:\Program Files (x86)\MSI Afterburner\Profiles\" /y



::----------------------------------------------------------------


if "%PARAM_TWEAKS%"=="ON" (
    goto tweaks
) else goto :eof

:tweaks

::
:: Tweaks for Performance, Latency and QoL
::