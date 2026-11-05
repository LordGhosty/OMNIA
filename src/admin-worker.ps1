$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$pipe=[IO.Pipes.NamedPipeClientStream]::new('.','__PIPE__',[IO.Pipes.PipeDirection]::InOut)
$pipe.Connect(15000)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OmniaPipePeer {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
}
'@
[uint32]$serverId=0
if(![OmniaPipePeer]::GetNamedPipeServerProcessId($pipe.SafePipeHandle,[ref]$serverId) -or $serverId -ne __PARENT__){$pipe.Dispose();throw 'The administrator connection has an unexpected owner.'}
$reader=[IO.StreamReader]::new($pipe)
$writer=[IO.StreamWriter]::new($pipe);$writer.AutoFlush=$true
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$writer.WriteLine((@{hello='__TOKEN__';elevated=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress))
__DRIVER_ACTIONS__
function Invoke-OmniaAction($request) {
  $action=[string]$request.action;$data=$request.data
  if($action -in @('driver-list','driver-backup','driver-remove')){return (Invoke-OmniaDriver $action $data)}
  if($action -in @('firewall-list','firewall-detail','firewall-change')){return (Invoke-OmniaFirewall $action $data)}
  if($action -eq 'repair-run'){return (Invoke-OmniaRepair $data)}
  if($action -in @('flush-dns','register-dns','renew-dhcp','restart-adapter','dns-cloudflare','dns-google','dns-auto')) {
    if($action -eq 'flush-dns'){Clear-DnsClientCache;return 'DNS cache cleared.'}
    if($action -eq 'register-dns'){Register-DnsClient;return 'DNS registration requested.'}
    $index=[int]$data.index
    if($index -lt 1){throw 'Invalid adapter.'}
    $adapter=Get-NetAdapter -IncludeHidden | Where-Object {$_.ifIndex -eq $index} | Select-Object -First 1
    if(!$adapter -or ($data.guid -and [string]$adapter.InterfaceGuid -ne [string]$data.guid)){throw 'The adapter changed. Refresh and try again.'}
    switch($action){
      'restart-adapter' {$adapter | Restart-NetAdapter -Confirm:$false}
      'renew-dhcp' {$config=Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "InterfaceIndex=$index";if(!$config.DHCPEnabled){throw 'This adapter does not use DHCP.'};$r=Invoke-CimMethod -InputObject $config -MethodName RenewDHCPLease;if($r.ReturnValue -notin @(0,1)){throw "DHCP returned $($r.ReturnValue)."}}
      'dns-auto' {Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4 | Set-DnsClientServerAddress -ResetServerAddresses}
      'dns-cloudflare' {Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4 | Set-DnsClientServerAddress -ServerAddresses @('1.1.1.1','1.0.0.1')}
      'dns-google' {Get-DnsClientServerAddress -InterfaceIndex $index -AddressFamily IPv4 | Set-DnsClientServerAddress -ServerAddresses @('8.8.8.8','8.8.4.4')}
    }
    return 'Network action completed.'
  }
  if($action -notin @('drive-label','drive-letter','drive-format','drive-reset')){throw 'Unsupported administrator action.'}
  $disk=Get-Disk -Number ([int]$data.number)
  if($disk.BusType -ne 'USB' -or $disk.IsBoot -or $disk.IsSystem -or $disk.IsOffline -or $disk.IsReadOnly){throw 'Only online, writable, non-system USB disks are supported.'}
  if(!$data.uniqueId -or [string]$disk.UniqueId -cne [string]$data.uniqueId -or [string]$disk.SerialNumber -cne [string]$data.serial -or [long]$disk.Size -ne [long]$data.size){throw 'The disk identity changed. Refresh and select it again.'}
  $parts=@(Get-Partition -DiskNumber $disk.Number -ErrorAction SilentlyContinue)
  if($parts | Where-Object {$_.IsBoot -or $_.IsSystem -or $_.DriveLetter -eq $env:SystemDrive.TrimEnd(':')}){throw 'A protected partition was found.'}
  $label=[string]$data.label
  if($label.Length -gt 32 -or $label -match '[\\/:*?"<>|\x00-\x1f]'){throw 'Invalid volume label.'}
  if($action -eq 'drive-reset'){
    if($data.erase -cne ('ERASE '+$disk.Number)){throw 'Erase confirmation is missing.'}
    if($data.fileSystem -notin @('NTFS','exFAT')){throw 'Choose NTFS or exFAT.'}
    if($disk.PartitionStyle -ne 'RAW'){Clear-Disk -Number $disk.Number -RemoveData -RemoveOEM -Confirm:$false}
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT | Out-Null
    $new=New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
    $new | Format-Volume -FileSystem $data.fileSystem -NewFileSystemLabel $label -Confirm:$false -Force | Out-Null
    return 'Disk reset to one GPT data volume. This is not a secure erase.'
  }
  $part=$parts | Where-Object {$_.PartitionNumber -eq [int]$data.partition} | Select-Object -First 1
  if(!$part -or [long]$part.Offset -ne [long]$data.offset -or [long]$part.Size -ne [long]$data.partitionSize){throw 'The selected partition changed.'}
  $volume=$part | Get-Volume
  if(!$volume -or $volume.DriveType -notin @('Removable','Fixed')){throw 'No supported data volume exists on this partition.'}
  if($action -eq 'drive-letter'){
    $letter=[string]$data.letter
    if($letter -cnotmatch '^[D-Z]$'){throw 'Choose an available letter from D to Z.'}
    if(Get-PSDrive -Name $letter -ErrorAction SilentlyContinue){throw 'That drive letter is already in use.'}
    Set-Partition -DiskNumber $disk.Number -PartitionNumber $part.PartitionNumber -NewDriveLetter $letter
    return "Drive letter assigned: ${letter}:"
  }
  if($action -eq 'drive-label'){$volume | Set-Volume -NewFileSystemLabel $label;return 'Volume renamed.'}
  if($data.erase -cne ('ERASE '+$disk.Number)){throw 'Erase confirmation is missing.'}
  if($data.fileSystem -notin @('NTFS','exFAT','FAT32')){throw 'Unsupported file system.'}
  if($data.fileSystem -eq 'FAT32' -and $part.Size -gt 32GB){throw 'FAT32 formatting is limited to 32 GiB here. Choose exFAT.'}
  $volume | Format-Volume -FileSystem $data.fileSystem -NewFileSystemLabel $label -Confirm:$false -Force | Out-Null
  return 'Volume quick-formatted. This is not a secure erase.'
}
try {
  while($pipe.IsConnected){
    $read=$reader.ReadLineAsync()
    while(!$read.Wait(1000)){if(!(Get-Process -Id __PARENT__ -ErrorAction SilentlyContinue)){return}}
    $line=$read.Result;if(!$line){break};if($line.Length -gt 16384){throw 'Request too large.'}
    $request=$line | ConvertFrom-Json
    if($request.action -eq 'shutdown'){break}
    try{$message=Invoke-OmniaAction $request;$reply=@{id=$request.id;ok=$true;message=[string]$message}}
    catch{$reply=@{id=$request.id;ok=$false;error=$_.Exception.Message}}
    $writer.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  }
}finally{$writer.Dispose();$reader.Dispose();$pipe.Dispose()}
