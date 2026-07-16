using Microsoft.AspNetCore.Mvc;
using System.Numerics;
using Windows.Foundation;
using Windows.UI.Input.Inking;
using Windows.UI.Input.Inking.Analysis;
using Serilog;
using System.Globalization;
using System.IO;

var builder = WebApplication.CreateBuilder(args);

// Configure Serilog
builder.Host.UseSerilog((context, services, configuration) => {
    // Ensure log path is in a writable directory for a Windows Service
    var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NoteBerg", "RecognitionService", "logs", "log-.txt");

    configuration
        .ReadFrom.Configuration(context.Configuration)
        .Enrich.FromLogContext()
        .WriteTo.File(
            logPath,
            rollingInterval: RollingInterval.Day,
            retainedFileCountLimit: 10
        );
});

// 1. Configure as Windows Service
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "NoteBergRecognition";
});

// 2. Configure Kestrel to listen on port from CLI arg or config
var port = builder.Configuration.GetValue<int>("ServerSettings:Port");

// CLI argument --port overrides config
var portArgIndex = Array.IndexOf(args, "--port");
if (portArgIndex >= 0 && portArgIndex + 1 < args.Length && int.TryParse(args[portArgIndex + 1], out var cliPort))
{
    port = cliPort;
}

// By default the service is a localhost-only sidecar: bind to loopback so stroke
// data is not exposed to other hosts on the LAN. Operators running it as a shared
// recognition server must opt in via ServerSettings:AllowRemote or --allow-remote.
var allowRemote = builder.Configuration.GetValue<bool>("ServerSettings:AllowRemote")
    || args.Contains("--allow-remote");

if (port > 0)
{
    builder.WebHost.ConfigureKestrel(options =>
    {
        if (allowRemote)
        {
            options.ListenAnyIP(port);
        }
        else
        {
            options.ListenLocalhost(port);
        }
    });
}

// 3. CORS: only needed when remote browsers/clients hit a shared server. For the
// localhost sidecar the Tauri app calls it directly (no browser Origin enforcement),
// so the permissive any-origin policy is confined to the AllowRemote case.
if (allowRemote)
{
    builder.Services.AddCors(options =>
    {
        options.AddDefaultPolicy(policy =>
        {
            policy.AllowAnyOrigin()
                  .AllowAnyHeader()
                  .AllowAnyMethod();
        });
    });
}

var app = builder.Build();

app.UseSerilogRequestLogging();
if (allowRemote)
{
    app.UseCors();
}

// 4. Define the Recognition Endpoint
app.MapPost("/recognize", async (HttpContext context, [FromBody] List<JsStroke> strokes, [FromQuery] string? language) =>
{
    if (strokes == null || strokes.Count == 0)
    {
        return Results.Ok(new List<RecognizedWord>());
    }

    var ipAddress = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    try
    {
        Log.Information("Received {StrokeCount} strokes for recognition from {IPAddress}.", strokes.Count, ipAddress);

        var recognizedWords = new List<RecognizedWord>();

        // Build InkStroke objects and track ID mapping
        var strokeBuilder = new InkStrokeBuilder();
        var inkStrokes = new List<InkStroke>();
        var strokeIdMap = new Dictionary<uint, string>();

        foreach (var jsStroke in strokes)
        {
            if (jsStroke.Points == null || jsStroke.Points.Count == 0) continue;

            var inkPoints = jsStroke.Points
                .Select(p => new InkPoint(new Point(p.X, p.Y), p.Pressure))
                .ToList();

            if (inkPoints.Count == 0) continue;

            var stroke = strokeBuilder.CreateStrokeFromInkPoints(inkPoints, Matrix3x2.Identity);
            strokeIdMap[stroke.Id] = jsStroke.Id;
            inkStrokes.Add(stroke);
        }

        if (inkStrokes.Count == 0)
        {
            return Results.Ok(recognizedWords);
        }

        Log.Information("Processing {StrokeCount} strokes using InkAnalyzer.", inkStrokes.Count);

        // Use InkAnalyzer instead of InkRecognizerContainer — it performs spatial
        // analysis to group strokes into words/lines regardless of temporal order,
        // and supports SetStrokeDataKind to ensure all strokes are treated as text.
        var inkAnalyzer = new InkAnalyzer();
        inkAnalyzer.AddDataForStrokes(inkStrokes);

        // Mark all strokes as writing so the analyzer doesn't classify any as drawings
        foreach (var stroke in inkStrokes)
        {
            inkAnalyzer.SetStrokeDataKind(stroke.Id, InkAnalysisStrokeKind.Writing);
        }

        // Set language hint if provided
        if (!string.IsNullOrEmpty(language))
        {
            try
            {
                // InkAnalyzer doesn't use InkRecognizerContainer for language selection.
                // Instead, we log the language for diagnostics. The analyzer uses the
                // system's installed handwriting recognizers automatically.
                Log.Information("Recognition language requested: {Language}", language);
            }
            catch (Exception ex)
            {
                Log.Warning("Error setting recognition language: {Error}", ex.Message);
            }
        }

        var analysisResult = await inkAnalyzer.AnalyzeAsync();

        if (analysisResult.Status == InkAnalysisStatus.Updated)
        {
            // Extract recognized words from the analysis tree
            var wordNodes = inkAnalyzer.AnalysisRoot.FindNodes(InkAnalysisNodeKind.InkWord);
            var recognizedStrokeIds = new HashSet<uint>();

            foreach (InkAnalysisInkWord wordNode in wordNodes)
            {
                var text = wordNode.RecognizedText;
                if (string.IsNullOrWhiteSpace(text)) continue;

                var rect = wordNode.BoundingRect;
                var wordStrokeIds = wordNode.GetStrokeIds();
                var mappedIds = new List<string>();

                foreach (var strokeId in wordStrokeIds)
                {
                    recognizedStrokeIds.Add(strokeId);
                    if (strokeIdMap.TryGetValue(strokeId, out var originalId))
                    {
                        mappedIds.Add(originalId);
                    }
                }

                recognizedWords.Add(new RecognizedWord
                {
                    Text = text,
                    BoundingRect = new RectData
                    {
                        X = (float)rect.X,
                        Y = (float)rect.Y,
                        Width = (float)rect.Width,
                        Height = (float)rect.Height
                    },
                    StrokeIds = mappedIds
                });
            }

            var unrecognizedCount = strokeIdMap.Keys.Count(id => !recognizedStrokeIds.Contains(id));
            Log.Information("Recognition complete: {WordCount} words, {RecognizedStrokes}/{TotalStrokes} strokes recognized, {UnrecognizedStrokes} unrecognized.",
                recognizedWords.Count, recognizedStrokeIds.Count, strokeIdMap.Count, unrecognizedCount);
        }
        else
        {
            Log.Warning("InkAnalyzer returned status: {Status}", analysisResult.Status);
        }

        return Results.Ok(recognizedWords);
    }
    catch (Exception ex)
    {
        Log.Error(ex, "Error during recognition. Total strokes attempted: {TotalStrokes}", strokes.Count);
        return Results.Problem(detail: ex.Message, statusCode: 500);
    }
});

const string SERVICE_VERSION = "1.4.0";

try
{
    var portSource = portArgIndex >= 0 ? "CLI" : "config";
    var binding = allowRemote ? "all interfaces (remote enabled)" : "localhost only";
    Log.Information("Starting Handwriting Recognition Service v{Version} on port {Port} (from {PortSource}), binding: {Binding}", SERVICE_VERSION, port, portSource, binding);
    Log.Information("Running as user: {UserIdentity}", System.Security.Principal.WindowsIdentity.GetCurrent().Name);
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Application terminated unexpectedly");
}
finally
{
    Log.CloseAndFlush();
}

// --- Data Models ---

public class JsStroke
{
    public string Id { get; set; } = "";
    public List<JsPoint> Points { get; set; } = new();
}

public class JsPoint
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Pressure { get; set; }
}

public class RecognizedWord
{
    public string Text { get; set; } = "";
    public RectData BoundingRect { get; set; } = new();
    public List<string> StrokeIds { get; set; } = new();
}

public class RectData
{
    public float X { get; set; }
    public float Y { get; set; }
    public float Width { get; set; }
    public float Height { get; set; }
}