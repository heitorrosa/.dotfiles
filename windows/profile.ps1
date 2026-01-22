Add-Type –assemblyName WindowsBase
Add-Type –assemblyName PresentationFramework
Add-Type –assemblyName PresentationCore

$code = @"
[DllImport("user32.dll", SetLastError = true)] 
public static extern int GetWindowLong(IntPtr hWnd, int nIndex); 
[DllImport("user32.dll")] 
public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
"@
Add-Type -MemberDefinition $code -Name Win32Util -Namespace System

$WS_BORDER = 0x00800000
$WS_DLGFRAME = 0x00400000
$WS_CAPTION = $WS_BORDER -bor $WS_DLGFRAME
$WS_THICKFRAME = 0x00040000
$WS_MINIMIZE = 0x20000000
$WS_MAXIMIZE = 0x01000000
$WS_SYSMENU = 0x00080000
$WS_EX_DLGMODALFRAME = 0x00000001
$WS_EX_CLIENTEDGE = 0x00000200
$WS_EX_STATICEDGE = 0x00020000

$GWL_EXSTYLE = -20
$GWL_STYLE = -16

$MainWindowHandle = ([system.diagnostics.process]::GetCurrentProcess()).MainWindowHandle

$style = [System.Win32Util]::GetWindowLong($MainWindowHandle,$GWL_STYLE)
[System.Win32Util]::SetWindowLong($MainWindowHandle,$GWL_STYLE, $style -band -bnot($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_MINIMIZE -bor $WS_MAXIMIZE -bor $WS_SYSMENU))

function reset {
    Set-Buffer-Width-To-Screen-Width
    Clear-Host
}

function Set-Buffer-Width-To-Screen-Width {
    $h = Get-Host
    $ui = $h.UI.RawUI
    $bufferSize = $ui.BufferSize
    $windowSize = $ui.WindowSize
    $bufferSize.Width = $windowSize.Width
    $ui.BufferSize = $bufferSize
}

clear

fastfetch -c "C:\Users\Administrator\.files\windows\fastfetch\config.jsonc"