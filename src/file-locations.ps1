$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$items = @(Get-CimInstance Win32_LogicalDisk | ForEach-Object {
    $label = if ($_.VolumeName) { $_.VolumeName } elseif ($_.DriveType -eq 2) { 'Removable drive' } elseif ($_.DriveType -eq 4) { 'Network drive' } elseif ($_.DriveType -eq 5) { 'Optical drive' } else { 'Local disk' }
    [pscustomobject]@{ name = "$label ($($_.DeviceID))"; path = "$($_.DeviceID)\"; kind = 'drive'; size = $_.Size; free = $_.FreeSpace }
})
ConvertTo-Json -InputObject $items -Compress
