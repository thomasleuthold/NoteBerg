using Microsoft.AspNetCore.Mvc;
using System.Numerics;
using Windows.Foundation;
using Windows.UI.Input.Inking;
using Serilog;
using System.Globalization;

var builder = WebApplication.CreateBuilder(args);

// Configure Serilog
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext());

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
app.MapPost("/recognize", async ([FromBody] List<JsStroke> strokes, [FromQuery] string? language) =>
{
    if (strokes == null || strokes.Count == 0)
    {
        return Results.Ok(new List<RecognizedWord>());
    }

    try
    {
        // Use InkRecognizerContainer for explicit language support
        var recognizerContainer = new InkRecognizerContainer();
        var strokeContainer = new InkStrokeContainer();
        var strokeBuilder = new InkStrokeBuilder();
        
        // Map to track stroke IDs: InkId -> Original UUID
        var strokeIdMap = new Dictionary<uint, string>();

        // Set Language
        if (!string.IsNullOrEmpty(language))
        {
            try 
            {
                var allRecognizers = recognizerContainer.GetRecognizers();
                var culture = new CultureInfo(language);
                // Construct expected name part, e.g., "English (United States)" or "German (Germany)"
                var langName = culture.EnglishName; 
                
                var targetRecognizer = allRecognizers.FirstOrDefault(r => 
                    r.Name.Contains(langName, StringComparison.OrdinalIgnoreCase));

                if (targetRecognizer != null)
                {
                    recognizerContainer.SetDefaultRecognizer(targetRecognizer);
                    Log.Information("Set handwriting recognizer to: {Name}", targetRecognizer.Name);
                }
                else
                {
                    Log.Warning("No recognizer found for language {Language} (looked for '{Name}'). Using default.", language, langName);
                }
            }
            catch (Exception ex)
            {
                Log.Warning("Error setting recognition language: {Error}", ex.Message);
            }
        }

        // Convert Input to Windows Ink Strokes
        for (int i = 0; i < strokes.Count; i++)
        {
            var jsStroke = strokes[i];
            if (jsStroke.Points == null || jsStroke.Points.Count == 0) continue;

            var inkPoints = jsStroke.Points
                .Select(p => new InkPoint(new Windows.Foundation.Point(p.X, p.Y), p.Pressure))
                .ToList();

            var stroke = strokeBuilder.CreateStrokeFromInkPoints(inkPoints, Matrix3x2.Identity);
            
            strokeIdMap[stroke.Id] = jsStroke.Id;
            strokeContainer.AddStroke(stroke);
        }

        // Perform Recognition
        var results = await recognizerContainer.RecognizeAsync(strokeContainer, InkRecognitionTarget.All);

        // Extract Results
        var words = new List<RecognizedWord>();
        
        foreach (var result in results)
        {
            var text = result.GetTextCandidates().FirstOrDefault();
            if (string.IsNullOrWhiteSpace(text)) continue;

            var rect = result.BoundingRect;
            var resultStrokes = result.GetStrokes();

            // Map back to original IDs
            var mappedIds = new List<string>();
            foreach (var s in resultStrokes)
            {
                if (strokeIdMap.TryGetValue(s.Id, out var originalId))
                {
                    mappedIds.Add(originalId);
                }
            }

            words.Add(new RecognizedWord
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

        return Results.Ok(words);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Error during recognition: {ex}");
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