/**
 * Nextcloud Sync Module
 * Uses Nextcloud Login Flow v2 and WebDAV for syncing
 * Uses Tauri's HTTP client for native requests (no CORS issues!)
 */

import { fetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';

const NEXTCLOUD_STORAGE_KEY = 'nextcloud_credentials';
const SYNC_FOLDER = '/oneJournal';

/**
 * Get stored Nextcloud credentials
 */
export function getStoredCredentials() {
  const stored = localStorage.getItem(NEXTCLOUD_STORAGE_KEY);
  return stored ? JSON.parse(stored) : null;
}

/**
 * Save Nextcloud credentials
 */
function saveCredentials(credentials) {
  localStorage.setItem(NEXTCLOUD_STORAGE_KEY, JSON.stringify(credentials));
}

/**
 * Clear stored credentials
 */
export function clearCredentials() {
  localStorage.removeItem(NEXTCLOUD_STORAGE_KEY);
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated() {
  const creds = getStoredCredentials();
  return creds && creds.serverUrl && creds.loginName && creds.appPassword;
}

/**
 * Test connection to Nextcloud server
 */
export async function testConnection(serverUrl) {
  serverUrl = serverUrl.replace(/\/$/, '');

  try {
    const response = await fetch(`${serverUrl}/status.php`);
    const data = await response.json();

    if (data.installed && data.version) {
      return {
        success: true,
        version: data.version,
        versionstring: data.versionstring,
      };
    }

    return { success: false, error: 'Not a valid Nextcloud server' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Start Nextcloud Login Flow v2
 * Returns a promise that resolves when authentication is complete
 * Calls onLoginUrlReady callback with login URL when available
 */
export async function startLoginFlow(serverUrl, onLoginUrlReady = null) {
  serverUrl = serverUrl.replace(/\/$/, '');

  try {
    // Step 1: Initialize login flow
    console.log('Initializing Login Flow v2 for:', serverUrl);

    let initResponse;
    try {
      initResponse = await fetch(`${serverUrl}/index.php/login/v2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'OCS-APIRequest': 'true',
          'User-Agent': 'oneJournal/1.0',
        },
        body: '',
      });
    } catch (fetchError) {
      console.error('Fetch error:', fetchError);
      throw new Error(`Network error: ${fetchError.message || 'Failed to connect to server'}`);
    }

    console.log('Init response status:', initResponse.status);
    console.log('Init response headers:', initResponse.headers);

    if (!initResponse.ok) {
      const errorText = await initResponse.text();
      console.error('Init response error:', errorText);
      throw new Error(`Failed to initialize login flow: ${initResponse.status} ${initResponse.statusText}`);
    }

    const responseText = await initResponse.text();
    console.log('Init response body:', responseText);

    if (!responseText || responseText.trim() === '') {
      console.error('Empty response from server');
      throw new Error('Empty response from server');
    }

    let initData;
    try {
      initData = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse init response as JSON:', e);
      console.error('Response text was:', responseText);
      throw new Error(`Invalid JSON response from server: ${e.message}`);
    }

    console.log('Parsed init data:', initData);

    const { poll, login } = initData;

    if (!poll || !login) {
      console.error('Missing required fields in response:', { poll, login });
      throw new Error('Invalid login flow response - missing poll or login');
    }

    // Extract token from poll object
    const token = poll.token;
    const endpoint = poll.endpoint;

    if (!token || !endpoint) {
      console.error('Missing token or endpoint in poll object:', poll);
      throw new Error('Invalid poll response - missing token or endpoint');
    }

    console.log('Login Flow initialized:', { endpoint, token: token.substring(0, 10) + '...', login });

    // Step 2: Provide login URL to callback (for UI display)
    if (onLoginUrlReady) {
      onLoginUrlReady(login);
    }

    // Step 3: Try to open login page in default browser
    console.log('Opening login page in browser:', login);
    try {
      await openUrl(login);
      console.log('Browser opened successfully');
    } catch (openError) {
      console.warn('Failed to open URL automatically:', openError);
      // If automatic opening fails, user can still use the URL field
    }

    // Step 3: Poll for credentials (browser-based, no popup to track)
    const credentials = await pollForCredentials(endpoint, token, null);

    // Step 4: Save credentials
    const savedCreds = {
      serverUrl,
      loginName: credentials.loginName,
      appPassword: credentials.appPassword,
    };

    saveCredentials(savedCreds);
    console.log('Nextcloud authentication successful');

    return savedCreds;
  } catch (error) {
    console.error('Login flow error:', error);
    throw error;
  }
}

/**
 * Poll for credentials after user completes login
 */
async function pollForCredentials(endpoint, token, popup) {
  const maxAttempts = 60; // 5 minutes (60 * 5 seconds)
  let attempts = 0;

  return new Promise((resolve, reject) => {
    console.log('Starting to poll for credentials. Please complete login in your browser...');

    const pollInterval = setInterval(async () => {
      attempts++;

      // Check if popup was closed (only if popup exists)
      if (popup && popup.closed) {
        clearInterval(pollInterval);
        reject(new Error('Login cancelled by user'));
        return;
      }

      // Check if max attempts reached
      if (attempts > maxAttempts) {
        clearInterval(pollInterval);
        if (popup) popup.close();
        reject(new Error('Login timeout - please try again'));
        return;
      }

      try {
        // Poll endpoint with token as URL parameter (not body!)
        const pollUrl = `${endpoint}?token=${encodeURIComponent(token)}`;
        console.log(`Polling attempt ${attempts}/${maxAttempts}...`);

        const response = await fetch(pollUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.status === 404) {
          // Still waiting for user to complete login
          console.log('Waiting for user to complete login...');
          return;
        }

        if (!response.ok) {
          clearInterval(pollInterval);
          if (popup) popup.close();
          reject(new Error(`Polling failed: ${response.status} ${response.statusText}`));
          return;
        }

        // Success! We have credentials
        const data = await response.json();
        console.log('Login successful! Credentials received.');
        clearInterval(pollInterval);
        if (popup) popup.close();
        resolve(data);
      } catch (error) {
        // Continue polling on network errors
        console.warn('Poll attempt failed:', error.message);
      }
    }, 5000); // Poll every 5 seconds
  });
}

/**
 * Create a folder in Nextcloud using WebDAV
 */
async function createFolder(path) {
  const creds = getStoredCredentials();
  if (!creds) throw new Error('Not authenticated');

  console.log('Creating folder with credentials:', {
    serverUrl: creds.serverUrl,
    loginName: creds.loginName,
    hasAppPassword: !!creds.appPassword,
  });

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const authHeader = `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`;
  console.log('Auth header preview:', authHeader.substring(0, 20) + '...');

  const response = await fetch(webdavUrl, {
    method: 'MKCOL',
    headers: {
      Authorization: authHeader,
      'OCS-APIRequest': 'true',
    },
  });

  console.log('MKCOL response status:', response.status);

  if (!response.ok && response.status !== 201 && response.status !== 405) {
    const responseText = await response.text();
    console.log('MKCOL error response:', responseText);
  }

  if (response.status === 405) {
    // Folder already exists
    return true;
  }

  if (!response.ok && response.status !== 201) {
    throw new Error(`Failed to create folder: ${response.status} ${response.statusText}`);
  }

  return true;
}

/**
 * Upload a file to Nextcloud using WebDAV
 */
async function uploadFile(path, content) {
  const creds = getStoredCredentials();
  if (!creds) throw new Error('Not authenticated');

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      'Content-Type': 'application/json',
    },
    body: content,
  });

  if (!response.ok && response.status !== 201 && response.status !== 204) {
    throw new Error(`Failed to upload file: ${response.status} ${response.statusText}`);
  }

  return true;
}

/**
 * Download a file from Nextcloud using WebDAV
 */
async function downloadFile(path) {
  const creds = getStoredCredentials();
  if (!creds) throw new Error('Not authenticated');

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
    },
  });

  if (response.status === 404) {
    return null; // File doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

/**
 * List files in a folder using WebDAV PROPFIND
 */
async function listFiles(path) {
  const creds = getStoredCredentials();
  if (!creds) throw new Error('Not authenticated');

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
      Depth: '1',
    },
  });

  if (response.status === 404) {
    return []; // Folder doesn't exist
  }

  if (!response.ok) {
    throw new Error(`Failed to list files: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  return parseWebDAVResponse(text);
}

/**
 * Parse WebDAV XML response
 */
function parseWebDAVResponse(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const responses = doc.getElementsByTagName('d:response');

  const files = [];
  for (let i = 0; i < responses.length; i++) {
    const response = responses[i];
    const href = response.getElementsByTagName('d:href')[0]?.textContent;
    const resourceType = response.getElementsByTagName('d:resourcetype')[0];
    const isCollection = resourceType?.getElementsByTagName('d:collection').length > 0;
    const lastModified = response.getElementsByTagName('d:getlastmodified')[0]?.textContent;
    const etag = response.getElementsByTagName('d:getetag')[0]?.textContent;

    if (href && !isCollection) {
      // Extract filename from href
      const filename = decodeURIComponent(href.split('/').pop());
      files.push({
        name: filename,
        href,
        lastModified: lastModified ? new Date(lastModified).getTime() : null,
        etag: etag?.replace(/"/g, ''),
      });
    }
  }

  return files;
}

/**
 * Delete a file from Nextcloud using WebDAV
 */
async function deleteFile(path) {
  const creds = getStoredCredentials();
  if (!creds) throw new Error('Not authenticated');

  const webdavUrl = `${creds.serverUrl}/remote.php/dav/files/${creds.loginName}${path}`;

  const response = await fetch(webdavUrl, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${btoa(`${creds.loginName}:${creds.appPassword}`)}`,
    },
  });

  if (response.status === 404) {
    return true; // File doesn't exist, consider it deleted
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to delete file: ${response.status} ${response.statusText}`);
  }

  return true;
}

/**
 * Sync notebooks to Nextcloud
 */
export async function syncNotebooks(notebooks) {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Nextcloud');
  }

  // Ensure sync folder exists
  await createFolder(SYNC_FOLDER);

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
  };

  for (const notebook of notebooks) {
    try {
      const filename = `notebook_${notebook.id}.json`;
      const path = `${SYNC_FOLDER}/${filename}`;
      const content = JSON.stringify(notebook, null, 2);

      await uploadFile(path, content);
      results.uploaded++;
    } catch (error) {
      results.failed++;
      results.errors.push({ id: notebook.id, error: error.message });
      console.error(`Failed to sync notebook ${notebook.id}:`, error);
    }
  }

  return results;
}

/**
 * Sync notes to Nextcloud
 */
export async function syncNotes(notes) {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Nextcloud');
  }

  // Ensure sync folder exists
  await createFolder(SYNC_FOLDER);

  const results = {
    uploaded: 0,
    failed: 0,
    errors: [],
  };

  for (const note of notes) {
    try {
      const filename = `note_${note.id}.json`;
      const path = `${SYNC_FOLDER}/${filename}`;
      const content = JSON.stringify(note, null, 2);

      await uploadFile(path, content);
      results.uploaded++;
    } catch (error) {
      results.failed++;
      results.errors.push({ id: note.id, error: error.message });
      console.error(`Failed to sync note ${note.id}:`, error);
    }
  }

  return results;
}

/**
 * Download all data from Nextcloud
 */
export async function downloadAllData() {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Nextcloud');
  }

  const files = await listFiles(SYNC_FOLDER);

  const notebooks = [];
  const notes = [];

  for (const file of files) {
    try {
      const path = `${SYNC_FOLDER}/${file.name}`;
      const content = await downloadFile(path);

      if (!content) continue;

      const data = JSON.parse(content);

      if (file.name.startsWith('notebook_')) {
        notebooks.push(data);
      } else if (file.name.startsWith('note_')) {
        notes.push(data);
      }
    } catch (error) {
      console.error(`Failed to download ${file.name}:`, error);
    }
  }

  return { notebooks, notes };
}

/**
 * Full sync: upload local changes and download remote changes
 */
export async function fullSync(localNotebooks, localNotes) {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Nextcloud');
  }

  console.log('Starting full sync...');

  // Upload local data
  const uploadResults = {
    notebooks: await syncNotebooks(localNotebooks),
    notes: await syncNotes(localNotes),
  };

  // Download remote data
  const remoteData = await downloadAllData();

  console.log('Full sync completed:', {
    uploaded: uploadResults,
    downloaded: {
      notebooks: remoteData.notebooks.length,
      notes: remoteData.notes.length,
    },
  });

  return {
    uploaded: uploadResults,
    downloaded: remoteData,
  };
}

/**
 * Delete remote file for a deleted item
 */
export async function deleteRemoteItem(id, type) {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Nextcloud');
  }

  const filename = `${type}_${id}.json`;
  const path = `${SYNC_FOLDER}/${filename}`;

  try {
    await deleteFile(path);
    return true;
  } catch (error) {
    console.error(`Failed to delete remote ${type} ${id}:`, error);
    return false;
  }
}
