using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyProduct("OMNIA")]
[assembly: AssemblyTitle("OMNIA Validator")]

internal static class Validator
{
    private sealed class Result
    {
        internal string Digest, Verdict;
        internal bool Trusted, Matches;
    }

    private static Result Inspect(string path, string expected)
    {
        if (!String.IsNullOrEmpty(expected) && !Regex.IsMatch(expected, @"\A[0-9a-fA-F]{64}\z"))
            throw new ArgumentException("Enter the 64-character SHA-256 from the release.");
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var sha = SHA256.Create()) {
            var digest = BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            var matches = String.Equals(expected, digest, StringComparison.OrdinalIgnoreCase);
            var trusted = Publisher.Verify(path) && FileVersionInfo.GetVersionInfo(path).ProductName == "OMNIA";
            var mismatch = expected.Length > 0 && !matches;
            return new Result { Digest = digest, Trusted = trusted && !mismatch, Matches = matches,
                Verdict = (mismatch ? "Checksum mismatch." : matches ? "Checksum matches. " : "")
                    + (mismatch ? "" : trusted ? "OMNIA release signature verified."
                    : "Unverified. Place the matching .sig file beside this executable.") };
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--check") {
            try {
                var result = Inspect(args[1], args.Length == 3 ? args[2] : "");
                return result.Trusted ? 0 : result.Matches ? 2 : 1;
            } catch { return 1; }
        }
        Application.EnableVisualStyles();
        using (var form = new Form { Text = "OMNIA Validator", BackColor = Color.FromArgb(16,16,16),
            ForeColor = Color.Gainsboro, Font = new Font("Segoe UI", 10), ClientSize = new Size(600, 153),
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, StartPosition = FormStartPosition.CenterScreen })
        using (var picker = new OpenFileDialog { Filter = "Windows executables (*.exe)|*.exe", Title = "Choose an OMNIA executable" }) {
            var choose = new Button { Text = "Choose file", Bounds = new Rectangle(20,20,112,36), FlatStyle = FlatStyle.Flat };
            var name = new Label { Text = "Select a file with its matching .sig beside it.", Bounds = new Rectangle(146,28,432,28), AutoEllipsis = true };
            var prompt = new Label { Text = "Paste the release SHA-256 to compare (optional)", Bounds = new Rectangle(20,77,550,22) };
            var expected = new TextBox { Bounds = new Rectangle(20,104,560,30), MaxLength = 128, BackColor = Color.FromArgb(32,32,32), ForeColor = Color.WhiteSmoke, BorderStyle = BorderStyle.FixedSingle };
            var verify = new Button { Text = "Verify file", Bounds = new Rectangle(20,149,112,36), FlatStyle = FlatStyle.Flat, Visible = false };
            var status = new Label { Bounds = new Rectangle(20,200,560,36) };
            var label = new Label { Text = "Calculated file SHA-256", Visible = false, Bounds = new Rectangle(20,246,560,23) };
            var hash = new TextBox { ReadOnly = true, Visible = false, BackColor = Color.FromArgb(32,32,32), ForeColor = Color.Gainsboro, BorderStyle = BorderStyle.FixedSingle, Bounds = new Rectangle(20,272,560,27) };
            string path = null;
            Action resetResult = () => {
                status.Text = hash.Text = "";
                label.Visible = hash.Visible = false;
                form.ClientSize = new Size(form.ClientSize.Width, (path == null ? expected.Bottom : verify.Bottom) + 20);
            };
            choose.Click += (s, e) => {
                if (picker.ShowDialog(form) != DialogResult.OK) return;
                path = picker.FileName;
                name.Text = Path.GetFileName(path);
                verify.Visible = true;
                resetResult();
            };
            expected.TextChanged += (s, e) => resetResult();
            verify.Click += async (s, e) => {
                choose.Enabled = expected.Enabled = false;
                verify.Visible = false;
                label.Visible = hash.Visible = false;
                form.ClientSize = new Size(form.ClientSize.Width, status.Bottom + 20);
                status.Text = "Checking file...";
                hash.Clear();
                var wanted = expected.Text.Trim();
                try {
                    var result = await Task.Run(() => Inspect(path, wanted));
                    form.ClientSize = new Size(form.ClientSize.Width, hash.Bottom + 20);
                    label.Visible = hash.Visible = true;
                    hash.Text = result.Digest;
                    status.Text = result.Verdict;
                } catch (ArgumentException error) { status.Text = error.Message; }
                catch { status.Text = "Could not read or verify this file."; }
                finally { choose.Enabled = expected.Enabled = verify.Visible = true; }
            };
            form.Controls.AddRange(new Control[] { choose, name, prompt, expected, verify, status, label, hash });
            Application.Run(form);
        }
        return 0;
    }
}
