/**
 * Auto Recognition Module
 * Handles background handwriting recognition scheduling
 */

import { fetch } from "@tauri-apps/plugin-http";
import { getNote, updateNote, getSetting } from "./storage.js";

// Configuration
const RECOGNITION_DEBOUNCE_MS = 2500; // 2.5 seconds inactivity

let recognitionTimer = null;

/**
 * Schedule recognition for a note
 * Call this whenever strokes are added/modified in the editor
 * @param {string} noteId
 * @param {Array} strokes - Current strokes array
 */
export function scheduleRecognition(noteId, strokes) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
  }

  recognitionTimer = setTimeout(() => {
    performRecognition(noteId, strokes);
  }, RECOGNITION_DEBOUNCE_MS);
}

/**
 * Force immediate recognition (e.g. on note close)
 * @param {string} noteId
 * @param {Array} strokes
 */
export async function forceRecognition(noteId, strokes) {
  if (recognitionTimer) {
    clearTimeout(recognitionTimer);
    recognitionTimer = null;
  }
  await performRecognition(noteId, strokes);
}

/**
 * Execute the recognition process
 */
async function performRecognition(noteId, strokes) {
  if (!strokes || strokes.length === 0) return;

  // Notify start of recognition
  window.dispatchEvent(new CustomEvent("recognition-start"));

  try {
    console.log(`[Recognition] Processing note ${noteId}...`);

    // Get URL from settings
    const baseUrl = (await getSetting("recognition_url")) || "http://localhost:5000";
    const language = (await getSetting("recognition_language")) || "en-US";
    const apiUrl = `${baseUrl.replace(/\/$/, "")}/recognize?language=${language}`;

    // Format strokes for the Web Service
    // Expected format: { id: "uuid", points: [{x, y, pressure, ...}] }
    const formattedStrokes = strokes.map((s) => ({
      id: s.id,
      points: s.x.map((x, i) => ({
        x,
        y: s.y[i],
        pressure: s.pressure?.[i] || 0.5,
      })),
    }));

    // Call the web service
    let result;
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formattedStrokes),
      });

      if (!response.ok) throw new Error(`Service returned ${response.status} ${response.statusText}`);
      result = await response.json();
    } catch (err) {
      console.warn("[Recognition] Service call failed:", err);
      return;
    }

    if (result) {
      // Update the note with recognition data
      // We fetch the note first to ensure we don't overwrite other concurrent changes
      const note = await getNote(noteId);
      if (note) {
        // Construct the recognition object
        // Flatten the words into a full text string for simple search
        const fullText = result.map((w) => w.text).join(" ");

        const newRecognitionData = {
          fullText,
          words: result,
        };

        // Only update if data actually changed to avoid unnecessary writes/syncs
        if (JSON.stringify(note.recognition) !== JSON.stringify(newRecognitionData)) {
          await updateNote(noteId, {
            recognition: newRecognitionData,
            // updateNote automatically updates 'modified' timestamp
            // This will trigger a sync, which is desirable so the search index propagates to other devices
          });
          console.log(`[Recognition] Success for note ${noteId}`);
        }
      }
    }
  } catch (error) {
    console.error(`[Recognition] Failed for note ${noteId}:`, error);
  } finally {
    // Notify end of recognition
    window.dispatchEvent(new CustomEvent("recognition-end"));
  }
}
