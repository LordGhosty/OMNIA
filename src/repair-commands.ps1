function Invoke-OmniaRepairCommand($file,$arguments){
  $script:repairExit=$null;$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$file;$info.Arguments=$arguments -join ' ';$info.UseShellExecute=$false;$info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.RedirectStandardInput=$true
  $encoding=[Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
  $info.StandardOutputEncoding=if([IO.Path]::GetFileName($file) -ieq 'sfc.exe'){[Text.Encoding]::Unicode}else{$encoding};$info.StandardErrorEncoding=$encoding
  $process=[Diagnostics.Process]::new();$process.StartInfo=$info
  try{if(!$process.Start()){throw 'Windows could not start this command.'};$process.StandardInput.Close();$out=$process.StandardOutput.ReadLineAsync();$err=$process.StandardError.ReadLineAsync()
    while($null -ne $out -or $null -ne $err){$read=$false
      if($null -ne $out -and $out.IsCompleted){$line=$out.GetAwaiter().GetResult();if($null -eq $line){$out=$null}else{Write-Output $line;$out=$process.StandardOutput.ReadLineAsync()};$read=$true}
      if($null -ne $err -and $err.IsCompleted){$line=$err.GetAwaiter().GetResult();if($null -eq $line){$err=$null}else{Write-Output $line;$err=$process.StandardError.ReadLineAsync()};$read=$true}
      if(!$read){Start-Sleep -Milliseconds 30}
    };$process.WaitForExit();$script:repairExit=$process.ExitCode
  }finally{$process.Dispose()}
}
function Invoke-OmniaRepair($data) {
  $system=Join-Path $env:windir 'System32';$steps=@()
  switch([string]$data.task){
    'dism-check' {$steps+=@{exe='dism.exe';args=@('/Online','/Cleanup-Image','/CheckHealth','/English','/NoRestart')}}
    'dism-scan' {$steps+=@{exe='dism.exe';args=@('/Online','/Cleanup-Image','/ScanHealth','/English','/NoRestart')}}
    'dism-repair' {$steps+=@{exe='dism.exe';args=@('/Online','/Cleanup-Image','/RestoreHealth','/English','/NoRestart')}}
    'sfc-check' {$steps+=@{exe='sfc.exe';args=@('/verifyonly')}}
    'sfc-repair' {$steps+=@{exe='sfc.exe';args=@('/scannow')}}
    'repair-sequence' {$steps+=@{exe='dism.exe';args=@('/Online','/Cleanup-Image','/RestoreHealth','/English','/NoRestart')};$steps+=@{exe='sfc.exe';args=@('/scannow')}}
    'disk-check' {if($data.volume -cnotmatch '^[A-Z]:$'){throw 'Choose a mounted volume.'};$v=Get-Volume -DriveLetter $data.volume[0];if(!$v -or [string]$v.UniqueId -cne $data.volumeId){throw 'The volume changed. Review it again.'};$steps+=@{exe='chkdsk.exe';args=@([string]$data.volume)}}
    default {throw 'Unsupported Windows repair operation.'}
  }
  $results=@();$restart=$false
  foreach($step in $steps){
    $command=$step.exe+' '+($step.args -join ' ');$tail='';$buffer='';$last=[datetime]::UtcNow
    $writer.WriteLine((@{id=$request.id;progress=('> '+$command+"`n")} | ConvertTo-Json -Compress))
    # Bounded native output stream.
    $old=$ErrorActionPreference;$ErrorActionPreference='Continue'
    try {Invoke-OmniaRepairCommand (Join-Path $system $step.exe) $step.args | ForEach-Object {
      $line=([string]$_).Replace([string][char]0,'')+"`n";$tail+=$line;if($tail.Length -gt 180000){$tail=$tail.Substring($tail.Length-180000)};$buffer+=$line
      if($buffer.Length -gt 4096 -or ([datetime]::UtcNow-$last).TotalMilliseconds -ge 300){$writer.WriteLine((@{id=$request.id;progress=$buffer} | ConvertTo-Json -Compress));$buffer='';$last=[datetime]::UtcNow}
    };$code=$script:repairExit}finally{$ErrorActionPreference=$old}
    if($null -eq $code){throw 'Windows could not start the selected command.'}
    if($buffer){$writer.WriteLine((@{id=$request.id;progress=$buffer} | ConvertTo-Json -Compress))}
    $results+=@{command=$command;exitCode=$code;output=$tail};if($code -eq 3010){$restart=$true}
    if($code -ne 0){break}
  }
  return (@{steps=$results;restartRequired=$restart;finished=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 5 -Compress)
}
