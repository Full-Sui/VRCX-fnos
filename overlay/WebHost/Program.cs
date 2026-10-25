using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VRCX;

namespace VRCXWebHost
{
    /// <summary>
    /// Headless host for the VRCX C# backend. It exposes a small JSON-RPC surface
    /// over loopback HTTP; the Node gateway (the fnOS app socket server) is the only
    /// client and is responsible for auth, static files and the browser WebSocket.
    /// </summary>
    internal static class WebHostProgram
    {
        private const int DefaultPort = 39211;
        private static readonly Dictionary<string, object> Instances = new(StringComparer.OrdinalIgnoreCase);
        private static readonly object InvokeLock = new();
        private static ProgramElectron _programElectron;
        private static string _version = "VRCX 2026.09.16";

        private static async Task<int> Main(string[] args)
        {
            var port = DefaultPort;
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p))
                {
                    port = p;
                }
                else if (args[i] == "--version" && i + 1 < args.Length)
                {
                    _version = args[i + 1];
                }
            }

            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                Console.Error.WriteLine("UNHANDLED: " + e.ExceptionObject);

            try
            {
                var dataRoot = Environment.GetEnvironmentVariable("VRCX_DATA_DIR");
                if (!string.IsNullOrEmpty(dataRoot))
                {
                    VRCX.Program.AppDataDirectory = Path.Combine(dataRoot, "home", ".config", "VRCX");
                }

                _programElectron = new ProgramElectron();
                _programElectron.PreInit(_version, args);
                VRCXStorage.Instance.Load();
                _programElectron.Init();
                SQLite.Instance.Init();
                VRCX.Program.AppApiInstance.Init();
                Discord.Instance.Init();
                WebApi.Instance.Init();
                LogWatcher.Instance.Init();
                SystemMonitorElectron.Instance.Init();
                var vrApi = new AppApiVrElectron();
                vrApi.Init();

                Instances["ProgramElectron"] = _programElectron;
                Instances["VRCXStorage"] = VRCXStorage.Instance;
                Instances["SQLite"] = SQLite.Instance;
                Instances["AppApiElectron"] = VRCX.Program.AppApiInstance;
                Instances["AppApi"] = VRCX.Program.AppApiInstance;
                Instances["Discord"] = Discord.Instance;
                Instances["WebApi"] = WebApi.Instance;
                Instances["LogWatcher"] = LogWatcher.Instance;
                Instances["SystemMonitorElectron"] = SystemMonitorElectron.Instance;
                Instances["AppApiVrElectron"] = vrApi;
                Instances["AssetBundleManager"] = new NullApi();
                Instances["WebHostStorage"] = new WebHostStorage();

                Console.WriteLine($"VRCX web host ready on 127.0.0.1:{port} ({_version})");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("INIT FAILED: " + ex);
                return 1;
            }

            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();

            var stopping = new CancellationTokenSource();
            _ = Task.Run(() => AcceptLoop(listener, stopping.Token));

            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                stopping.Cancel();
            };
            AppDomain.CurrentDomain.ProcessExit += (_, _) => stopping.Cancel();

            try
            {
                await Task.Delay(Timeout.Infinite, stopping.Token);
            }
            catch (OperationCanceledException)
            {
            }

            listener.Stop();
            return 0;
        }

        private static async Task AcceptLoop(HttpListener listener, CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                HttpListenerContext ctx;
                try
                {
                    ctx = await listener.GetContextAsync();
                }
                catch (Exception) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("accept: " + ex.Message);
                    continue;
                }

                _ = Task.Run(() => Handle(ctx));
            }
        }

        private static async Task Handle(HttpListenerContext ctx)
        {
            try
            {
                var path = ctx.Request.Url?.AbsolutePath ?? "/";
                if (path == "/health")
                {
                    await WriteJson(ctx, 200, new { ok = true, version = _version });
                    return;
                }
                if (path == "/rpc" && ctx.Request.HttpMethod == "POST")
                {
                    using var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8);
                    var body = await reader.ReadToEndAsync();
                    var req = JObject.Parse(body);
                    var className = (string)req["className"];
                    var methodName = (string)req["methodName"];
                    var argsToken = req["args"] as JArray ?? new JArray();
                    try
                    {
                        var result = Invoke(className, methodName, argsToken);
                        await WriteJson(ctx, 200, new { ok = true, result });
                    }
                    catch (Exception ex)
                    {
                        var inner = ex is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : ex;
                        await WriteJson(ctx, 200, new { ok = false, error = inner.GetType().Name + ": " + inner.Message });
                    }
                    return;
                }
                if (path == "/shutdown" && ctx.Request.HttpMethod == "POST")
                {
                    await WriteJson(ctx, 200, new { ok = true });
                    Environment.Exit(0);
                    return;
                }
                await WriteJson(ctx, 404, new { ok = false, error = "not found" });
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("handle: " + ex);
                try
                {
                    await WriteJson(ctx, 500, new { ok = false, error = ex.Message });
                }
                catch
                {
                    // ignored
                }
            }
        }

        private static object Invoke(string className, string methodName, JArray args)
        {
            if (string.IsNullOrEmpty(className) || string.IsNullOrEmpty(methodName))
            {
                throw new ArgumentException("className and methodName are required");
            }

            if (!Instances.TryGetValue(className, out var instance) || instance == null)
            {
                throw new InvalidOperationException("unknown class: " + className);
            }

            var methods = instance.GetType()
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => string.Equals(m.Name, methodName, StringComparison.Ordinal) &&
                            m.GetParameters().Length == args.Count)
                .ToList();

            if (methods.Count == 0)
            {
                // Property getter support (e.g. AppApi.CurrentLanguage).
                var prop = instance.GetType().GetProperty(methodName, BindingFlags.Public | BindingFlags.Instance);
                if (prop != null && args.Count == 0)
                {
                    return Normalize(prop.GetValue(instance));
                }
                throw new MissingMethodException(className + "." + methodName + "(" + args.Count + " args)");
            }

            var method = methods[0];
            var parameters = method.GetParameters();
            var values = new object[parameters.Length];
            for (var i = 0; i < parameters.Length; i++)
            {
                values[i] = ConvertToken(args[i], parameters[i].ParameterType);
            }

            object result = method.Invoke(instance, values);

            if (result is Task task)
            {
                task.GetAwaiter().GetResult();
                var taskType = task.GetType();
                if (taskType.IsGenericType)
                {
                    result = taskType.GetProperty("Result")?.GetValue(task);
                }
                else
                {
                    result = null;
                }
            }

            return Normalize(result);
        }

        private static object ConvertToken(JToken token, Type targetType)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Undefined)
            {
                return targetType.IsValueType && Nullable.GetUnderlyingType(targetType) == null
                    ? Activator.CreateInstance(targetType)
                    : null;
            }

            if (targetType == typeof(object))
            {
                return token.ToObject<object>();
            }

            if (typeof(IDictionary<string, object>).IsAssignableFrom(targetType))
            {
                return token.ToObject<Dictionary<string, object>>();
            }

            return token.ToObject(targetType);
        }

        private static object Normalize(object value)
        {
            if (value == null)
            {
                return null;
            }
            if (value is string || value.GetType().IsPrimitive || value is decimal)
            {
                return value;
            }
            return value;
        }

        private static async Task WriteJson(HttpListenerContext ctx, int status, object payload)
        {
            var json = JsonConvert.SerializeObject(payload, new JsonSerializerSettings
            {
                ReferenceLoopHandling = ReferenceLoopHandling.Ignore,
                NullValueHandling = NullValueHandling.Include
            });
            var bytes = Encoding.UTF8.GetBytes(json);
            ctx.Response.StatusCode = status;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.ContentLength64 = bytes.Length;
            await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            ctx.Response.Close();
        }

        private sealed class NullApi
        {
        }
    }
}
