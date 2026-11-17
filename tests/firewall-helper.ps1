param([string]$Source)
$ErrorActionPreference='Stop'
. $Source
$script:rules=@{};$script:commands=@()
function New-Fixture($name){[pscustomobject]@{Name=$name;DisplayName='Fixture';Description='';Enabled='True';Direction='Inbound';Action='Block';Profile='Private';Group='';EdgeTraversalPolicy='Block';LooseSourceMapping=$false;LocalOnlyMapping=$false;Owner='';Platform=@();PolicyStoreSourceType='Local';Protocol='TCP';LocalPort=@('443');RemotePort=@('Any');IcmpType=@('Any');DynamicTarget='Any';LocalAddress=@('Any');RemoteAddress=@('LocalSubnet');Program='Any';Package='Any';Service='Any';InterfaceAlias=@('Any');InterfaceType='Any';Authentication='NotRequired';Encryption='NotRequired';OverrideBlockRules=$false;LocalUser='Any';RemoteUser='Any';RemoteMachine='Any'}}
function Get-NetFirewallRule {param($PolicyStore,[switch]$TracePolicyStore) $script:rules.Values}
foreach($name in @('Get-NetFirewallPortFilter','Get-NetFirewallAddressFilter','Get-NetFirewallApplicationFilter','Get-NetFirewallServiceFilter','Get-NetFirewallInterfaceFilter','Get-NetFirewallInterfaceTypeFilter','Get-NetFirewallSecurityFilter')){Set-Item -Path ('function:'+ $name) -Value {param([Parameter(ValueFromPipeline)]$InputObject) process {$InputObject}}}
function Copy-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject,$NewName,$NewPolicyStore) process {if($script:rules.ContainsKey($NewName)){throw 'Exists'};$copy=$InputObject | ConvertTo-Json -Depth 6 | ConvertFrom-Json;$copy.Name=$NewName;$script:rules[$NewName]=$copy;$script:commands+='copy'}}
function Set-NetFirewallRule {
  param([Parameter(ValueFromPipeline)]$InputObject,$Enabled,$DisplayName,$Direction,$Action,$Profile,$Protocol,$Program,$LocalPort,$RemotePort,$RemoteAddress,$LocalAddress,$Authentication,$Encryption,$IcmpType,$Service,$InterfaceType,$Description)
  process {
    foreach($key in @('Enabled','DisplayName','Direction','Action','Profile','Protocol','Program','LocalPort','RemotePort','RemoteAddress','LocalAddress','Authentication','Encryption','IcmpType','Service','InterfaceType','Description')){
      if($PSBoundParameters.ContainsKey($key)){$InputObject.$key=$PSBoundParameters[$key]}
    }
    $script:commands+='set'
  }
}
function New-NetFirewallRule {
  param($PolicyStore,$Name,$Group,$Enabled,$DisplayName,$Direction,$Action,$Profile,$Protocol,$Program,$LocalPort,$RemotePort,$RemoteAddress,$LocalAddress,$Authentication,$Encryption,$IcmpType,$Service,$InterfaceType,$Description)
  $rule=New-Fixture $Name
  foreach($key in $PSBoundParameters.Keys){if($key -ne 'PolicyStore'){$rule.$key=$PSBoundParameters[$key]}}
  $script:rules[$Name]=$rule
  $script:commands+='new'
}
function Remove-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject) process {$script:rules.Remove($InputObject.Name);$script:commands+='remove'}}
function Reject($data,$pattern){try{Invoke-OmniaFirewall 'firewall-change' $data | Out-Null;throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch $pattern){throw}}}
$script:rules['fixture']=New-Fixture 'fixture';$before=Get-OmniaRuleDetails $script:rules['fixture']
Reject @{operation='delete';name='fixture';expected='wrong'} 'changed'
if($script:commands.Count){throw 'A write occurred before identity validation.'}
$removed=Invoke-OmniaFirewall 'firewall-change' @{operation='delete';name='fixture';expected=$before.hash} | ConvertFrom-Json
if($script:rules.ContainsKey('fixture') -or $script:rules[$removed.backup].Enabled -ne 'False'){throw 'Delete/disabled backup failed.'}
Invoke-OmniaFirewall 'firewall-change' @{operation='undo';name='fixture';backup=$removed.backup;backupHash=$removed.backupHash;wasEnabled=$removed.wasEnabled;expected=''} | Out-Null
if((Get-OmniaRuleDetails $script:rules['fixture']).hash -cne $before.hash){throw 'Restored rule changed its filters.'}
$disabled=Invoke-OmniaFirewall 'firewall-change' @{operation='disable';name='fixture';expected=$before.hash} | ConvertFrom-Json
$script:rules['fixture'].RemoteAddress=@('Any')
Reject @{operation='undo';name='fixture';backup=$disabled.backup;backupHash=$disabled.backupHash;wasEnabled=$disabled.wasEnabled;expected=$disabled.after} 'changed'
$script:rules['fixture'].PolicyStoreSourceType='GroupPolicy'
Reject @{operation='delete';name='fixture';expected=(Get-OmniaRuleDetails $script:rules['fixture']).hash} 'non-local'
try{Assert-OmniaFirewallSpec @{displayName='test';direction='Inbound';action='Allow';protocol='TCP';profiles=@('Private');program='Any';localPort='443;whoami';remotePort='Any';remoteAddress='Any'};throw 'EXPECTED REJECTION'}catch{if($_.Exception.Message -notmatch 'ports'){throw}}
$spec=@{displayName='Fixture secure rule';direction='Inbound';action='Allow';protocol='Any';profiles=@('Private');program='Any';localPort='Any';remotePort='Any';remoteAddress='Any';localAddress='192.0.2.0/24';authentication='Required';encryption='Required';service='FixtureService';interfaceType='Wireless';description='Secure fixture';icmp='Any'}
$name='OMNIA-'+[guid]::NewGuid().ToString()
$created=Invoke-OmniaFirewall 'firewall-change' @{operation='create';name=$name;spec=$spec} | ConvertFrom-Json
$values=(Get-OmniaRuleDetails $script:rules[$name]).values
if($values.authentication -ne 'Required' -or $values.encryption -ne 'Required' -or $values.localAddress[0] -ne '192.0.2.0/24' -or $values.program -ne 'Any' -or $values.service -ne 'FixtureService' -or $values.interfaceType -ne 'Wireless'){throw 'Secure rule fields were lost.'}
Invoke-OmniaFirewall 'firewall-change' @{operation='undo-create';name=$name;expected=$created.after} | Out-Null
if($script:rules.ContainsKey($name)){throw 'Undo create failed.'}
$spec.authentication='NoEncap'
$count=$script:commands.Count
Reject @{operation='create';name=$name;spec=$spec} 'Encryption requires'
if($script:commands.Count -ne $count){throw 'Invalid security settings reached a mutation.'}
$spec.encryption='NotRequired'
$spec.protocol='ICMPv6';$spec.icmp='128,129:0'
$created=Invoke-OmniaFirewall 'firewall-change' @{operation='create';name=$name;spec=$spec} | ConvertFrom-Json
if(($script:rules[$name].IcmpType -join ',') -ne '128,129:0'){throw 'ICMP scope was lost.'}
$edit=@{displayName='Renamed fixture';direction='Inbound';action='Allow';protocol='ICMPv6';profiles=@('Private');program='Any';localPort='Any';remotePort='Any';remoteAddress='LocalSubnet'}
$changed=Invoke-OmniaFirewall 'firewall-change' @{operation='edit';name=$name;expected=$created.after;spec=$edit} | ConvertFrom-Json
if($script:rules[$name].Authentication -ne 'NoEncap' -or $script:rules[$name].Service -ne 'FixtureService' -or $script:rules[$name].IcmpType[0] -ne '128'){throw 'Editing lost omitted conditions.'}
Invoke-OmniaFirewall 'firewall-change' @{operation='undo';name=$name;expected=$changed.after;backup=$changed.backup;backupHash=$changed.backupHash;wasEnabled=$changed.wasEnabled} | Out-Null
if((Get-OmniaRuleDetails $script:rules[$name]).hash -cne $created.after){throw 'Undo lost secure rule conditions.'}
$spec.icmp='256'
Reject @{operation='create';name=('OMNIA-'+[guid]::NewGuid());spec=$spec} 'ICMP types'
'Firewall backup, deletion, restoration, conflict and policy guards passed with simulated commands.'
