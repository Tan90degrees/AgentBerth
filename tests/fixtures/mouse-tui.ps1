$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class MouseTui {
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    public struct InputRecord {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public uint KeyDown;
        [FieldOffset(14)] public ushort Character;
        [FieldOffset(8)] public uint Buttons;
        [FieldOffset(16)] public uint MouseFlags;
    }
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr handle, uint mode);
    [DllImport("kernel32.dll")] static extern bool GetNumberOfConsoleInputEvents(IntPtr handle, out uint count);
    [DllImport("kernel32.dll", EntryPoint = "ReadConsoleInputW")] static extern bool ReadConsoleInput(IntPtr handle, out InputRecord record, uint length, out uint count);

    static void Draw(int clicks, bool paused) {
        int cols = Console.WindowWidth, rows = Console.WindowHeight;
        var text = new StringBuilder("\x1b[H\x1b[2JTUI_RESIZE_READY\x1b[2;1HSIZE_" + cols + "x" + rows + "\x1b[3;1H");
        for (int i = 0; i < Math.Max(1, (cols - 6) / 6); i++) text.Append("中文🙂");
        for (int row = 3; row < rows - 1; row++) text.Append("\x1b[" + row + ";10H\x1b[38;2;255;102;0m█\x1b[0m");
        text.Append("\x1b[4;20HMOUSE_" + "SGR_" + clicks);
        if (paused) text.Append("\x1b[5;20HCOPY_READY");
        text.Append("\x1b[" + rows + ";1HTUI_FOOTER\x1b[K");
        Console.Write(text.ToString());
    }

    public static void Run() {
        var input = GetStdHandle(-10); var output = GetStdHandle(-11);
        uint inputMode, outputMode;
        if (!GetConsoleMode(input, out inputMode) || !GetConsoleMode(output, out outputMode)) throw new Exception("TUI needs a native console");
        // ReadConsoleInput receives real ConPTY mouse records. Node's ordinary
        // raw stdin intentionally ignores these Windows console records.
        if (!SetConsoleMode(input, 0x98) || !SetConsoleMode(output, outputMode | 4)) throw new Exception("Cannot enable TUI console modes");
        Console.OutputEncoding = new UTF8Encoding(false);
        int clicks = 0; uint buttons = 0; bool paused = false, done = false;
        try {
            Console.Write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
            DateTime deadline = DateTime.UtcNow.AddSeconds(60), nextDraw = DateTime.MinValue;
            while (!done && DateTime.UtcNow < deadline) {
                uint pending;
                if (!GetNumberOfConsoleInputEvents(input, out pending)) throw new Exception("Cannot inspect console input");
                while (pending-- > 0) {
                    InputRecord record; uint count;
                    if (!ReadConsoleInput(input, out record, 1, out count)) throw new Exception("Cannot read console input");
                    if (record.Type == 1 && record.KeyDown != 0) {
                        if (record.Character == 3) done = true;
                        if (record.Character == 'p') { paused = true; Draw(clicks, paused); }
                        if (record.Character == 'r') paused = false;
                    }
                    if (record.Type == 4 && paused) Draw(clicks, paused);
                    if (record.Type == 2) {
                        if ((record.MouseFlags & ~2u) == 0 && (record.Buttons & 1) != 0 && (buttons & 1) == 0) clicks++;
                        buttons = record.Buttons;
                    }
                }
                if (!paused && DateTime.UtcNow >= nextDraw) { Draw(clicks, paused); nextDraw = DateTime.UtcNow.AddMilliseconds(60); }
                Thread.Sleep(5);
            }
        } finally {
            Console.Write("\x1b[?1000l\x1b[?1006l\x1b[?1049lTUI_RESIZE_DONE\r\n");
            SetConsoleMode(input, inputMode); SetConsoleMode(output, outputMode);
        }
    }
}
'@
[MouseTui]::Run()
