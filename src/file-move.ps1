$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        [System.IO.File]::Move([string]$request.from, [string]$request.to)
        [Console]::WriteLine('{"ok":true}')
    } catch {
        [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress))
    }
}
