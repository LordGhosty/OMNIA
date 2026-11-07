using System;
using System.Diagnostics;
using System.IO;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyProduct("OMNIA")]
[assembly: System.Reflection.AssemblyTitle("OMNIA Recovery")]

internal static class Recovery
{

    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 2 && args[0] == "--check") {
            Environment.ExitCode = Publisher.Verify(args[1], "installer") ? 0 : 1;
            return;
        }
        Application.EnableVisualStyles();
        var form = new Form {
            Text = "OMNIA Recovery",
            ClientSize = new Size(560, 250),
            BackColor = Color.FromArgb(12, 12, 12),
            ForeColor = Color.Gainsboro,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            StartPosition = FormStartPosition.CenterScreen
        };
        var label = new Label {
            Text = "Restore the previous verified release\n\nThis reinstalls OMNIA. It does not undo changes made to your files or Windows settings.",
            Location = new Point(28, 25),
            Size = new Size(500, 105),
            Font = new Font("Segoe UI", 11)
        };
        var button = new Button {
            Text = "Verify and restore",
            Location = new Point(28, 155),
            Size = new Size(190, 40),
            FlatStyle = FlatStyle.Flat
        };
        var status = new Label { Location = new Point(28, 210), Size = new Size(500, 30) };
        button.Click += async (sender, eventArgs) => {
            button.Enabled = false;
            try {
                string file = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "OMNIA", "recovery", "previous-setup.exe");
                if (!Publisher.Configured || !File.Exists(file)) {
                    status.Text = "No verified recovery installer is available. Use the official download.";
                    return;
                }
                // Keep the verified path from being replaced before the installer starts.
                using (var held = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    status.Text = "Verifying the release signature...";
                    if (!await Task.Run(() => Publisher.Verify(file, "installer"))) {
                        status.Text = "Verification failed. This installer will not run.";
                        return;
                    }
                    var choice = MessageBox.Show(form,
                        "Close OMNIA before continuing. Reinstall the previous verified release?",
                        "Restore OMNIA", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                    if (choice != DialogResult.Yes) return;
                    Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
                    form.Close();
                }
            } catch {
                status.Text = "The recovery installer could not be opened.";
            } finally {
                button.Enabled = true;
            }
        };
        form.Controls.AddRange(new Control[] { label, button, status });
        Application.Run(form);
    }
}
