$ErrorActionPreference = 'Stop'
$target = $env:OMNIA_KEY_DIRECTORY
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:OMNIA_KEY_ACL_MODE -eq 'set') {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.Directory]::SetAccessControl($target, $acl)
    foreach ($file in [IO.Directory]::GetFiles($target)) {
        $fileAcl = New-Object Security.AccessControl.FileSecurity
        $fileAcl.SetAccessRuleProtection($true, $false)
        $fileAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, 'FullControl', 'Allow')))
        [IO.File]::SetAccessControl($file, $fileAcl)
    }
}
$items = @($target) + [IO.Directory]::GetFileSystemEntries($target)
foreach ($item in $items) {
    $acl = if ([IO.Directory]::Exists($item)) { [IO.Directory]::GetAccessControl($item) } else { [IO.File]::GetAccessControl($item) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Key ownership could not be verified.' }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $user.Value) { throw 'Key permissions could not be restricted.' }
    }
}
[Console]::WriteLine('OK')
