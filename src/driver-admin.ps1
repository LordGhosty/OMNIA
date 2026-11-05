# Driver operations.
$env:PSModulePath=Join-Path $PSHOME 'Modules'
function Invoke-OmniaPnP($arguments){$output=(& (Join-Path $env:windir 'System32\pnputil.exe') @arguments 2>&1 | Out-String);return @{output=$output;code=$LASTEXITCODE}}
function Invoke-OmniaDriver($action,$data) {
  if($action -eq 'driver-list') {
    $list=@(Get-WindowsDriver -Online -All | ForEach-Object {@{inf=[string]$_.Driver;original=[string]$_.OriginalFileName;provider=[string]$_.ProviderName;version=[string]$_.Version;date=$_.Date.ToString('yyyy-MM-dd');class=[string]$_.ClassName;bootCritical=[bool]$_.BootCritical;inbox=[bool]$_.Inbox}})
    return (ConvertTo-Json -InputObject $list -Depth 4 -Compress)
  }
  if($action -notin @('driver-backup','driver-remove')){throw 'Unsupported driver action.'}
  $inf=[string]$data.inf
  if($inf -cnotmatch '^oem[0-9]+\.inf$'){throw 'Select a third-party OEM driver package.'}
  $file=Join-Path $env:windir ('INF\'+$inf)
  if(!(Test-Path -LiteralPath $file -PathType Leaf)){throw 'The driver package is no longer present.'}
  if([string]$data.hash -cnotmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine [string]$data.hash){throw 'The package changed. Scan again.'}
  $driver=Get-WindowsDriver -Online | Where-Object {$_.Driver -ieq $inf} | Select-Object -First 1
  if(!$driver){throw 'The driver package is no longer present.'}
  if($driver.Inbox){throw 'Built-in Windows packages are not supported by this removal method.'}
  if([string]$driver.Version -cne [string]$data.version -or [string]$driver.ProviderName -cne [string]$data.provider){throw 'The driver identity changed. Scan again.'}
  if($action -eq 'driver-remove'){
    if([string]$data.phrase -cne ('REMOVE '+$inf)){throw 'Driver removal confirmation is missing.'}
    $devices=@(Get-CimInstance Win32_PnPSignedDriver | Where-Object {$_.InfName -ieq $inf})
    $ids=@($devices | ForEach-Object {[string]$_.DeviceID} | Sort-Object -Unique)
    $expected=@($data.devices | Sort-Object -Unique)
    if(($ids -join '|') -cne ($expected -join '|')){throw 'Devices using the package changed. Review the removal again.'}
    $services=@(Get-CimInstance Win32_SystemDriver | Where-Object {$_.StartMode -in @('Boot','System')})
    $entities=@(Get-CimInstance Win32_PnPEntity | Where-Object {$_.DeviceID -in $ids})
    if(($driver.BootCritical -or $driver.ClassName -in @('System','HDC','SCSIAdapter','DiskDrive','Volume','Firmware','SecurityDevices') -or ($entities | Where-Object {$_.Service -in $services.Name})) -and $data.acknowledgedRisk -ne $true){throw 'Acknowledge the system-driver warning before removal.'}
  }
  $folder=[string]$data.backup
  if($folder -notmatch '^[A-Za-z]:\\' -or $folder -match '["\r\n]' -or (Test-Path -LiteralPath $folder)){throw 'Choose a new local backup folder.'}
  $ancestor=Split-Path -Parent $folder
  while($ancestor){$item=Get-Item -LiteralPath $ancestor -Force;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Backup folders cannot use links or junctions.'};$ancestor=Split-Path -Parent $ancestor}
  New-Item -ItemType Directory -Path $folder | Out-Null
  $result=Invoke-OmniaPnP @('/export-driver',$inf,$folder);$backupOutput=$result.output;$code=$result.code
  if($code -ne 0){throw "Backup failed ($code). No driver was removed. $backupOutput"}
  $copy=Get-ChildItem -LiteralPath $folder -Recurse -Filter *.inf | Where-Object {(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash -ieq [string]$data.hash}
  if(!$copy){throw 'The exported INF did not match. No driver was removed.'}
  $output=$backupOutput;$restart=$false
  if($action -eq 'driver-remove'){
    $fresh=@(Get-CimInstance Win32_PnPSignedDriver | Where-Object {$_.InfName -ieq $inf} | ForEach-Object {[string]$_.DeviceID} | Sort-Object -Unique)
    $connected=@(Get-CimInstance Win32_PnPEntity | Where-Object {$_.DeviceID -in $fresh -and $_.Present} | ForEach-Object {[string]$_.DeviceID} | Sort-Object -Unique)
    if(($fresh -join '|') -cne ($expected -join '|') -or ($connected -join '|') -cne (@($data.connected | Sort-Object -Unique) -join '|') -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine [string]$data.hash){throw 'Devices or package changed during backup. No removal was attempted.'}
    # Non-forced removal.
    $result=Invoke-OmniaPnP @('/delete-driver',$inf,'/uninstall');$output=$result.output;$code=$result.code
    if($code -notin @(0,3010)){throw "Windows refused removal ($code). Backup: $folder. $output"}
    $restart=$code -eq 3010
  }
  return (@{action=$action;inf=$inf;backup=$folder;output=$output;restartRequired=$restart;exitCode=$code} | ConvertTo-Json -Compress)
}
