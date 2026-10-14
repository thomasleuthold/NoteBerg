/**
 * Stateful stand-in for the OS keychain commands (`save_credential`,
 * `get_credential`, `delete_credential` in lib.rs).
 *
 * Like the real keychain, entries outlive a page reload but not the browser
 * context (a fresh context is a fresh device). They are kept in sessionStorage
 * under one key the app never reads, so a reload in the same tab sees them.
 *
 * Page-side API, on `window.__fakeKeyring`:
 *   entries()     current { key: value } map
 *   delete(key)   drop an entry, as if the keychain lost it
 */

const STORE_KEY = "__e2e_fake_keyring";

export async function installFakeKeyring(page) {
  await page.addInitScript((storeKey) => {
    const load = () => JSON.parse(sessionStorage.getItem(storeKey) || "{}");
    const save = (entries) => sessionStorage.setItem(storeKey, JSON.stringify(entries));

    window.__fakeKeyring = {
      entries: load,
      delete(key) {
        const entries = load();
        delete entries[key];
        save(entries);
      },
    };

    Object.assign(window.__tauriHandlers, {
      save_credential: ({ key, value }) => {
        save({ ...load(), [key]: value });
        return null;
      },
      get_credential: ({ key }) => load()[key] ?? null,
      delete_credential: ({ key }) => {
        window.__fakeKeyring.delete(key);
        return null;
      },
    });
  }, STORE_KEY);
}
