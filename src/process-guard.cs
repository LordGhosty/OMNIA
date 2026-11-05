using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

internal static class ProcessGuard
{
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct Limits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero;
        try
        {
            int parentId, childId, memory;
            if (args.Length != 3 || !int.TryParse(args[0], out parentId) ||
                !int.TryParse(args[1], out childId) || !int.TryParse(args[2], out memory) ||
                parentId <= 0 || childId <= 0 || parentId == childId || memory < 256 || memory > 4096)
                return 2;
            using (Process parent = Process.GetProcessById(parentId))
            using (Process child = Process.GetProcessById(childId))
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw new Win32Exception();
                Limits limits = new Limits();
                // Kill on close, total committed memory, and descendant count.
                limits.Basic.Flags = 0x2000 | 0x200 | 0x8;
                limits.Basic.ActiveProcesses = 32;
                limits.JobMemory = new UIntPtr((ulong)memory * 1024 * 1024);
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))) ||
                    !AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception();
                Console.WriteLine("READY");
                Console.Out.Flush();
                if (WaitForMultipleObjects(2, new IntPtr[] { parent.Handle, child.Handle }, false, uint.MaxValue) > 1)
                    throw new Win32Exception();
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
        finally { if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
