using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class Publisher
{
    internal const string Pins = "__CERTIFICATE_PINS__";

    internal static bool Verify(string file)
    {
        if (String.IsNullOrEmpty(Pins) || !File.Exists(file)) return false;
        try {
            string script = "$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';"
                + "$s=Get-AuthenticodeSignature -LiteralPath $env:OMNIA_SIGNATURE_FILE;"
                + "if($s.Status -ne 'Valid'){exit 1};"
                + "$h=[Security.Cryptography.SHA256]::Create();"
                + "$p=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant();"
                + "if(($env:OMNIA_SIGNATURE_PINS -split ',') -notcontains $p){exit 1};"
                + "[Console]::Write('OK')";
            string powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
            var info = new ProcessStartInfo(powershell,
                "-NoLogo -NoProfile -NonInteractive -EncodedCommand "
                + Convert.ToBase64String(Encoding.Unicode.GetBytes(script))) {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            info.EnvironmentVariables["OMNIA_SIGNATURE_FILE"] = file;
            info.EnvironmentVariables["OMNIA_SIGNATURE_PINS"] = Pins;
            using (var process = Process.Start(info)) {
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(30000)) {
                    process.Kill();
                    return false;
                }
                return process.ExitCode == 0 && output.Result == "OK";
            }
        } catch {
            return false;
        }
    }
}
