$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$issues=@();$disks=@();$volumes=@()
try {$disks=@(Get-Disk | ForEach-Object {@{number=[int]$_.Number;name=[string]$_.FriendlyName;size=[double]$_.Size;bus=[string]$_.BusType;style=[string]$_.PartitionStyle;health=[string]$_.HealthStatus;offline=[bool]$_.IsOffline;readOnly=[bool]$_.IsReadOnly;system=[bool]($_.IsSystem -or $_.IsBoot)}})}catch{$issues+='Physical disks: '+$_.Exception.Message}
try {
  $parts=@(Get-Partition -ErrorAction Stop)
  $byPath=@{}
  foreach($p in $parts){foreach($access in $p.AccessPaths){if($access){$byPath[$access]=$p}}}
  $volumes=@(Get-Volume | ForEach-Object {
    $v=$_;$p=if($v.Path){$byPath[$v.Path]}else{$null}
    $letter=[string]$v.DriveLetter;$root=if($letter){$letter+':\'}else{''}
    @{id=[string]$v.UniqueId;root=$root;label=[string]$v.FileSystemLabel;fs=[string]$v.FileSystem;size=[double]$v.Size;free=[double]$v.SizeRemaining;type=[string]$v.DriveType;health=[string]$v.HealthStatus;disk=$(if($null -ne $p){[int]$p.DiskNumber}else{$null});partition=$(if($null -ne $p){[int]$p.PartitionNumber}else{$null});partitionType=[string]$p.Type;gptType=[string]$p.GptType;system=[bool]$p.IsSystem;boot=[bool]$p.IsBoot}
  })
}catch{$issues+='Volumes: '+$_.Exception.Message}
@{disks=$disks;volumes=$volumes;issues=$issues} | ConvertTo-Json -Depth 5 -Compress
