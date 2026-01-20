const { db } = require('../config/firebase');
const { STORAGE_CONFIG } = require('../config/env');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  endpoint: STORAGE_CONFIG.cloudflareEndpoint,
  region: "auto",
  credentials: {
    accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
    secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey,
  }
});

// Cache expiration: 7 days (in milliseconds)
const CACHE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Generate a cache key from playlist S3 key
 */
function getCacheKey(playlistKey) {
  return `playlist_cache_${playlistKey.replace(/\//g, '_')}`;
}

/**
 * Check if cached playlist URL is still valid
 */
function isCacheValid(cachedData) {
  if (!cachedData || !cachedData.cachedAt) return false;

  const cachedAt = cachedData.cachedAt.toMillis ? cachedData.cachedAt.toMillis() : new Date(cachedData.cachedAt).getTime();
  const now = Date.now();

  return (now - cachedAt) < CACHE_EXPIRATION_MS;
}

/**
 * Get cached playlist URL from Firestore
 */
async function getCachedPlaylistUrl(playlistKey) {
  try {
    const cacheKey = getCacheKey(playlistKey);
    const doc = await db.collection('playlist_cache').doc(cacheKey).get();

    if (!doc.exists) {
      return null;
    }

    const data = doc.data();

    if (isCacheValid(data)) {
      return {
        playableUrl: data.playableUrl,
        secureKey: data.secureKey,
        cached: true
      };
    }

    // Cache expired, delete it
    await db.collection('playlist_cache').doc(cacheKey).delete();
    return null;
  } catch (error) {
    console.error('Error getting cached playlist URL:', error);
    return null;
  }
}

/**
 * Generate a deterministic secure key for a playlist
 */
function getSecureKey(playlistKey) {
  const fileName = playlistKey.split("/").pop();
  // Use a hash of the playlist key instead of timestamp to reuse same file
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(playlistKey).digest('hex').substring(0, 8);
  return `secure/${hash}_${fileName}`;
}

/**
 * Check if secure file exists in S3
 */
async function secureFileExists(secureKey) {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: secureKey,
      })
    );
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/**
 * Generate signed URLs for playlist and cache in Firestore
 */
async function generateAndCachePlaylistUrl(playlistKey) {
  try {
    const secureKey = getSecureKey(playlistKey);
    let needsUpload = false;

    // Check if secure file already exists
    const fileExists = await secureFileExists(secureKey);

    if (!fileExists) {
      // Read original playlist from S3
      const playlistResp = await s3.send(
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: playlistKey,
        })
      );

      const playlistText = await playlistResp.Body.transformToString("utf-8");
      const lines = playlistText.split("\n");
      const basePath = playlistKey.substring(0, playlistKey.lastIndexOf("/") + 1);

      // Generate signed URLs for all TS segments
      const updatedLines = await Promise.all(
        lines.map(async (line) => {
          if (line.endsWith(".ts")) {
            return await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: STORAGE_CONFIG.bucketName,
                Key: basePath + line,
              }),
              { expiresIn: 7 * 24 * 60 * 60 } // 7 days expiration
            );
          }
          return line;
        })
      );

      const updatedPlaylist = updatedLines.join("\n");

      // Upload rewritten playlist to S3 (only if it doesn't exist)
      await s3.send(
        new PutObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: secureKey,
          Body: updatedPlaylist,
          ContentType: "application/vnd.apple.mpegurl",
        })
      );
      needsUpload = true;
    }

    // Generate signed URL for the playlist itself (regenerate even if file exists to refresh expiration)
    const signedPlaylistUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: secureKey,
      }),
      { expiresIn: 7 * 24 * 60 * 60 } // 7 days expiration
    );

    // Cache in Firestore
    const cacheKey = getCacheKey(playlistKey);
    await db.collection('playlist_cache').doc(cacheKey).set({
      playlistKey,
      playableUrl: signedPlaylistUrl,
      secureKey,
      cachedAt: new Date(),
      expiresAt: new Date(Date.now() + CACHE_EXPIRATION_MS),
    });

    return {
      playableUrl: signedPlaylistUrl,
      secureKey,
      cached: false,
      reused: !needsUpload
    };
  } catch (error) {
    console.error('Error generating and caching playlist URL:', error);
    throw error;
  }
}

/**
 * Get playlist URL (cached or generate new)
 */
async function getPlaylistUrl(playlistKey) {
  // Try to get from cache first
  const cached = await getCachedPlaylistUrl(playlistKey);

  if (cached) {
    return cached;
  }

  // Generate new and cache
  return await generateAndCachePlaylistUrl(playlistKey);
}

module.exports = {
  getPlaylistUrl,
  getCachedPlaylistUrl,
  generateAndCachePlaylistUrl,
  CACHE_EXPIRATION_MS
};
