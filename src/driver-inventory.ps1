$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$issues=@();$devices=@();$services=@()
try {
  $entities=@{};Get-CimInstance Win32_PnPEntity | ForEach-Object {$entities[[string]$_.DeviceID]=$_}
  $devices=@(Get-CimInstance Win32_PnPSignedDriver | ForEach-Object {
    $e=$entities[[string]$_.DeviceID];$present=$null;if($e -and $null -ne $e.Present){$present=[bool]$e.Present}
    [pscustomobject]@{id=[string]$_.DeviceID;name=[string]$_.DeviceName;inf=[string]$_.InfName;provider=[string]$_.DriverProviderName;version=[string]$_.DriverVersion;date=[string]$_.DriverDate;class=[string]$_.DeviceClass;signed=$_.IsSigned;signer=[string]$_.Signer;present=$present;problem=$e.ConfigManagerErrorCode;service=[string]$e.Service}
  })
}catch{$issues+='Device inventory: '+$_.Exception.Message}
try {
  $services=@(Get-CimInstance Win32_SystemDriver | ForEach-Object {[pscustomobject]@{name=[string]$_.Name;displayName=[string]$_.DisplayName;path=[string]$_.PathName;state=[string]$_.State;startMode=[string]$_.StartMode;type=[string]$_.ServiceType;errorControl=[string]$_.ErrorControl}})
}catch{$issues+='Driver services: '+$_.Exception.Message}
@{devices=$devices;services=$services;issues=$issues} | ConvertTo-Json -Depth 6 -Compress
