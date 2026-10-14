/**
 * In-memory stand-in for the Rust zip commands (backup.rs).
 *
 * Rust owns the archive, so a browser test has no zip to read or write. This
 * fakes the command surface the JS side calls (`restore_*` / `backup_*`) over a
 * plain `{ entryName: entry }` map, which is exactly the archive layout from
 * documentation/backup_restore_design.md §3 — so a fixture is human-readable
 * and a backup captured here can be fed straight back in as a restore source.
 *
 * Entry shapes (JSON-serialisable, they cross into the page):
 *   { text: string }                 JSON / manifest entries
 *   { base64: string }               media
 *
 * What this does NOT test: zip encoding, AES, free-space probing, the native
 * pickers. Those are Rust (or manual) territory. It does test everything on the
 * JS side of the invoke boundary, including argument names and result shapes.
 *
 * Page-side API, on `window.__fakeArchive`:
 *   source          entries served to restore_*   (replace with .load(entries, password))
 *   sourcePassword  password restore_unlock accepts (null: any, as for a plain archive)
 *   written         entries captured from backup_* (read after a backup)
 *   writtenPassword password backup_begin was given (null: unencrypted)
 *   writeDelayMs    delay added to every backup write, so a test can cancel mid-run
 */

const SOURCE_PATH = "C:/e2e/fixture-backup.zip";
const DEST_PATH = "C:/e2e/new-backup.zip";

export async function installFakeArchive(page, entries = {}) {
  await page.addInitScript(
    ({ initial, sourcePath, destPath }) => {
      const utf8Bytes = (text) => new TextEncoder().encode(text).length;
      const b64Size = (b64) => atob(b64).length;
      const sizeOf = (e) => (e.text !== undefined ? utf8Bytes(e.text) : b64Size(e.base64));

      const fake = {
        source: initial,
        sourcePassword: null,
        written: {},
        writtenPassword: null,
        writeDelayMs: 0,
        load(entries, password = null) {
          fake.source = entries;
          fake.sourcePassword = password;
        },
      };
      const writeDelay = () => new Promise((resolve) => setTimeout(resolve, fake.writeDelayMs));
      window.__fakeArchive = fake;

      // Restore reads one binary entry at a time: begin → chunk* → end.
      let reading = null;
      // Backup writes one binary entry at a time: begin_entry → chunk* → (next).
      let writing = null;

      const entry = (name) => {
        const e = fake.source[name];
        if (!e) throw new Error(`NOT_A_BACKUP: no entry ${name}`);
        return e;
      };

      Object.assign(window.__tauriHandlers, {
        // ── restore ──
        restore_choose_source: () => sourcePath,
        restore_open: () => ({
          entries: Object.entries(fake.source).map(([name, e]) => ({ name, size: sizeOf(e) })),
          manifest: fake.source["manifest.json"]?.text ?? null,
        }),
        // Same error string backup.rs returns; mapArchiveError turns it into code "wrong-password".
        restore_unlock: ({ password }) => {
          if (fake.sourcePassword != null && password !== fake.sourcePassword) {
            throw "WRONG_PASSWORD: incorrect password";
          }
          return null;
        },
        restore_read_text: ({ name }) => entry(name).text,
        restore_read_begin: ({ name }) => {
          reading = entry(name).base64;
          return b64Size(reading);
        },
        restore_read_chunk: ({ offset, len }) => {
          // Slice on byte boundaries, not base64 characters.
          const bytes = atob(reading);
          return btoa(bytes.slice(offset, offset + len));
        },
        restore_read_end: () => {
          reading = null;
          return null;
        },
        restore_close: () => null,

        // ── backup ──
        backup_choose_destination: () => destPath,
        backup_free_space: () => null, // desktop: not knowable
        backup_begin: ({ password }) => {
          fake.written = {};
          fake.writtenPassword = password ?? null;
          writing = null;
          return null;
        },
        backup_add_text: async ({ name, text }) => {
          await writeDelay();
          fake.written[name] = { text };
          return null;
        },
        backup_begin_entry: ({ name }) => {
          writing = name;
          fake.written[name] = { base64: "" };
          return null;
        },
        backup_write_chunk: async ({ dataBase64 }) => {
          await writeDelay();
          // Concatenate as bytes: base64 chunks cannot be joined as strings.
          const prev = atob(fake.written[writing].base64);
          fake.written[writing].base64 = btoa(prev + atob(dataBase64));
          return null;
        },
        backup_finish: () => ({
          path: destPath,
          bytes: Object.values(fake.written).reduce((n, e) => n + sizeOf(e), 0),
        }),
        backup_abort: () => {
          fake.written = {};
          return null;
        },
      });
    },
    { initial: entries, sourcePath: SOURCE_PATH, destPath: DEST_PATH },
  );
}
