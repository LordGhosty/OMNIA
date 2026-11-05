$env:PSModulePath=Join-Path $PSHOME 'Modules'
function Get-OmniaRule($name,$store='PersistentStore') {
  # Exact rule names.
  $rule=Get-NetFirewallRule -PolicyStore $store | Where-Object {$_.Name -ceq $name} | Select-Object -First 1
  return $rule
}
function Get-OmniaRuleDetails($rule) {
  if(!$rule){throw 'The firewall rule no longer exists.'}
  $port=$rule | Get-NetFirewallPortFilter;$address=$rule | Get-NetFirewallAddressFilter;$app=$rule | Get-NetFirewallApplicationFilter;$service=$rule | Get-NetFirewallServiceFilter;$interface=$rule | Get-NetFirewallInterfaceFilter;$type=$rule | Get-NetFirewallInterfaceTypeFilter;$security=$rule | Get-NetFirewallSecurityFilter
  $data=[ordered]@{name=[string]$rule.Name;displayName=[string]$rule.DisplayName;description=[string]$rule.Description;enabled=[string]$rule.Enabled;direction=[string]$rule.Direction;action=[string]$rule.Action;profile=[string]$rule.Profile;group=[string]$rule.Group;edge=[string]$rule.EdgeTraversalPolicy;loose=[bool]$rule.LooseSourceMapping;localOnly=[bool]$rule.LocalOnlyMapping;owner=[string]$rule.Owner;platform=@($rule.Platform);protocol=[string]$port.Protocol;localPort=@($port.LocalPort);remotePort=@($port.RemotePort);icmp=@($port.IcmpType);dynamic=[string]$port.DynamicTarget;localAddress=@($address.LocalAddress);remoteAddress=@($address.RemoteAddress);program=[Environment]::ExpandEnvironmentVariables([string]$app.Program);package=[string]$app.Package;service=[string]$service.Service;interface=@($interface.InterfaceAlias);interfaceType=[string]$type.InterfaceType;authentication=[string]$security.Authentication;encryption=[string]$security.Encryption;override=[bool]$security.OverrideBlockRules;localUser=[string]$security.LocalUser;remoteUser=[string]$security.RemoteUser;remoteMachine=[string]$security.RemoteMachine}
  $identity=@(@($rule,$port,$address,$app,$service,$interface,$type,$security) | ForEach-Object {if($_.CimInstanceProperties){$properties=[ordered]@{};foreach($p in ($_.CimInstanceProperties | Sort-Object Name)){$properties[$p.Name]=$p.Value};$properties}else{$_}})
  $json=ConvertTo-Json -InputObject $identity -Depth 12 -Compress;$sha=[Security.Cryptography.SHA256]::Create();try{$hash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
  return @{values=$data;hash=$hash}
}
function Get-OmniaFirewall {
  $profiles=@(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {@{name=[string]$_.Name;enabled=[bool]$_.Enabled;inbound=[string]$_.DefaultInboundAction;outbound=[string]$_.DefaultOutboundAction;localRules=[string]$_.AllowLocalFirewallRules}})
  $local=@{};Get-NetFirewallRule -PolicyStore PersistentStore | ForEach-Object {$local[[string]$_.Name]=$true}
  $rules=@(Get-NetFirewallRule -PolicyStore ActiveStore -TracePolicyStore | Where-Object {$_.Name -notlike 'OMNIA-BACKUP-*'} | ForEach-Object {@{name=[string]$_.Name;displayName=[string]$_.DisplayName;description=[string]$_.Description;enabled=[string]$_.Enabled;direction=[string]$_.Direction;action=[string]$_.Action;profile=[string]$_.Profile;source=[string]$_.PolicyStoreSource;sourceType=[string]$_.PolicyStoreSourceType;local=([string]$_.PolicyStoreSourceType -eq 'Local' -and $local.ContainsKey([string]$_.Name))}})
  return @{profiles=$profiles;rules=$rules}
}
function Assert-OmniaFirewallSpec($s) {
  if(!$s -or !$s.displayName -or $s.displayName.Length -gt 120 -or $s.displayName -match '[\x00-\x1f]'){throw 'Enter a rule name of 1 to 120 characters.'}
  if($s.direction -notin @('Inbound','Outbound') -or $s.action -notin @('Allow','Block') -or $s.protocol -notin @('TCP','UDP','Any')){throw 'Unsupported rule options.'}
  if(!$s.profiles -or @($s.profiles | Where-Object {$_ -notin @('Domain','Private','Public')}).Count){throw 'Choose valid network profiles.'}
  if($s.program -ne 'Any' -and ($s.program -notmatch '^[A-Za-z]:\\[^*?"\r\n]+\.exe$' -or !(Test-Path -LiteralPath $s.program -PathType Leaf))){throw 'Choose an existing local executable.'}
  foreach($ports in @($s.localPort,$s.remotePort)){if($ports -ne 'Any'){if($s.protocol -eq 'Any'){throw 'Ports require TCP or UDP.'};foreach($range in ($ports -split ',')){if($range -notmatch '^\d{1,5}(-\d{1,5})?$'){throw 'Invalid ports.'};$numbers=@($range -split '-' | ForEach-Object {[int]$_});if(($numbers | Where-Object {$_ -lt 1 -or $_ -gt 65535}) -or ($numbers.Count -eq 2 -and $numbers[0] -gt $numbers[1])){throw 'Ports must be between 1 and 65535.'}}}}
  foreach($address in @($s.remoteAddress -split ',')){if($address -in @('Any','LocalSubnet')){continue};$bits=$address -split '/';$ip=$null;if($bits.Count -gt 2 -or ![Net.IPAddress]::TryParse($bits[0],[ref]$ip)){throw 'Use IP addresses, CIDR subnets or LocalSubnet.'};if($bits.Count -eq 2 -and ($bits[1] -notmatch '^\d{1,3}$' -or [int]$bits[1] -gt $(if($ip.AddressFamily -eq 'InterNetwork'){32}else{128}))){throw 'Invalid subnet prefix.'}}
  if($s.program -eq 'Any' -and $s.localPort -eq 'Any' -and $s.remotePort -eq 'Any'){throw 'Choose an application or port scope.'}
}
function Invoke-OmniaFirewall($action,$data) {
  if($action -eq 'firewall-list'){return (Get-OmniaFirewall | ConvertTo-Json -Depth 6 -Compress)}
  if($action -eq 'firewall-detail'){
    $active=Get-OmniaRule $data.name 'ActiveStore';$persistent=Get-OmniaRule $data.name;$local=([string]$active.PolicyStoreSourceType -eq 'Local' -and $null -ne $persistent)
    $details=Get-OmniaRuleDetails $(if($local){$persistent}else{$active});$details.local=$local;return ($details | ConvertTo-Json -Depth 7 -Compress)
  }
  if($action -ne 'firewall-change'){throw 'Unsupported firewall action.'}
  $op=[string]$data.operation;$name=[string]$data.name
  if($op -eq 'create'){
    Assert-OmniaFirewallSpec $data.spec;if($name -notmatch '^OMNIA-[a-f0-9-]{36}$' -or (Get-OmniaRule $name)){throw 'Invalid or existing rule identity.'}
    $s=$data.spec
    New-NetFirewallRule -PolicyStore PersistentStore -Name $name -DisplayName $s.displayName -Group 'OMNIA' -Enabled True -Direction $s.direction -Action $s.action -Profile @($s.profiles) -Protocol $s.protocol -Program $s.program -LocalPort @($s.localPort -split ',') -RemotePort @($s.remotePort -split ',') -RemoteAddress @($s.remoteAddress -split ',') | Out-Null
    return (@{name=$name;after=(Get-OmniaRuleDetails (Get-OmniaRule $name)).hash;operation=$op} | ConvertTo-Json -Compress)
  }
  if($op -eq 'undo-create'){
    if($name -notmatch '^OMNIA-[a-f0-9-]{36}$'){throw 'Invalid created rule.'}
    $rule=Get-OmniaRule $name;if((Get-OmniaRuleDetails $rule).hash -cne $data.expected){throw 'The rule changed. Undo would overwrite another change.'}
    $rule | Remove-NetFirewallRule;return '{"undone":true}'
  }
  if($op -eq 'undo'){
    if($data.backup -notmatch '^OMNIA-BACKUP-[a-f0-9-]{36}$'){throw 'Invalid backup identity.'}
    $backup=Get-OmniaRule $data.backup;if((Get-OmniaRuleDetails $backup).hash -cne $data.backupHash){throw 'The backup changed. Undo is unavailable.'}
    $rule=Get-OmniaRule $name
    if($data.expected){if((Get-OmniaRuleDetails $rule).hash -cne $data.expected){throw 'The rule changed. Undo would overwrite another change.'}}elseif($rule){throw 'A rule with this name now exists.'}
    # Native filter copy.
    if($rule){$rule | Remove-NetFirewallRule}
    try{$backup | Copy-NetFirewallRule -NewName $name -NewPolicyStore PersistentStore;Get-OmniaRule $name | Set-NetFirewallRule -Enabled $data.wasEnabled}catch{throw ('Restore failed; disabled backup remains as '+$data.backup+'. '+$_.Exception.Message)}
    $backup | Remove-NetFirewallRule;return '{"undone":true}'
  }
  if($op -notin @('enable','disable','delete','edit')){throw 'Unsupported rule change.'}
  $active=Get-OmniaRule $name 'ActiveStore';if(!$active -or [string]$active.PolicyStoreSourceType -ne 'Local'){throw 'Managed and non-local rules cannot be changed here.'}
  $rule=Get-OmniaRule $name;$details=Get-OmniaRuleDetails $rule
  if($details.hash -cne $data.expected){throw 'The rule changed. Refresh and review it again.'}
  if($op -eq 'edit'){Assert-OmniaFirewallSpec $data.spec}
  $backup='OMNIA-BACKUP-'+[guid]::NewGuid().ToString()
  $rule | Copy-NetFirewallRule -NewName $backup -NewPolicyStore PersistentStore
  Get-OmniaRule $backup | Set-NetFirewallRule -Enabled False
  $saved=Get-OmniaRuleDetails (Get-OmniaRule $backup)
  try{
    if((Get-OmniaRuleDetails (Get-OmniaRule $name)).hash -cne $data.expected){throw 'The rule changed during backup.'}
    switch($op){
      'enable' {$rule | Set-NetFirewallRule -Enabled True}
      'disable' {$rule | Set-NetFirewallRule -Enabled False}
      'delete' {$rule | Remove-NetFirewallRule}
      'edit' {$s=$data.spec;$rule | Set-NetFirewallRule -DisplayName $s.displayName -Direction $s.direction -Action $s.action -Profile @($s.profiles) -Protocol $s.protocol -Program $s.program -LocalPort @($s.localPort -split ',') -RemotePort @($s.remotePort -split ',') -RemoteAddress @($s.remoteAddress -split ',')}
    }
  }catch{throw ('Change failed; disabled backup retained: '+$backup+'. '+$_.Exception.Message)}
  $after=if($op -eq 'delete'){''}else{(Get-OmniaRuleDetails (Get-OmniaRule $name)).hash}
  return (@{operation=$op;name=$name;after=$after;backup=$backup;backupHash=$saved.hash;wasEnabled=$details.values.enabled} | ConvertTo-Json -Compress)
}
