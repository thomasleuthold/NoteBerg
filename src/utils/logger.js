/**
 * Simple in-memory logging utility for debugging
 * Logs are stored in memory during the session and can be viewed in a modal
 */

const MAX_LOG_ENTRIES = 1000; // Keep last 1000 log entries
const logEntries = [];

// Log level configuration
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

let currentLogLevel = LOG_LEVELS.warning; // Default to warning

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/**
 * Set the minimum log level
 * @param {string} level - Log level ('debug', 'info', 'warning', 'error')
 */
export function setLogLevel(level) {
  if (LOG_LEVELS[level] !== undefined) {
    currentLogLevel = LOG_LEVELS[level];
    originalConsole.log(`[Logger] Log level set to: ${level}`);
  }
}

/**
 * Get the current log level
 * @returns {string} Current log level
 */
export function getLogLevel() {
  return Object.keys(LOG_LEVELS).find((key) => LOG_LEVELS[key] === currentLogLevel) || "warning";
}

/**
 * Log a message to console and memory
 * @param {string} level - Log level ('debug', 'info', 'warning', 'error')
 * @param {string} component - Component name (e.g., 'Settings', 'MasterPassword')
 * @param {string} message - Log message
 * @param {any} data - Optional data to log
 */
export function log(level, component, message, data = null) {
  // Check if this log level should be recorded
  const levelValue = LOG_LEVELS[level] || LOG_LEVELS.info;
  if (levelValue < currentLogLevel) {
    return; // Skip logging if below threshold
  }

  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level.toUpperCase()}] [${component}] ${message}`;

  // Always log to original console
  const consoleMsg = data ? `${logLine}` : logLine;
  if (level === "error") {
    originalConsole.error(consoleMsg, data || "");
  } else if (level === "warning") {
    originalConsole.warn(consoleMsg, data || "");
  } else {
    originalConsole.log(consoleMsg, data || "");
  }

  // Store in memory
  const fullLine = data ? `${logLine} ${JSON.stringify(data)}` : logLine;
  logEntries.push({
    timestamp: new Date(),
    level,
    component,
    message: fullLine,
  });

  // Keep only the last MAX_LOG_ENTRIES
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }
}

/**
 * Capture a console message and store it in memory
 * @private
 */
function captureConsoleMessage(level, args) {
  // Check if this log level should be recorded
  const levelValue = LOG_LEVELS[level] || LOG_LEVELS.info;
  if (levelValue < currentLogLevel) {
    return; // Skip logging if below threshold
  }

  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) => {
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch (_e) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");

  const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  logEntries.push({
    timestamp: new Date(),
    level,
    component: "Console",
    message: logLine,
  });

  // Keep only the last MAX_LOG_ENTRIES
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.shift();
  }
}

/**
 * Get all log entries
 * @returns {Array} Array of log entries
 */
export function getLogs() {
  return [...logEntries];
}

/**
 * Get logs as formatted text
 * @returns {string} Formatted log text
 */
export function getLogsAsText() {
  return logEntries.map((entry) => entry.message).join("\n");
}

/**
 * Clear all logs
 */
export function clearLogs() {
  logEntries.length = 0;
  originalConsole.log("[Logger] Logs cleared");
}

/**
 * Get log count
 * @returns {number} Number of log entries
 */
export function getLogCount() {
  return logEntries.length;
}

/**
 * Check if running on Android (performance-sensitive platform)
 * @returns {boolean}
 */
function isAndroid() {
  return /android/i.test(navigator.userAgent);
}

/**
 * Initialize console interception to capture all console messages
 * This should be called once at app startup
 * @param {string} initialLevel - Initial log level (default: 'warning')
 */
export async function initLogger(initialLevel = "warning") {
  // CRITICAL PERFORMANCE FIX: Disable logger on Android
  // Console operations in Android webview are 10-100x slower than desktop
  // Intercepting every console call causes severe performance degradation
  if (isAndroid()) {
    originalConsole.log(
      "[Logger] Android detected - console interception DISABLED for performance",
    );
    originalConsole.log("[Logger] Only direct logger.error/warning calls will be captured");

    // Set log level but don't intercept console
    setLogLevel("error"); // Only capture critical errors on Android

    // DO NOT attach Rust logging to webview - causes severe performance issues
    // Rust logs will only go to stdout/terminal
    originalConsole.log("[Logger] Rust logging disabled for performance (logs go to stdout only)");

    return; // Exit early - no console interception on Android
  }

  // Desktop/browser: Set initial log level from storage if available
  try {
    const { getSetting } = await import("../modules/storage.js");
    const savedLevel = await getSetting("log_level");
    if (savedLevel) {
      setLogLevel(savedLevel);
    } else {
      setLogLevel(initialLevel);
    }
  } catch (_error) {
    // Storage not available yet, use default
    setLogLevel(initialLevel);
  }

  // Intercept console.log - map to 'debug' level
  console.log = (...args) => {
    originalConsole.log(...args);
    // Only capture if log level allows debug messages
    if (LOG_LEVELS.debug >= currentLogLevel) {
      captureConsoleMessage("debug", args);
    }
  };

  // Intercept console.warn - map to 'warning' level
  console.warn = (...args) => {
    originalConsole.warn(...args);
    // Only capture if log level allows warning messages
    if (LOG_LEVELS.warning >= currentLogLevel) {
      captureConsoleMessage("warning", args);
    }
  };

  // Intercept console.error - map to 'error' level
  console.error = (...args) => {
    originalConsole.error(...args);
    // Only capture if log level allows error messages
    if (LOG_LEVELS.error >= currentLogLevel) {
      captureConsoleMessage("error", args);
    }
  };

  originalConsole.log("[Logger] Console interception initialized with level:", getLogLevel());

  // DO NOT attach Rust logging to webview - causes severe performance issues
  // Rust logs will only go to stdout/terminal
  originalConsole.log("[Logger] Rust logging disabled for performance (logs go to stdout only)");
}

// Convenience methods
export const logger = {
  debug: (component, message, data) => log("debug", component, message, data),
  info: (component, message, data) => log("info", component, message, data),
  warning: (component, message, data) => log("warning", component, message, data),
  error: (component, message, data) => log("error", component, message, data),
};
