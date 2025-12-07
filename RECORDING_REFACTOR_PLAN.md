# Recording List Refactoring - Research & Implementation Plan

## 📋 Research Summary

### 1. Agora Cloud Recording Modes (Official Documentation)

#### Individual Recording Mode
- **Purpose**: Records each participant's audio/video streams separately
- **Output**: Multiple files - one set per user (UID)
- **File Structure**: Each user gets their own `.m3u8` playlist + multiple `.ts` segments
- **Use Case**: When Flutter needs user-wise recordings for individual processing
- **File Formats**: 
  - **`.m3u8`** - Playlist file (indexes all `.ts` segments) - **RETURN THIS TO FLUTTER**
  - **`.ts`** - Transport stream segments (actual media data) - **DO NOT RETURN THESE**
- **Official File Naming Pattern** (from Agora docs):
  - **M3U8**: `<sid>_<cname>__uid_s_<uid>__uid_e_<type>.m3u8`
    - Example: `abc123_channel1__uid_s_12345__uid_e_audio.m3u8`
    - Example: `abc123_channel1__uid_s_12345__uid_e_video.m3u8`
  - **TS**: `<sid>_<cname>__uid_s_<uid>__uid_e_<type>_utc.ts`
    - Example: `abc123_channel1__uid_s_12345__uid_e_audio_utc.ts`
  - Where:
    - `<sid>` = Recording session ID
    - `<cname>` = Channel name
    - `<uid>` = User ID
    - `<type>` = `audio` or `video`
- **Storage Pattern**: 
  - Prefix: `recordings/individual/` (from `fileNamePrefix: ["recordings", "individual"]`)
  - Multiple `.m3u8` files per channel (one per user, potentially one for audio + one for video per user)
  - Multiple `.ts` files per `.m3u8` (segments)

#### Mix/Composite Recording Mode
- **Purpose**: Combines all participants' streams into a single file
- **Output**: Single set of files containing all users mixed together
- **File Structure**: One `.m3u8` playlist + multiple `.ts` segments
- **Use Case**: When Flutter needs a single combined recording
- **File Formats**:
  - **`.m3u8`** - Playlist file (indexes all `.ts` segments) - **RETURN THIS TO FLUTTER**
  - **`.ts`** - Transport stream segments (actual media data) - **DO NOT RETURN THESE**
- **Official File Naming Pattern** (from Agora docs):
  - **M3U8**: `<sid>_<cname>_mix.m3u8`
    - Example: `abc123_channel1_mix.m3u8`
  - **TS**: `<sid>_<cname>_mix_<timestamp>.ts`
    - Example: `abc123_channel1_mix_20240101120000.ts`
  - Where:
    - `<sid>` = Recording session ID
    - `<cname>` = Channel name
    - `<timestamp>` = UTC timestamp
- **Storage Pattern**:
  - Prefix: `recordings/mix/` (from `fileNamePrefix: ["recordings", "mix"]`)
  - Single `.m3u8` file per channel
  - Multiple `.ts` files per `.m3u8` (segments)

### 2. Cloudflare R2 Storage Structure

#### Current Configuration
- **Storage Vendor**: Cloudflare R2 (vendor code: 11)
- **Endpoint**: Custom Cloudflare R2 endpoint
- **File Naming**: Controlled by `fileNamePrefix` in storage config
- **Current Prefix Pattern**: `["recordings", type]` → creates `recordings/{type}/`

#### File Organization (Based on Official Agora Documentation)
```
bucket/
├── recordings/
│   ├── mix/
│   │   ├── {sid}_{cname}_mix.m3u8          ← Return this to Flutter
│   │   ├── {sid}_{cname}_mix_20240101120000.ts
│   │   ├── {sid}_{cname}_mix_20240101120010.ts
│   │   └── {sid}_{cname}_mix_20240101120020.ts
│   └── individual/
│       ├── {sid}_{cname}__uid_s_12345__uid_e_audio.m3u8    ← Return this to Flutter
│       ├── {sid}_{cname}__uid_s_12345__uid_e_video.m3u8    ← Return this to Flutter
│       ├── {sid}_{cname}__uid_s_12345__uid_e_audio_utc.ts
│       ├── {sid}_{cname}__uid_s_12345__uid_e_video_utc.ts
│       ├── {sid}_{cname}__uid_s_67890__uid_e_audio.m3u8    ← Return this to Flutter
│       ├── {sid}_{cname}__uid_s_67890__uid_e_video.m3u8    ← Return this to Flutter
│       └── {sid}_{cname}__uid_s_67890__uid_e_audio_utc.ts
```

**Key Points:**
- Only return `.m3u8` files to Flutter (playlist files)
- `.m3u8` files reference all `.ts` segments automatically
- Flutter player will fetch `.ts` segments as needed using the `.m3u8` playlist
- Individual mode may have separate audio and video `.m3u8` files per user

### 3. Current Implementation Analysis

#### Existing `listRecordings` Function
- **Location**: `src/controllers/agora.controller.js` (lines 490-553)
- **Current Behavior**:
  - Hardcoded prefix: `'recordings/mix/'` (default)
  - Filters by `channelName` in object key
  - Generates signed URLs with 1-hour expiration
  - Logs queries to Firestore (`agora_recording_queries` collection)
- **Limitations**:
  - Only handles mix recordings by default
  - No support for individual recording type
  - No user-specific filtering for individual recordings
  - No optimization for Flutter client needs

#### Recording Start Configuration
- **Storage Config** (line 161-171):
  ```javascript
  fileNamePrefix: ["recordings", type]  // type = 'mix' or 'individual'
  ```
- **Recording Config** (line 172-185):
  - Mix mode: Includes `audioProfile`, `maxIdleTime`
  - Individual mode: Includes `subscribeUidGroup`, `maxIdleTime`

### 4. Flutter Client Requirements

#### Individual Recording Requests
- **Expectation**: Get all user-wise recordings (one or more `.m3u8` files per user)
- **Response Format Needed**:
  ```json
  {
    "success": true,
    "data": {
      "channelName": "channel123",
      "type": "individual",
      "recordings": [
        {
          "uid": "12345",
          "files": [
            {
              "type": "audio",
              "url": "signed-url-audio.m3u8",
              "key": "recordings/individual/abc123_channel123__uid_s_12345__uid_e_audio.m3u8",
              "lastModified": "2024-01-01T00:00:00Z",
              "size": 1024
            },
            {
              "type": "video",
              "url": "signed-url-video.m3u8",
              "key": "recordings/individual/abc123_channel123__uid_s_12345__uid_e_video.m3u8",
              "lastModified": "2024-01-01T00:00:00Z",
              "size": 2048
            }
          ]
        },
        {
          "uid": "67890",
          "files": [
            {
              "type": "audio",
              "url": "signed-url-audio.m3u8",
              "key": "recordings/individual/abc123_channel123__uid_s_67890__uid_e_audio.m3u8",
              "lastModified": "2024-01-01T00:00:00Z",
              "size": 1024
            }
          ]
        }
      ]
    }
  }
  ```
  **Note**: Each user may have separate audio and video `.m3u8` files

#### Mix Recording Requests
- **Expectation**: Get single combined recording file (`.m3u8` playlist)
- **Response Format Needed**:
  ```json
  {
    "success": true,
    "data": {
      "channelName": "channel123",
      "type": "mix",
      "recording": {
        "url": "signed-url",
        "key": "recordings/mix/abc123_channel123_mix.m3u8",
        "lastModified": "2024-01-01T00:00:00Z",
        "size": 5120
      }
    }
  }
  ```
  **Note**: Returns single `.m3u8` file that references all `.ts` segments

## 🎯 Implementation Plan

### Phase 1: File Structure Refactoring

#### 1.1 Create New Recording Service File
- **File**: `src/services/recording.service.js`
- **Purpose**: Centralize all recording list/retrieval functions
- **Responsibilities**:
  - Cloudflare R2 operations (list, filter, generate signed URLs)
  - Recording type detection and handling
  - User-specific filtering for individual recordings
  - Response formatting for Flutter client

#### 1.2 Functions to Move/Create

**From `agora.controller.js` → `recording.service.js`:**
- `listRecordings` logic (lines 490-553)
- S3Client initialization (lines 477-484)

**New Functions to Create:**
- `listMixRecordings(channelName)` - Get mix recording for a channel (returns `.m3u8` file only)
- `listIndividualRecordings(channelName)` - Get all individual recordings for a channel (returns `.m3u8` files only, grouped by UID)
- `getRecordingByType(channelName, type)` - Unified function that handles both types
- `extractUidFromKey(key)` - Helper to extract UID from individual recording filenames
  - Pattern: `__uid_s_<uid>__uid_e_` (extract `<uid>`)
- `filterM3U8Files(files)` - Filter to return only `.m3u8` files (exclude `.ts` files)
- `groupIndividualRecordingsByUid(files)` - Group individual recordings by UID (may have separate audio/video)
- `generateSignedUrl(key, expiresIn)` - Centralized signed URL generation

### Phase 2: Controller Refactoring

#### 2.1 Update `agora.controller.js`
- Remove `listRecordings` function
- Remove S3Client initialization
- Import `recording.service.js`
- Create new controller functions:
  - `listRecordings` - Main endpoint (calls service)
  - `getMixRecording` - Specific endpoint for mix recordings
  - `getIndividualRecordings` - Specific endpoint for individual recordings

#### 2.2 Controller Function Signatures
```javascript
// Main endpoint - auto-detects type or accepts type parameter
exports.listRecordings = async (req, res) => {
  const { channelName, type } = req.body;
  // Calls recordingService.getRecordingByType()
}

// Specific endpoint for mix
exports.getMixRecording = async (req, res) => {
  const { channelName } = req.body;
  // Calls recordingService.listMixRecordings()
}

// Specific endpoint for individual
exports.getIndividualRecordings = async (req, res) => {
  const { channelName } = req.body;
  // Calls recordingService.listIndividualRecordings()
}
```

### Phase 3: Service Implementation Details

#### 3.1 Recording Service Structure
```javascript
// src/services/recording.service.js

const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { STORAGE_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');

class RecordingService {
  constructor() {
    this.s3 = new S3Client({
      endpoint: STORAGE_CONFIG.cloudflareEndpoint,
      region: "auto",
      credentials: {
        accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
        secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey,
      }
    });
  }

  // Main function - handles both types
  async getRecordingByType(channelName, type = 'mix') {
    if (type === 'mix') {
      return await this.listMixRecordings(channelName);
    } else if (type === 'individual') {
      return await this.listIndividualRecordings(channelName);
    }
  }

  // Mix recording - returns single .m3u8 file
  async listMixRecordings(channelName) {
    try {
      const prefix = 'recordings/mix/';
      
      // List all objects with the prefix
      const allObjects = await this.listAllObjects(prefix);
      
      // Filter: Only .m3u8 files that contain channelName
      const m3u8Files = this.filterM3U8Files(allObjects)
        .filter(obj => obj.Key.includes(channelName));
      
      if (m3u8Files.length === 0) {
        return {
          success: false,
          message: 'No mix recording found for this channel',
          data: null
        };
      }
      
      // Get the most recent recording (by LastModified)
      const latestRecording = m3u8Files.sort((a, b) => 
        new Date(b.LastModified) - new Date(a.LastModified)
      )[0];
      
      // Generate signed URL
      const signedUrl = await this.generateSignedUrl(latestRecording.Key);
      
      if (!signedUrl) {
        return {
          success: false,
          message: 'Failed to generate signed URL',
          data: null
        };
      }
      
      return {
        success: true,
        data: {
          channelName,
          type: 'mix',
          recording: {
            url: signedUrl,
            key: latestRecording.Key,
            lastModified: latestRecording.LastModified,
            size: latestRecording.Size
          }
        }
      };
    } catch (error) {
      logger.error('Error listing mix recordings:', error);
      throw error;
    }
  }

  // Individual recording - returns array of .m3u8 files grouped by UID
  async listIndividualRecordings(channelName) {
    try {
      const prefix = 'recordings/individual/';
      
      // List all objects with the prefix
      const allObjects = await this.listAllObjects(prefix);
      
      // Filter: Only .m3u8 files that contain channelName
      const m3u8Files = this.filterM3U8Files(allObjects)
        .filter(obj => obj.Key.includes(channelName));
      
      if (m3u8Files.length === 0) {
        return {
          success: false,
          message: 'No individual recordings found for this channel',
          data: null
        };
      }
      
      // Group by UID
      const groupedByUid = this.groupIndividualRecordingsByUid(m3u8Files);
      
      // Process each UID's recordings
      const recordings = await Promise.all(
        Object.entries(groupedByUid).map(async ([uid, files]) => {
          // Generate signed URLs for all files of this UID
          const filesWithUrls = await Promise.all(
            files.map(async (file) => {
              const signedUrl = await this.generateSignedUrl(file.Key);
              
              // Extract type (audio/video) from filename
              const typeMatch = file.Key.match(/__uid_e_(\w+)\.m3u8$/);
              const fileType = typeMatch ? typeMatch[1] : 'unknown';
              
              return {
                type: fileType,
                url: signedUrl,
                key: file.Key,
                lastModified: file.LastModified,
                size: file.Size
              };
            })
          );
          
          return {
            uid,
            files: filesWithUrls.filter(f => f.url !== null) // Remove failed URL generations
          };
        })
      );
      
      return {
        success: true,
        data: {
          channelName,
          type: 'individual',
          recordings: recordings.filter(r => r.files.length > 0) // Remove UIDs with no valid files
        }
      };
    } catch (error) {
      logger.error('Error listing individual recordings:', error);
      throw error;
    }
  }

  // Helper: Extract UID from filename (Official Agora pattern)
  extractUidFromKey(key) {
    // Pattern: {sid}_{cname}__uid_s_<uid>__uid_e_<type>.m3u8
    // Extract UID between __uid_s_ and __uid_e_
    const match = key.match(/__uid_s_(\d+)__uid_e_/);
    return match ? match[1] : null;
  }

  // Helper: Extract file type (audio/video) from filename
  extractTypeFromKey(key) {
    // Pattern: __uid_e_<type>.m3u8
    // Extract type (audio or video) from individual recording filename
    const match = key.match(/__uid_e_(\w+)\.m3u8$/);
    return match ? match[1] : 'unknown';
  }

  // Helper: Filter only .m3u8 files (exclude .ts segments)
  filterM3U8Files(files) {
    return files.filter(file => file.Key.endsWith('.m3u8'));
  }

  // Helper: Group individual recordings by UID
  groupIndividualRecordingsByUid(files) {
    const grouped = {};
    files.forEach(file => {
      const uid = this.extractUidFromKey(file.Key);
      if (uid) {
        if (!grouped[uid]) {
          grouped[uid] = [];
        }
        grouped[uid].push(file);
      }
    });
    return grouped;
  }

  // Helper: Generate signed URL
  async generateSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: key,
      });
      const url = await getSignedUrl(this.s3, command, { expiresIn });
      return url;
    } catch (error) {
      logger.error(`Error generating signed URL for ${key}:`, error);
      return null;
    }
  }

  // Helper: List all objects with pagination support
  async listAllObjects(prefix) {
    const allObjects = [];
    let continuationToken = null;
    
    do {
      const params = {
        Bucket: STORAGE_CONFIG.bucketName,
        Prefix: prefix,
        MaxKeys: 1000, // Maximum keys per request
      };
      
      if (continuationToken) {
        params.ContinuationToken = continuationToken;
      }
      
      const command = new ListObjectsV2Command(params);
      const response = await this.s3.send(command);
      
      if (response.Contents) {
        allObjects.push(...response.Contents);
      }
      
      continuationToken = response.IsTruncated ? response.NextContinuationToken : null;
    } while (continuationToken);
    
    return allObjects;
  }
}

module.exports = new RecordingService();
```

#### 3.2 Key Implementation Considerations

**For Mix Recordings:**
- Prefix: `recordings/mix/`
- Filter: Contains `channelName` AND ends with `.m3u8`
- Expected: 1 `.m3u8` file (playlist that references all `.ts` segments)
- Response: Single recording object with `.m3u8` URL
- **Important**: Only return `.m3u8` file, not `.ts` segments

**For Individual Recordings:**
- Prefix: `recordings/individual/`
- Filter: Contains `channelName` AND ends with `.m3u8`
- Expected: Multiple `.m3u8` files (one per user, potentially separate audio/video per user)
- Response: Array of recordings with UID mapping
- Extract UID from filename pattern: `__uid_s_<uid>__uid_e_`
- **Important**: Only return `.m3u8` files, not `.ts` segments
- **Note**: Each user may have 2 `.m3u8` files (audio + video), group them by UID

**File Naming Patterns (Official Agora Documentation):**
- **Mix Mode**: `<sid>_<cname>_mix.m3u8` and `<sid>_<cname>_mix_<timestamp>.ts`
- **Individual Mode**: `<sid>_<cname>__uid_s_<uid>__uid_e_<type>.m3u8` and `<sid>_<cname>__uid_s_<uid>__uid_e_<type>_utc.ts`
- **Key**: Always filter to return only `.m3u8` files to Flutter
- The `.m3u8` playlist file contains references to all `.ts` segments
- Flutter player will automatically fetch `.ts` segments when playing `.m3u8`

### Phase 3.3: Detailed Implementation - Cloudflare R2 Operations

#### 3.3.1 Reading from Cloudflare R2 Using S3Client

**Key Operations:**

1. **ListObjectsV2Command** - Lists objects in R2 bucket
   - Use `Prefix` to filter by directory path (`recordings/mix/` or `recordings/individual/`)
   - Use `MaxKeys` (default 1000) to limit results per request
   - Handle pagination with `ContinuationToken` if `IsTruncated` is true

2. **Filtering Strategy** (CRITICAL - Only Return Required Files):
   ```javascript
   // Step 1: Filter by file extension - ONLY .m3u8 files
   const m3u8Files = allObjects.filter(obj => obj.Key.endsWith('.m3u8'));
   
   // Step 2: Filter by channel name
   const channelFiles = m3u8Files.filter(obj => obj.Key.includes(channelName));
   
   // Step 3: For individual mode, extract and group by UID
   // Step 4: Generate signed URLs ONLY for filtered .m3u8 files
   ```

3. **Pagination Handling**:
   ```javascript
   // R2 may return up to 1000 objects per request
   // If IsTruncated is true, use NextContinuationToken to get more
   // Implement loop to fetch all pages if needed
   ```

4. **Signed URL Generation**:
   - Use `GetObjectCommand` + `getSignedUrl` from `@aws-sdk/s3-request-presigner`
   - Set appropriate expiration (default 3600 seconds = 1 hour)
   - Generate URLs ONLY for `.m3u8` files (not `.ts` files)

#### 3.3.2 File Filtering Best Practices

**Why Filter at Application Level:**
- R2's `ListObjectsV2Command` doesn't support filtering by file extension
- Must filter in JavaScript after receiving results
- This ensures we NEVER return `.ts` files to Flutter

**Filtering Chain:**
```javascript
// 1. List all objects with prefix
const allObjects = await listAllObjects('recordings/mix/');

// 2. Filter ONLY .m3u8 files (exclude .ts, .mp4, etc.)
const m3u8Files = allObjects.filter(obj => obj.Key.endsWith('.m3u8'));

// 3. Filter by channel name
const channelFiles = m3u8Files.filter(obj => obj.Key.includes(channelName));

// 4. Generate signed URLs ONLY for filtered files
const urls = await Promise.all(
  channelFiles.map(file => generateSignedUrl(file.Key))
);
```

**Performance Optimization:**
- Filter `.m3u8` files FIRST (before generating signed URLs)
- This reduces unnecessary signed URL generation for `.ts` files
- Use `Promise.all()` for parallel signed URL generation

#### 3.3.3 Response Structure - Only Required URLs

**Mix Recording Response:**
```json
{
  "success": true,
  "data": {
    "channelName": "channel123",
    "type": "mix",
    "recording": {
      "url": "https://signed-url-to-m3u8-file",
      "key": "recordings/mix/abc123_channel123_mix.m3u8",
      "lastModified": "2024-01-01T00:00:00Z",
      "size": 5120
    }
  }
}
```
**Note**: Only ONE URL returned (the `.m3u8` file)

**Individual Recording Response:**
```json
{
  "success": true,
  "data": {
    "channelName": "channel123",
    "type": "individual",
    "recordings": [
      {
        "uid": "12345",
        "files": [
          {
            "type": "audio",
            "url": "https://signed-url-to-audio-m3u8",
            "key": "recordings/individual/abc123_channel123__uid_s_12345__uid_e_audio.m3u8",
            "lastModified": "2024-01-01T00:00:00Z",
            "size": 1024
          },
          {
            "type": "video",
            "url": "https://signed-url-to-video-m3u8",
            "key": "recordings/individual/abc123_channel123__uid_s_12345__uid_e_video.m3u8",
            "lastModified": "2024-01-01T00:00:00Z",
            "size": 2048
          }
        ]
      }
    ]
  }
}
```
**Note**: Only `.m3u8` URLs returned (NO `.ts` files)

#### 3.3.4 Error Handling

```javascript
// Handle missing recordings
if (m3u8Files.length === 0) {
  return {
    success: false,
    message: 'No recordings found',
    data: null
  };
}

// Handle signed URL generation failures
const urls = await Promise.all(
  files.map(async (file) => {
    const url = await generateSignedUrl(file.Key);
    return url ? { ...file, url } : null;
  })
);
const validUrls = urls.filter(url => url !== null);
```

#### 3.3.5 Security Considerations

1. **Signed URL Expiration**: 
   - Default: 1 hour (3600 seconds)
   - Configurable per request if needed
   - Shorter expiration = more secure

2. **Access Control**:
   - R2 bucket should have proper permissions
   - Only authorized users can request recordings
   - Signed URLs provide temporary access

3. **No Direct URLs**:
   - Never return direct R2 URLs
   - Always use signed URLs for security

### Phase 4: Route Updates

#### 4.1 Update `agora.routes.js`
```javascript
// Existing
router.post('/recording/list', [verifyToken], agoraController.listRecordings);

// New (optional - for specific endpoints)
router.post('/recording/list/mix', [verifyToken], agoraController.getMixRecording);
router.post('/recording/list/individual', [verifyToken], agoraController.getIndividualRecordings);
```

### Phase 5: Flutter Optimization

#### 5.1 Response Format Optimization
- **Consistent Structure**: Same response format regardless of type
- **Metadata**: Include file size, last modified, duration (if available)
- **URL Expiration**: Configurable expiration time (default 1 hour)
- **Error Handling**: Clear error messages for missing recordings

#### 5.2 Performance Considerations
- **Caching**: Consider caching recording metadata in Firestore
- **Pagination**: If many individual recordings, implement pagination
- **Lazy Loading**: Generate signed URLs on-demand, not all at once

### Phase 6: Testing Strategy

#### 6.1 Test Cases
1. **Mix Recording**:
   - Test with existing mix recording
   - Verify single file returned
   - Verify signed URL works

2. **Individual Recording**:
   - Test with existing individual recording
   - Verify all user files returned
   - Verify UID extraction works correctly
   - Verify signed URLs work for all files

3. **Edge Cases**:
   - Channel with no recordings
   - Channel with only mix recording
   - Channel with only individual recording
   - Channel with both types

4. **Error Handling**:
   - Invalid channel name
   - Missing recordings
   - R2 connection errors

## 📁 Proposed File Structure

```
src/
├── controllers/
│   └── agora.controller.js          # Updated - recording list functions removed
├── services/
│   └── recording.service.js         # NEW - All recording list logic
├── routes/
│   └── agora.routes.js              # Updated - new routes (optional)
└── config/
    └── env.js                        # No changes
```

## 🔄 Migration Steps

1. **Create `src/services/` directory** (if doesn't exist)
2. **Create `recording.service.js`** with S3Client and helper functions
3. **Implement `listMixRecordings()`** function
4. **Implement `listIndividualRecordings()`** function
5. **Implement `getRecordingByType()`** wrapper function
6. **Update `agora.controller.js`**:
   - Remove S3Client initialization
   - Remove `listRecordings` implementation
   - Import recording service
   - Create new controller functions
7. **Update routes** (if adding specific endpoints)
8. **Test thoroughly** with both recording types
9. **Update API documentation** if needed

## 🔍 Cloudflare R2 Operations - Detailed Implementation

### Reading from R2 Using S3Client

#### Current Implementation Analysis
The existing `listRecordings` function (lines 490-553) has these issues:
1. ❌ Returns ALL files (including `.ts` files)
2. ❌ No filtering by file extension
3. ❌ No pagination handling
4. ❌ Hardcoded prefix for mix only

#### Required Changes

**1. Filter Only .m3u8 Files:**
```javascript
// BEFORE (Current - Returns ALL files including .ts):
const files = (data.Contents || [])
  .filter(obj => obj.Key.includes(channelName));

// AFTER (New - Returns ONLY .m3u8 files):
const m3u8Files = (data.Contents || [])
  .filter(obj => obj.Key.endsWith('.m3u8'))  // ← CRITICAL FILTER
  .filter(obj => obj.Key.includes(channelName));
```

**2. Handle Pagination:**
```javascript
// R2 may have > 1000 files, need pagination
let allObjects = [];
let continuationToken = null;

do {
  const params = {
    Bucket: STORAGE_CONFIG.bucketName,
    Prefix: prefix,
    MaxKeys: 1000,
  };
  
  if (continuationToken) {
    params.ContinuationToken = continuationToken;
  }
  
  const command = new ListObjectsV2Command(params);
  const response = await s3.send(command);
  
  if (response.Contents) {
    allObjects.push(...response.Contents);
  }
  
  continuationToken = response.IsTruncated 
    ? response.NextContinuationToken 
    : null;
} while (continuationToken);
```

**3. Generate Signed URLs Only for .m3u8 Files:**
```javascript
// Only generate signed URLs for filtered .m3u8 files
const signedUrls = await Promise.all(
  m3u8Files.map(async (file) => {
    const signedUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: file.Key,  // Only .m3u8 files reach here
      }),
      { expiresIn: 3600 }
    );
    
    return {
      key: file.Key,
      url: signedUrl,  // Only .m3u8 URL returned
      lastModified: file.LastModified,
      size: file.Size
    };
  })
);
```

#### Complete Flow for Mix Recording

```javascript
async listMixRecordings(channelName) {
  // 1. List all objects with prefix
  const prefix = 'recordings/mix/';
  const allObjects = await this.listAllObjects(prefix);
  
  // 2. Filter ONLY .m3u8 files (exclude .ts)
  const m3u8Files = allObjects.filter(obj => 
    obj.Key.endsWith('.m3u8') && obj.Key.includes(channelName)
  );
  
  // 3. Get most recent recording
  const latest = m3u8Files.sort((a, b) => 
    new Date(b.LastModified) - new Date(a.LastModified)
  )[0];
  
  // 4. Generate signed URL ONLY for .m3u8 file
  const signedUrl = await this.generateSignedUrl(latest.Key);
  
  // 5. Return ONLY the .m3u8 URL (no .ts files)
  return {
    success: true,
    data: {
      channelName,
      type: 'mix',
      recording: {
        url: signedUrl,  // ← Only .m3u8 URL
        key: latest.Key,
        lastModified: latest.LastModified,
        size: latest.Size
      }
    }
  };
}
```

#### Complete Flow for Individual Recording

```javascript
async listIndividualRecordings(channelName) {
  // 1. List all objects with prefix
  const prefix = 'recordings/individual/';
  const allObjects = await this.listAllObjects(prefix);
  
  // 2. Filter ONLY .m3u8 files (exclude .ts)
  const m3u8Files = allObjects.filter(obj => 
    obj.Key.endsWith('.m3u8') && obj.Key.includes(channelName)
  );
  
  // 3. Group by UID
  const groupedByUid = this.groupIndividualRecordingsByUid(m3u8Files);
  
  // 4. Generate signed URLs ONLY for .m3u8 files
  const recordings = await Promise.all(
    Object.entries(groupedByUid).map(async ([uid, files]) => {
      const filesWithUrls = await Promise.all(
        files.map(async (file) => {
          const signedUrl = await this.generateSignedUrl(file.Key);
          return {
            type: this.extractTypeFromKey(file.Key), // audio or video
            url: signedUrl,  // ← Only .m3u8 URL
            key: file.Key,
            lastModified: file.LastModified,
            size: file.Size
          };
        })
      );
      
      return {
        uid,
        files: filesWithUrls  // ← Only .m3u8 URLs
      };
    })
  );
  
  // 5. Return ONLY .m3u8 URLs (no .ts files)
  return {
    success: true,
    data: {
      channelName,
      type: 'individual',
      recordings
    }
  };
}
```

#### Key Points - Only Required URLs

✅ **DO:**
- Filter with `.endsWith('.m3u8')` BEFORE generating signed URLs
- Return only `.m3u8` file URLs to Flutter
- Group individual recordings by UID
- Handle pagination for large buckets

❌ **DON'T:**
- Return `.ts` files to Flutter
- Generate signed URLs for `.ts` files
- Return all files without filtering
- Ignore pagination (may miss files)

## ⚠️ Important Notes (Based on Official Agora Documentation)

1. **File Naming Pattern** (Official Agora Format):
   - **Mix Mode**: `<sid>_<cname>_mix.m3u8` and `<sid>_<cname>_mix_<timestamp>.ts`
   - **Individual Mode**: `<sid>_<cname>__uid_s_<uid>__uid_e_<type>.m3u8` and `<sid>_<cname>__uid_s_<uid>__uid_e_<type>_utc.ts`
   - Pattern is consistent and documented by Agora

2. **UID Extraction**: Individual recording filenames contain UID
   - Pattern: `__uid_s_<uid>__uid_e_`
   - Use regex: `/__uid_s_(\d+)__uid_e_/` to extract UID
   - Example: `abc123_channel1__uid_s_12345__uid_e_audio.m3u8` → UID = `12345`

3. **File Types - CRITICAL**:
   - **`.m3u8`** - Playlist file (RETURN THIS TO FLUTTER)
   - **`.ts`** - Transport stream segments (DO NOT RETURN THESE)
   - **Why**: The `.m3u8` file is an HLS playlist that references all `.ts` segments
   - Flutter player will automatically fetch `.ts` segments when playing `.m3u8`
   - Always filter: `files.filter(f => f.Key.endsWith('.m3u8'))`

4. **Individual Recording Structure**:
   - Each user may have 2 `.m3u8` files: one for audio, one for video
   - Extract type from filename: `__uid_e_<type>.m3u8` where `<type>` = `audio` or `video`
   - Group recordings by UID in response

5. **Firestore Logging**: Keep existing Firestore logging for queries
   - Maintain `agora_recording_queries` collection logging

6. **Backward Compatibility**: Ensure existing API calls still work
   - Default behavior should remain same (mix recording)

## 🚀 Next Steps (After Implementation)

1. **Verify File Patterns**: Check actual file structure in R2 bucket
2. **Add Metadata**: Store recording metadata in Firestore for faster queries
3. **Add Caching**: Cache recording lists to reduce R2 API calls
4. **Add Webhooks**: Listen to Agora webhooks for recording completion
5. **Add Validation**: Validate recording type before querying

---

**Status**: Research Complete ✅ | Based on Official Agora Documentation | Ready for Implementation

---

## 📚 Official Agora Documentation References

- **File Management**: https://docs.agora.io/en/cloud-recording/develop/manage-files/
- **Individual Mode**: https://docs.agora.io/en/cloud-recording/develop/individual-mode
- **Composite Mode**: https://docs.agora.io/en/cloud-recording/develop/composite-mode
- **Online Playback**: https://docs.agora.io/en/cloud-recording/develop/online-play

**Key Takeaways from Official Docs:**
1. Files are stored as `.m3u8` (HLS playlist) and `.ts` (segments)
2. File naming follows specific patterns documented by Agora
3. Only `.m3u8` files should be returned to clients (they reference `.ts` segments)
4. Individual mode creates separate files per UID (may have audio + video per UID)
5. Mix mode creates single combined file

