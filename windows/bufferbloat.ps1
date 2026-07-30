$ErrorActionPreference = "SilentlyContinue"

netsh int tcp set supplemental template=Internet congestionprovider=BBR2
netsh int tcp set global autotuninglevel=disabled
netsh int tcp set global nonsackrttresiliency=disabled
netsh int tcp set global timestamps=disabled
netsh int tcp set global rsc=enabled
netsh int tcp set global rss=enabled
netsh int tcp set global ecncapability=disabled
netsh int tcp set global pacingprofile=off
netsh int tcp set global hystart=disabled
netsh int tcp set global prr=disabled
netsh int tcp set global maxsynretransmissions=2
netsh int tcp set global fastopen=disabled
netsh int tcp set global fastopenfallback=disabled

Set-NetTCPSetting -SettingName Internet -InitialRto 300
Set-NetTCPSetting -SettingName Internet -ScalingHeuristics Disabled
Set-NetTCPSetting -SettingName Internet -Timestamps Disabled
Set-NetTCPSetting -SettingName Internet -NonSackRttResiliency Disabled

$p = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters"
Set-ItemProperty -Path $p -Name "TcpNoDelay"          -Value 1     -Type DWord -Force
Set-ItemProperty -Path $p -Name "TcpAckFrequency"     -Value 1     -Type DWord -Force
Set-ItemProperty -Path $p -Name "TcpDelAckTicks"      -Value 0     -Type DWord -Force
Set-ItemProperty -Path $p -Name "DefaultTTL"           -Value 64    -Type DWord -Force
Set-ItemProperty -Path $p -Name "MaxUserPort"          -Value 65534 -Type DWord -Force
Set-ItemProperty -Path $p -Name "TcpTimedWaitDelay"    -Value 30    -Type DWord -Force
Set-ItemProperty -Path $p -Name "SackOpts"             -Value 1     -Type DWord -Force
Set-ItemProperty -Path $p -Name "Tcp1323Opts"          -Value 0     -Type DWord -Force
Set-ItemProperty -Path $p -Name "GlobalMaxTcpWindowSize" -Value 16384 -Type DWord -Force
Set-ItemProperty -Path $p -Name "MaxFreeTcbs"          -Value 65536 -Type DWord -Force
Set-ItemProperty -Path $p -Name "MaxHashTableSize"     -Value 65536 -Type DWord -Force

Get-ChildItem "$p\Interfaces" | ForEach-Object {
    Set-ItemProperty -Path $_.PSPath -Name "TcpAckFrequency" -Value 1 -Type DWord -Force
    Set-ItemProperty -Path $_.PSPath -Name "TcpDelAckTicks"  -Value 0 -Type DWord -Force
    Set-ItemProperty -Path $_.PSPath -Name "TCPNoDelay"      -Value 1 -Type DWord -Force
}

$nic = Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*Realtek*" -and $_.Status -ne "Disabled" } | Select-Object -First 1
if ($nic) {
    Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword "*FlowControl" -RegistryValue 0 -ErrorAction SilentlyContinue
    Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword "*InterruptModeration" -RegistryValue 0 -ErrorAction SilentlyContinue
    Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword "*ReceiveBuffers" -RegistryValue 512 -ErrorAction SilentlyContinue
    Write-Host "NIC: $($nic.InterfaceDescription)" -ForegroundColor DarkGray
}

Set-NetOffloadGlobalSetting -ReceiveSideScaling Enabled
Set-NetOffloadGlobalSetting -ReceiveSegmentCoalescing Disabled
Set-NetOffloadGlobalSetting -Chimney Disabled
Set-NetOffloadGlobalSetting -TaskOffload Disabled
if ($nic) {
    Disable-NetAdapterRsc -Name $nic.Name -ErrorAction SilentlyContinue
    Disable-NetAdapterLso -Name $nic.Name -ErrorAction SilentlyContinue
}
