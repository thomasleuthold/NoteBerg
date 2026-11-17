/**
 * Release gate for notebook sharing.
 *
 * Sharing is user-visible only once every part of it exists. Until then share
 * discovery, the root guard and the sharing UI stay off, so a share created
 * through the Nextcloud web UI never shows up on an intermediate build without
 * the recipient restrictions that make it safe.
 */
export const SHARING_ENABLED = true;
