const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { STORAGE_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');
const { db } = require('../config/firebase');
const axios = require('axios');

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

  /**
   * Main function - handles both recording types
   */
  async getRecordingByType(channelName, type = 'mix', baseUrl = null) {
    if (type === 'mix') {
      return await this.listMixRecordings(channelName, baseUrl);
    } else if (type === 'individual') {
      return await this.listIndividualRecordings(channelName, baseUrl);
    } else {
      throw new Error(`Invalid recording type: ${type}. Must be 'mix' or 'individual'`);
    }
  }

  /**
   * Mix recording - returns single .m3u8 file
   */
  async listMixRecordings(channelName, baseUrl = null) {
    try {
      const prefix = 'recordings/mix/';
      
      // List all objects with the prefix (handle pagination)
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
      
      // Generate signed URL (for direct access if needed)
      const signedUrl = await this.generateSignedUrl(latestRecording.Key);
      
      if (!signedUrl) {
        return {
          success: false,
          message: 'Failed to generate signed URL',
          data: null
        };
      }
      
      // Generate proxy URL if baseUrl is provided
      const proxyUrl = baseUrl 
        ? `${baseUrl}/api/agora/recording/playlist?key=${encodeURIComponent(latestRecording.Key)}`
        : null;
      
      const result = {
        success: true,
        data: {
          channelName,
          type: 'mix',
          recording: {
            url: proxyUrl || signedUrl, // Prefer proxy URL for ExoPlayer compatibility
            directUrl: signedUrl, // Direct signed URL (fallback)
            proxyUrl: proxyUrl, // Proxy URL (recommended for ExoPlayer)
            key: latestRecording.Key,
            lastModified: latestRecording.LastModified,
            size: latestRecording.Size
          }
        }
      };

      // Log query to Firestore
      await this.logQueryToFirestore(channelName, prefix, result.data);

      return result;
    } catch (error) {
      logger.error('Error listing mix recordings:', error);
      throw error;
    }
  }

  /**
   * Individual recording - returns array of .m3u8 files grouped by UID
   */
  async listIndividualRecordings(channelName, baseUrl = null) {
    try {
      const prefix = 'recordings/individual/';
      
      // List all objects with the prefix (handle pagination)
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
          // Generate signed URLs and proxy URLs for all files of this UID
          const filesWithUrls = await Promise.all(
            files.map(async (file) => {
              const signedUrl = await this.generateSignedUrl(file.Key);
              
              // Generate proxy URL if baseUrl is provided
              const proxyUrl = baseUrl 
                ? `${baseUrl}/api/agora/recording/playlist?key=${encodeURIComponent(file.Key)}`
                : null;
              
              // Extract type (audio/video) from filename
              const fileType = this.extractTypeFromKey(file.Key);
              
              return {
                type: fileType,
                url: proxyUrl || signedUrl, // Prefer proxy URL for ExoPlayer compatibility
                directUrl: signedUrl, // Direct signed URL (fallback)
                proxyUrl: proxyUrl, // Proxy URL (recommended for ExoPlayer)
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
      
      const result = {
        success: true,
        data: {
          channelName,
          type: 'individual',
          recordings: recordings.filter(r => r.files.length > 0) // Remove UIDs with no valid files
        }
      };

      // Log query to Firestore
      await this.logQueryToFirestore(channelName, prefix, result.data);

      return result;
    } catch (error) {
      logger.error('Error listing individual recordings:', error);
      throw error;
    }
  }

  /**
   * Helper: List all objects with pagination support
   */
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

  /**
   * Helper: Filter only .m3u8 files (exclude .ts segments)
   */
  filterM3U8Files(files) {
    return files.filter(file => file.Key.endsWith('.m3u8'));
  }

  /**
   * Helper: Extract UID from filename (Official Agora pattern)
   * Pattern: {sid}_{cname}__uid_s_<uid>__uid_e_<type>.m3u8
   */
  extractUidFromKey(key) {
    const match = key.match(/__uid_s_(\d+)__uid_e_/);
    return match ? match[1] : null;
  }

  /**
   * Helper: Extract file type (audio/video) from filename
   * Pattern: __uid_e_<type>.m3u8
   */
  extractTypeFromKey(key) {
    const match = key.match(/__uid_e_(\w+)\.m3u8$/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Helper: Group individual recordings by UID
   */
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

  /**
   * Helper: Generate signed URL
   */
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

  /**
   * Helper: Log query to Firestore
   */
  async logQueryToFirestore(channelName, prefix, responseData) {
    try {
      await db.collection('agora_recording_queries').add({
        channelName,
        prefix,
        response: responseData,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error logging query to Firestore:', error);
      // Don't throw - logging failure shouldn't break the request
    }
  }

  /**
   * Proxy method: Fetch and serve .m3u8 file with correct headers
   * This ensures ExoPlayer can recognize it as an HLS playlist
   * Also rewrites .ts segment URLs to use proxy endpoint
   */
  async getM3U8Playlist(key, baseUrl, expiresIn = 3600) {
    try {
      // Generate signed URL for the .m3u8 file
      const m3u8SignedUrl = await this.generateSignedUrl(key, expiresIn);
      
      if (!m3u8SignedUrl) {
        throw new Error('Failed to generate signed URL for m3u8 file');
      }

      // Fetch the .m3u8 file content
      const response = await axios.get(m3u8SignedUrl, {
        responseType: 'text',
        timeout: 10000
      });

      const playlistContent = response.data;
      
      // Extract directory path from the key (for relative .ts paths)
      const keyDir = key.substring(0, key.lastIndexOf('/') + 1);
      
      // Rewrite .ts segment URLs to use proxy endpoint
      // Pattern: lines starting with segment filenames (not starting with #)
      const lines = playlistContent.split('\n');
      const rewrittenLines = lines.map((line) => {
        const trimmedLine = line.trim();
        
        // Skip comments and empty lines
        if (trimmedLine.startsWith('#') || trimmedLine === '') {
          return line;
        }
        
        // If line contains .ts file, rewrite to use proxy endpoint
        if (trimmedLine.endsWith('.ts')) {
          // Handle both relative and absolute paths
          let tsKey;
          if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://')) {
            // Absolute URL - extract key from URL if possible, or use as-is
            // For now, if it's already absolute, we might need to keep it
            // But for signed URLs, we should rewrite to proxy
            return line; // Keep original for now
          } else {
            // Relative path - construct full key
            tsKey = keyDir + trimmedLine;
          }
          
          // Rewrite to use proxy endpoint
          const proxyUrl = `${baseUrl}/api/agora/recording/playlist?key=${encodeURIComponent(tsKey)}`;
          return proxyUrl;
        }
        
        // Return original line if not a .ts file
        return line;
      });

      return {
        content: rewrittenLines.join('\n'),
        contentType: 'application/vnd.apple.mpegurl' // Correct content-type for HLS
      };
    } catch (error) {
      logger.error(`Error fetching m3u8 playlist for ${key}:`, error);
      throw error;
    }
  }
}

module.exports = new RecordingService();

