param([string]$Source)
$ErrorActionPreference='Stop'
. $Source
$script:rules=@{};$script:commands=@()
function New-Fixture($name){[pscustomobject]@{Name=$name;DisplayName='Fixture';Description='';Enabled='True';Direction='Inbound';Action='Block';Profile='Private';Group='';EdgeTraversalPolicy='Block';LooseSourceMapping=$false;LocalOnlyMapping=$false;Owner='';Platform=@();PolicyStoreSourceType='Local';Protocol='TCP';LocalPort=@('443');RemotePort=@('Any');IcmpType=@('Any');DynamicTarget='Any';LocalAddress=@('Any');RemoteAddress=@('LocalSubnet');Program='Any';Package='Any';Service='Any';InterfaceAlias=@('Any');InterfaceType='Any';Authentication='NotRequired';Encryption='NotRequired';OverrideBlockRules=$false;LocalUser='Any';RemoteUser='Any';RemoteMachine='Any'}}
function Get-NetFirewallRule {param($PolicyStore,[switch]$TracePolicyStore) $script:rules.Values}
foreach($name in @('Get-NetFirewallPortFilter','Get-NetFirewallAddressFilter','Get-NetFirewallApplicationFilter','Get-NetFirewallServiceFilter','Get-NetFirewallInterfaceFilter','Get-NetFirewallInterfaceTypeFilter','Get-NetFirewallSecurityFilter')){Set-Item -Path ('function:'+ $name) -Value {param([Parameter(ValueFromPipeline)]$InputObject) process {$InputObject}}}
function Copy-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject,$NewName,$NewPolicyStore) process {if($script:rules.ContainsKey($NewName)){throw 'Exists'};$copy=$InputObject | ConvertTo-Json -Depth 6 | ConvertFrom-Json;$copy.Name=$NewName;$script:rules[$NewName]=$copy;$script:commands+='copy'}}
function Set-NetFirewallRule {param([Parameter(ValueFromPipeline)]$InputObject,$Enabled,$DisplayName,$Direction,$Action,$Profile,$Protocol,$Program,$LocalPort,$RemotePort,$RemoteAddress) process {foreach($key in @('Enabled','DisplayName','Direction','Action','Profile','Protocol','Program','LocalPort','RemotePort','RemoteAddress')){if($PSBoundParameters.ContainsKey($key)){$InputObject.$key=$PSBoundParameters[$key]}};$script:commands+='set'}}
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
'Firewall backup, deletion, restoration, conflict and policy guards passed with simulated commands.'
