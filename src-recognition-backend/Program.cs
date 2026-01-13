using Microsoft.AspNetCore.Mvc;
using System.Numerics;
using Windows.Foundation;
using Windows.UI.Input.Inking;
using Serilog;
using System.Globalization;
using System.IO;

var builder = WebApplication.CreateBuilder(args);

// Configure Serilog
builder.Host.UseSerilog((context, services, configuration) => {
    // Ensure log path is in a writable directory for a Windows Service
    var logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "oneJournal", "RecognitionService", "logs", "log-.txt");

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
    options.ServiceName = "OneJournalRecognition";
});

// 2. Configure Kestrel to listen on port from config
var port = builder.Configuration.GetValue<int>("ServerSettings:Port");
if (port > 0)
{
    builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(port));
}

// 3. Add CORS to allow requests from the Tauri frontend
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

app.UseSerilogRequestLogging();
app.UseCors();

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

        const int BATCH_SIZE = 500;
        var allRecognizedWords = new List<RecognizedWord>();
        var jsStrokeBatches = strokes.Chunk(BATCH_SIZE);
        bool isFirstBatch = true; // Flag to control one-time logging

        foreach (var batch in jsStrokeBatches)
        {
            // Create a new container for each batch to ensure isolation
            var recognizerContainer = new InkRecognizerContainer();
            
            // Set Language for the new container
            if (!string.IsNullOrEmpty(language))
            {
                try 
                {
                    var allRecognizers = recognizerContainer.GetRecognizers();
                    var culture = new CultureInfo(language);
                    var langName = culture.EnglishName; 
                    
                    var targetRecognizer = allRecognizers.FirstOrDefault(r => 
                        r.Name.Contains(langName, StringComparison.OrdinalIgnoreCase));

                    if (targetRecognizer != null)
                    {
                        recognizerContainer.SetDefaultRecognizer(targetRecognizer);
                        if (isFirstBatch) 
                        {
                            Log.Information("Set handwriting recognizer to: {Name}", targetRecognizer.Name);
                        }
                    }
                    else
                    {
                        if (isFirstBatch)
                        {
                            Log.Warning("No recognizer found for language {Language} (looked for '{Name}'). Using default.", language, langName);
                        }
                    }
                }
                catch (Exception ex)
                {
                    if (isFirstBatch)
                    {
                        Log.Warning("Error setting recognition language: {Error}", ex.Message);
                    }
                }
            }

            var strokeContainer = new InkStrokeContainer();
            var strokeBuilder = new InkStrokeBuilder();
            var strokeIdMap = new Dictionary<uint, string>();

            Log.Information("Processing a batch of {BatchSize} strokes.", batch.Length);

            foreach (var jsStroke in batch)
            {
                if (jsStroke.Points == null || jsStroke.Points.Count == 0) continue;

                var inkPoints = jsStroke.Points
                    .Select(p => new InkPoint(new Point(p.X, p.Y), p.Pressure))
                    .ToList();
                
                if (inkPoints.Count == 0) continue;

                var stroke = strokeBuilder.CreateStrokeFromInkPoints(inkPoints, Matrix3x2.Identity);
                strokeIdMap[stroke.Id] = jsStroke.Id;
                strokeContainer.AddStroke(stroke);
            }

            if (strokeContainer.GetStrokes().Count == 0) continue;

            // Perform Recognition
            var results = await recognizerContainer.RecognizeAsync(strokeContainer, InkRecognitionTarget.All);

            // Extract Results
            foreach (var result in results)
            {
                var text = result.GetTextCandidates().FirstOrDefault();
                if (string.IsNullOrWhiteSpace(text)) continue;

                var rect = result.BoundingRect;
                var resultStrokes = result.GetStrokes();
                var mappedIds = new List<string>();

                foreach (var s in resultStrokes)
                {
                    if (strokeIdMap.TryGetValue(s.Id, out var originalId))
                    {
                        mappedIds.Add(originalId);
                    }
                }

                allRecognizedWords.Add(new RecognizedWord
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
            
            isFirstBatch = false; // Ensure logging only happens on the first pass
        }

        return Results.Ok(allRecognizedWords);
    }
    catch (Exception ex)
    {
        Log.Error(ex, "Error during recognition. Total strokes attempted: {TotalStrokes}", strokes.Count);
        return Results.Problem(detail: ex.Message, statusCode: 500);
    }
});

try
{
    Log.Information("Starting Handwriting Recognition Service on port {Port}", port);
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