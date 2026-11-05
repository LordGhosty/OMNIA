param([string]$Root,[string]$Source)
$ErrorActionPreference='Stop'
# No real driver tools or CIM calls are used by this test.
. $Source
Get-FileHash -LiteralPath $Source -Algorithm SHA256 | Out-Null
$env:windir=$Root
New-Item -ItemType Directory -Path (Join-Path $Root 'INF') | Out-Null
$script:inf=Join-Path $Root 'INF\oem12.inf';Set-Content -LiteralPath $script:inf -Value 'fixture package'
$script:critical=$false;$script:changed=$false;$script:failExport=$false;$script:badCopy=$false;$script:changeOnExport=$false;$script:calls=@()
function Get-WindowsDriver {param([switch]$Online,[switch]$All) [pscustomobject]@{Driver='oem12.inf';OriginalFileName='original.inf';Date=[datetime]'2026-01-01';ProviderName='Test';Version='1';ClassName='Net';BootCritical=$script:critical;Inbox=$false}}
function Get-CimInstance {param($ClassName)
  if($ClassName -eq 'Win32_PnPSignedDriver'){[pscustomobject]@{InfName='oem12.inf';DeviceID=$(if($script:changed){'changed'}else{'test-device'})}}
  elseif($ClassName -eq 'Win32_PnPEntity'){[pscustomobject]@{DeviceID='test-device';Service='test-driver';Present=$false}}
}
function Invoke-OmniaPnP($arguments){
  $script:calls+=,$arguments
  if($arguments[0] -eq '/export-driver'){
    if($script:failExport){return @{code=5;output='Simulated export failure'}}
    Copy-Item -LiteralPath $script:inf -Destination (Join-Path $arguments[2] 'original.inf')
    if($script:badCopy){Set-Content -LiteralPath (Join-Path $arguments[2] 'original.inf') -Value 'different package'}
    if($script:changeOnExport){$script:changed=$true}
    return @{code=0;output='Exported fixture'}
  }
  if($arguments[0] -eq '/delete-driver'){return @{code=3010;output='Simulated restart needed'}}
  throw 'Unexpected command.'
}
function New-FixtureData($name){@{inf='oem12.inf';hash=(Get-FileHash -LiteralPath $script:inf -Algorithm SHA256).Hash;provider='Test';version='1';devices=@('test-device');connected=@();phrase='REMOVE oem12.inf';backup=(Join-Path $Root $name)}}
function Reject($data,$pattern){try{Invoke-OmniaDriver 'driver-remove' $data | Out-Null;throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch $pattern){throw}}}
$bad=New-FixtureData 'bad-phrase';$bad.phrase='wrong';Reject $bad 'confirmation'
$bad=New-FixtureData 'bad-hash';$bad.hash='a'*64;Reject $bad 'changed'
$script:critical=$true;Reject (New-FixtureData 'critical') 'Acknowledge';$script:critical=$false
$script:changed=$true;Reject (New-FixtureData 'changed-device') 'changed';$script:changed=$false
if($script:calls.Count){throw 'A command was called before validation.'}
$script:failExport=$true;Reject (New-FixtureData 'failed-export') 'Backup failed';$script:failExport=$false
$script:badCopy=$true;Reject (New-FixtureData 'bad-export') 'did not match';$script:badCopy=$false
$script:changeOnExport=$true;Reject (New-FixtureData 'device-changed-after-export') 'changed during backup';$script:changeOnExport=$false;$script:changed=$false
if(@($script:calls | Where-Object {$_[0] -eq '/delete-driver'}).Count){throw 'Removal ran after a failed backup.'}
$list=Invoke-OmniaDriver 'driver-list' @{} | ConvertFrom-Json
if($list.Count -ne 1 -or $list[0].inf -ne 'oem12.inf' -or $list[0].bootCritical){throw 'Full store inventory fields differ.'}
$result=Invoke-OmniaDriver 'driver-remove' (New-FixtureData 'good-export') | ConvertFrom-Json
if(!$result.restartRequired -or $result.exitCode -ne 3010){throw 'Restart requirement lost.'}
if(($script:calls[-1] -join ' ') -ne '/delete-driver oem12.inf /uninstall'){throw 'Unexpected deletion flags.'}
if(!(Test-Path -LiteralPath (Join-Path $Root 'good-export\original.inf'))){throw 'Backup missing.'}
$script:critical=$true;$approved=New-FixtureData 'approved-critical';$approved.acknowledgedRisk=$true
Invoke-OmniaDriver 'driver-remove' $approved | Out-Null
Write-Output 'Driver helper guards and backup-before-removal passed with simulated commands.'
