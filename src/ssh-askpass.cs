using System;
using System.IO;
using System.IO.Pipes;
using System.Text;

internal static class Askpass {
    private static int Main() {
        try {
            string name = Environment.GetEnvironmentVariable("OMNIA_KEY_PIPE");
            string token = Environment.GetEnvironmentVariable("OMNIA_KEY_TOKEN");
            if (String.IsNullOrEmpty(name) || String.IsNullOrEmpty(token)) return 1;
            using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
                pipe.Connect(5000);
                using (var writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true))
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true)) {
                    writer.WriteLine(token);
                    writer.Flush();
                    string encoded = reader.ReadLine();
                    if (encoded == null || !encoded.StartsWith("OK:")) return 1;
                    byte[] secret = Convert.FromBase64String(encoded.Substring(3));
                    using (var output = Console.OpenStandardOutput()) {
                        output.Write(secret, 0, secret.Length);
                        output.WriteByte(10);
                        output.Flush();
                    }
                    Array.Clear(secret, 0, secret.Length);
                }
            }
            return 0;
        } catch { return 1; }
    }
}
