/**
 * The HTML parser the pure text modules (textMerge.js, textBoxes.js) use: the
 * browser's DOMParser, or one set for a context without a DOM (a worker uses
 * linkedom's, see workers/noteFileWorker.js and StorageWorker.js).
 */

let injectedParser = null;

/** Parse with `Parser` (a DOMParser-compatible class) instead of the global DOMParser. */
export function useHtmlParser(Parser) {
  injectedParser = Parser;
}

/** The parser in use, or undefined when there is none. */
export function htmlParser() {
  return injectedParser ?? globalThis.DOMParser;
}

/** Parse an HTML fragment into a document whose body holds it. */
export function parseHtmlBody(html) {
  const Parser = htmlParser();
  return new Parser().parseFromString(`<html><body>${html}</body></html>`, "text/html");
}
