using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// Platform wrapper only. Readiness, instance reuse and browser opening belong to launcher.mjs.
internal static class PaperEchoLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 0) return Fail(1, "请直接双击 PaperEcho.exe，不传入参数。");
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "workflow", "tools", "web", "launcher.mjs");
            string node = FindNode();
            if (node == null) return Fail(2, "未找到所需的 Node.js 运行环境。\n请安装或配置 Node.js 18 及以上版本后重试。");
            if (!File.Exists(script)) return Fail(5, "启动文件缺失。请将 PaperEcho.exe 保留在完整的 PaperEcho 项目目录中。");
            var start = new ProcessStartInfo(node, "\"" + script + "\"")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (Process child = Process.Start(start))
            {
                child.WaitForExit();
                int code = child.ExitCode;
                if (code == 0) return 0;
                switch (code)
                {
                    case 2: return Fail(code, "需要 Node.js 18 或更高版本，请检查运行环境。");
                    case 3: return Fail(code, "服务端口已被其他程序或另一工作区占用。请先关闭对应实例；启动器不会强杀进程。");
                    case 4: return Fail(code, "服务未及时就绪。请使用 PaperEcho.cmd 查看诊断信息。");
                    case 6: return Fail(code, "服务已就绪，但默认浏览器未能打开。请使用 PaperEcho.cmd 查看访问地址。");
                    default: return Fail(5, "启动失败，请检查 Node.js、项目依赖和配置。可使用 PaperEcho.cmd 查看诊断信息。");
                }
            }
        }
        catch { return Fail(5, "无法启动 PaperEcho。请检查运行环境和文件权限，或使用 PaperEcho.cmd 诊断。"); }
    }

    private static string FindNode()
    {
        // Match the existing PATH contract; never execute a shell or search the caller's cwd.
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            string directory = entry.Trim().Trim('"');
            if (directory.Length == 0 || !Path.IsPathRooted(directory)) continue;
            try
            {
                string candidate = Path.GetFullPath(Path.Combine(directory, "node.exe"));
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { }
            catch (NotSupportedException) { }
        }
        return null;
    }

    private static int Fail(int code, string message)
    {
        MessageBox.Show(message, "PaperEcho 无法启动", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return code;
    }
}
