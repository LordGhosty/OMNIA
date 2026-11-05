param([string]$Source)
$ErrorActionPreference='Stop'
. $Source
$writer=[IO.StringWriter]::new();$request=@{id='fixture'};$script:calls=@();$script:exit=0
function Invoke-OmniaRepairCommand($file,$arguments){$script:calls+=@{file=$file;arguments=$arguments};'Fixture progress';$script:repairExit=$script:exit}
function Get-Volume {param($DriveLetter) @{UniqueId='fixture-volume'}}
try{Invoke-OmniaRepair @{task='anything'};throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch 'Unsupported'){throw}}
try{Invoke-OmniaRepair @{task='disk-check';volume='C: & whoami';volumeId='fixture-volume'};throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch 'mounted'){throw}}
try{Invoke-OmniaRepair @{task='disk-check';volume='D:';volumeId='changed'};throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch 'changed'){throw}}
if($script:calls.Count){throw 'Command executed before validation.'}
$result=Invoke-OmniaRepair @{task='repair-sequence'} | ConvertFrom-Json
if($result.steps.Count -ne 2 -or ($script:calls[0].arguments -join ' ') -ne '/Online /Cleanup-Image /RestoreHealth /English /NoRestart' -or ($script:calls[1].arguments -join ' ') -ne '/scannow'){throw 'Repair sequence mismatch.'}
if($writer.ToString() -notmatch 'Fixture progress'){throw 'Progress was not streamed.'}
$script:exit=3010;$script:calls=@();$result=Invoke-OmniaRepair @{task='repair-sequence'} | ConvertFrom-Json
if($script:calls.Count -ne 1 -or !$result.restartRequired){throw 'Restart did not stop the sequence.'}
$script:exit=5;$script:calls=@();$result=Invoke-OmniaRepair @{task='repair-sequence'} | ConvertFrom-Json
if($script:calls.Count -ne 1 -or $result.steps[0].exitCode -ne 5){throw 'Failed DISM did not stop the sequence.'}
$script:exit=0;$script:calls=@();Invoke-OmniaRepair @{task='disk-check';volume='D:';volumeId='fixture-volume'} | Out-Null
if(($script:calls[0].arguments -join ' ') -ne 'D:'){throw 'Disk check unexpectedly changes the volume.'}
'Repair sequence, progress, volume identity and error handling passed with simulated commands.'
