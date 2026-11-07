using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Globalization;

internal static class Publisher
{
    internal const string Pins = "__CERTIFICATE_PINS__";
    internal const string ReleaseKey = "__RELEASE_KEY_XML__";
    internal const string Repository = "__RELEASE_REPOSITORY__";
    internal static bool Configured { get { return !String.IsNullOrEmpty(ReleaseKey) || !String.IsNullOrEmpty(Pins); } }

    private static bool VerifyRelease(string file, string kind)
    {
        string signature = file + ".sig";
        if (!File.Exists(signature) || new FileInfo(signature).Length > 16384) return false;
        var json = new JavaScriptSerializer { MaxJsonLength = 16384 };
        var envelope = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(signature));
        byte[] payload = Convert.FromBase64String((string)envelope["payload"]);
        using (var rsa = new RSACryptoServiceProvider()) {
            rsa.PersistKeyInCsp = false;
            rsa.FromXmlString(ReleaseKey);
            if (!rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), Convert.FromBase64String((string)envelope["signature"]))) return false;
        }
        var data = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
        string role = (string)data["kind"];
        if (Convert.ToInt32(data["schema"]) != 1 || (string)data["product"] != "OMNIA" ||
            (string)data["purpose"] != "release-artifact" || (string)data["repository"] != Repository ||
            (string)data["platform"] != "win32" || (string)data["arch"] != "x64" ||
            (role != "installer" && role != "validator" && role != "uninstaller") || (kind != null && role != kind) ||
            !System.Text.RegularExpressions.Regex.IsMatch((string)data["version"], @"\A\d+\.\d+\.\d+\z")) return false;
        DateTimeOffset created = DateTimeOffset.Parse((string)data["createdAt"], CultureInfo.InvariantCulture);
        DateTimeOffset expires = DateTimeOffset.Parse((string)data["expiresAt"], CultureInfo.InvariantCulture);
        if (expires <= created || (expires - created).TotalDays > 91) return false;
        long size = Convert.ToInt64(data["size"]);
        if (size <= 0 || size > 768L * 1024 * 1024 || new FileInfo(file).Length != size) return false;
        using (var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var sha = SHA256.Create()) {
            string digest = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
            return digest == (string)data["sha256"];
        }
    }

    internal static bool Verify(string file, string kind = null)
    {
        if (!Configured || !File.Exists(file)) return false;
        try {
            if (!String.IsNullOrEmpty(ReleaseKey)) return VerifyRelease(file, kind);
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
