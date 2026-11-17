/**
 * src/modules/textMerge.linkedom.test.js
 * The text merge runs in a worker (workers/mergeWorker.js), where there is no
 * DOMParser and linkedom's is used instead. Every text-merge test runs again
 * here with that parser, so the two give the same merges (text boxes included:
 * textBoxes.js parses with the same parser).
 */

import { DOMParser } from "linkedom";
import { useHtmlParser } from "./textMerge.js";

useHtmlParser(DOMParser);
await import("./textMerge.test.js");
await import("./textMerge.property.test.js");
await import("./textMerge.boxes.test.js");
await import("./textMerge.boxes.property.test.js");
await import("./textBoxes.test.js");
