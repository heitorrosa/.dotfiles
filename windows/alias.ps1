function ifconfig { Get-NetIPConfiguration }
function ip { 
    param($cmd) 
    if ($cmd -eq "addr" -or $cmd -eq "a") { Get-NetIPAddress | Format-Table } 
    else { Write-Host "Usage: ip addr" }
}
function grep { $input | Select-String @args }
function touch($file) { New-Item -ItemType File -Path $file -Force | Out-Null }
function which($name) { Get-Command $name -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source }
function head($file, $n=10) { Get-Content $file -TotalCount $n }
function tail($file, $n=10) { Get-Content $file | Select-Object -Last $n }
function free { 
    Get-CimInstance Win32_OperatingSystem | Select-Object `
        @{n="TotalMemory(GB)";e={"{0:N2}" -f ($_.TotalVisibleMemorySize / 1MB)}}, `
        @{n="FreeMemory(GB)";e={"{0:N2}" -f ($_.FreePhysicalMemory / 1MB)}} 
}
function df { Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{n="Used(GB)";e={"{0:N2}" -f ($_.Used / 1GB)}}, @{n="Free(GB)";e={"{0:N2}" -f ($_.Free / 1GB)}} }
function top { Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 }
function .. { Set-Location .. }
function ... { Set-Location ../.. }
function .... { Set-Location ../../.. }
function home { Set-Location ~ }
function ll { Get-ChildItem | Format-Table Mode, LastWriteTime, Length, Name }
function la { Get-ChildItem -Force }
function chmod { Write-Host "Note: Use 'Set-ExecutionPolicy' for script permissions in PowerShell." -ForegroundColor Yellow }
function reload { . $PROFILE; Write-Host "Profile Reloaded!" -ForegroundColor Cyan }

Set-Alias -Name gsudo -Value "C:\tools\gsudo\Current\gsudo.exe"
Set-Alias -Name sudo -Value "C:\tools\gsudo\Current\gsudo.exe"

Set-Alias -Name m -Value make
Set-Alias -Name d -Value docker