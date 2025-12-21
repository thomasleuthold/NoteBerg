# Hierarchical Storage Structure Implementation

## Overview

oneJournal has been upgraded from a flat file storage structure (v1) to a hierarchical folder-based structure (v2) for better organization, scalability, and future media file support.

## Storage Structure Comparison

### Old Structure (v1 - Flat)
```
/oneJournal/
├── notebook_abc123.json
├── notebook_xyz789.json
├── note_def456.json
├── note_ghi012.json
└── ...
```

**Problems:**
- All files in one folder (doesn't scale well)
- No logical grouping
- Difficult to manage related files (notes + future media)
- Inefficient sync for large datasets

### New Structure (v2 - Hierarchical)
```
/oneJournal/
├── notebooks/
│   ├── abc123/
│   │   ├── _notebook.json          (notebook metadata)
│   │   ├── _tombstones.json        (deleted items tracking)
│   │   └── notes/
│   │       ├── def456.json
│   │       ├── def456_media/       (future: images, audio, etc.)
│   │       │   ├── image1.jpg
│   │       │   └── audio1.mp3
│   │       └── ghi012.json
│   └── xyz789/
│       ├── _notebook.json
│       ├── _tombstones.json
│       └── notes/
│           └── jkl345.json
└── quickNotes/
    ├── qn001.json
    ├── qn002.json
    └── _tombstones.json
```

**Benefits:**
- Clear organization matching app structure
- Scalable to 1000s of notes
- Media-ready (each note can have media folder)
- Efficient sync (only sync changed notebooks)
- Export-friendly (can export/share notebook folders)
- Future-proof for additional features

## Implementation Details

### New Modules Created

#### 1. `src/modules/storagePaths.js`
Manages all path generation for the hierarchical structure.

**Key Functions:**
- `getNotebookPath(notebookId)` - Path to notebook metadata file
- `getNotePath(noteId, notebookId)` - Path to note file (notebook or quick note)
- `getNoteMediaFolder(noteId, notebookId)` - Path to note's media folder
- `getNotebookTombstonePath(notebookId)` - Path to tombstone file
- `parsePath(path)` - Parse hierarchical path to extract components
- `getLegacyNotebookPath(notebookId)` - Legacy flat structure path (for migration)

#### 2. `src/modules/tombstones.js`
Manages tombstone tracking for deleted items.

**Tombstone Structure:**
```json
{
  "notes": [
    {
      "id": "note-id",
      "deletedAt": "2025-01-15T10:30:00Z"
    }
  ],
  "media": [
    {
      "noteId": "note-id",
      "filename": "image1.jpg",
      "deletedAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

**Key Functions:**
- `addNoteTombstone(tombstone, noteId)` - Mark note as deleted
- `addMediaTombstone(tombstone, noteId, filename)` - Mark media file as deleted
- `cleanupOldTombstones(tombstone)` - Remove tombstones older than 90 days
- `mergeTombstones(local, remote)` - Merge tombstones during sync

**Retention Policy:**
- Tombstones kept for 90 days
- Automatically cleaned up during sync
- Prevents re-downloading deleted items

### Updated Modules

#### 1. `src/modules/nextcloudSync.js`
Complete rewrite of sync functions for hierarchical structure.

**Updated Functions:**
- `syncNotebooks(notebooks)` - Creates folder structure and uploads metadata
- `syncNotes(notes)` - Uploads notes to correct folder (notebook or quickNotes)
- `downloadAllData()` - Recursively downloads hierarchical structure
- `fullSync()` - Bidirectional sync with conflict resolution
- `deleteRemoteNotebook(notebookId)` - Marks notebook as deleted in tombstone
- `deleteRemoteNote(noteId, notebookId)` - Marks note as deleted and removes file

**New Functions:**
- `ensureHierarchicalStructure()` - Creates required folders
- `uploadTombstone(notebookId, tombstone)` - Uploads tombstone file
- `downloadTombstone(notebookId)` - Downloads tombstone file
- `migrateToHierarchical()` - Migrates from flat to hierarchical
- `needsMigration()` - Checks if migration is needed

#### 2. `src/modules/storage.js`
Added storage version tracking.

**New Functions:**
- `getStorageVersion()` - Returns current storage version (1 or 2)
- `setStorageVersion(version)` - Updates storage version

#### 3. `src/components/settingsMode.js`
Added migration UI in settings panel.

**New Section:**
- "Storage Migration" section (only visible when authenticated)
- "Check Migration Status" button
- "Migrate Now" button (shown only if migration needed)
- Migration status messages and info

## Migration Process

### Automatic Detection
The app automatically detects if migration is needed by:
1. Checking local storage version (defaults to v1 if not set)
2. Checking remote structure for legacy flat files

### User-Initiated Migration
Migration is user-initiated through the Settings panel:

1. User clicks "Check Migration Status"
2. System checks for legacy files on Nextcloud
3. If found, shows "Migrate Now" button
4. User confirms migration
5. System:
   - Downloads all flat structure files
   - Creates hierarchical folder structure
   - Uploads files to new locations
   - Updates local storage version to v2
   - **Keeps old flat files for safety**

### Migration Safety
- **Non-destructive:** Old files are NOT deleted
- **Reversible:** Can manually restore from old files if needed
- **Logged:** All migration steps logged to console
- **Error handling:** Failed migrations don't corrupt data

## Future Enhancements

### Media File Support
The structure is ready for media files:

```javascript
// Upload image to note
const mediaPath = getMediaPath(noteId, notebookId, "photo.jpg");
await uploadFile(mediaPath, imageBlob);

// List all media for a note
const mediaFolder = getNoteMediaFolder(noteId, notebookId);
const mediaFiles = await listFiles(mediaFolder);
```

### Notebook-Level Features
The notebook folder can contain:
- Templates
- Shared settings
- Custom themes
- Backup configurations

### Export/Share
Can easily export entire notebook:
```javascript
// Export notebook folder as ZIP
const notebookFolder = getNotebookFolder(notebookId);
// Download entire folder with all notes and media
```

## API Changes

### Breaking Changes
None for local API - all existing functions work the same.

### New Exports

**storagePaths.js:**
- All path generation functions
- `STORAGE_VERSION` constant
- `ROOT_FOLDER` constant

**tombstones.js:**
- All tombstone management functions

**nextcloudSync.js:**
- `migrateToHierarchical()` function
- `needsMigration()` function
- `uploadTombstone()` function
- `downloadTombstone()` function
- `deleteRemoteNotebook()` function (replaces generic `deleteRemoteItem`)
- `deleteRemoteNote()` function (replaces generic `deleteRemoteItem`)

**storage.js:**
- `getStorageVersion()` function
- `setStorageVersion()` function

## Testing Recommendations

### Manual Testing Checklist

1. **Fresh Installation (v2)**
   - [ ] Create notebook → Check folder structure created
   - [ ] Create note in notebook → Check file in correct location
   - [ ] Create quick note → Check file in quickNotes folder
   - [ ] Sync to Nextcloud → Verify hierarchical structure
   - [ ] Delete note → Check tombstone created
   - [ ] Sync after deletion → Verify remote file deleted

2. **Migration from v1**
   - [ ] Start with flat structure data on Nextcloud
   - [ ] Check migration status → Should show "migration available"
   - [ ] Run migration → Verify all files migrated
   - [ ] Verify data integrity after migration
   - [ ] Check old flat files still present
   - [ ] Sync after migration → Should use hierarchical structure

3. **Edge Cases**
   - [ ] Migration with 0 notebooks → Should handle gracefully
   - [ ] Migration with 100+ notes → Should complete successfully
   - [ ] Network error during migration → Should show error, not corrupt data
   - [ ] Concurrent sync during migration → Should handle safely

4. **Tombstone Management**
   - [ ] Delete note → Tombstone created
   - [ ] Sync → Tombstone uploaded
   - [ ] Delete same note on different device → Tombstones merged
   - [ ] Wait 90 days → Old tombstones cleaned up

## Rollback Procedure

If issues occur after migration:

1. Old flat files are still on server at:
   - `/oneJournal/notebook_*.json`
   - `/oneJournal/note_*.json`

2. To rollback:
   ```javascript
   // In browser console or code:
   await setStorageVersion(1);
   // Then manually delete hierarchical folders if desired
   ```

3. Or manually restore from old files using WebDAV

## Configuration

### Storage Version
Stored in IndexedDB settings:
```javascript
{
  key: "storageVersion",
  value: 2  // or 1 for flat structure
}
```

### Tombstone Retention
Defined in `tombstones.js`:
```javascript
const TOMBSTONE_RETENTION_DAYS = 90;
```

Can be changed if needed for different retention policies.

## Performance Considerations

### Sync Efficiency
- **v1 (Flat):** Lists entire folder every sync (~1 request per 100 files)
- **v2 (Hierarchical):** Lists only changed notebooks (~1 request per notebook)

### Large Datasets
- **v1:** Slows down with 100+ files in single folder
- **v2:** Scales well to 1000s of notes across multiple notebooks

### Network Requests
Migration makes multiple requests:
- 1 request per legacy file download
- 1 request per folder creation
- 1 request per file upload to new location

Estimated time: ~1-2 seconds per 10 files on good connection.

## Security Considerations

### Tombstones
- Tombstones contain only IDs and timestamps
- No sensitive content stored in tombstones
- Cleaned up automatically after 90 days

### Migration
- Old files kept for safety (user can delete manually)
- No destructive operations during migration
- All operations logged for audit

### Media Files (Future)
- Media files stored alongside notes
- Same access control as notes
- Can implement encryption per-folder if needed

## Conclusion

The hierarchical storage structure provides:
- ✅ Better organization and scalability
- ✅ Ready for media file support
- ✅ Efficient sync for large datasets
- ✅ Export/share capabilities
- ✅ Future-proof architecture
- ✅ Safe, user-initiated migration
- ✅ Non-destructive upgrade path

The implementation is complete and ready for testing!
