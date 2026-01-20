const { STORAGE_CONFIG } = require('../config/env');
const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  endpoint: STORAGE_CONFIG.cloudflareEndpoint,
  region: "auto",
  credentials: {
    accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
    secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey,
  }
});

exports.cleanupSecureFiles = async (req, res) => {
  try {

    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
    const cutoffTime = Date.now() - FIVE_DAYS_MS;

    let isTruncated = true;
    let continuationToken;
    let deletedCount = 0;

    while (isTruncated) {
      const listResp = await s3.send(
        new ListObjectsV2Command({
          Bucket: STORAGE_CONFIG.bucketName,
          Prefix: "secure/", // 🔥 only secure folder
          ContinuationToken: continuationToken
        })
      );

      const objects = listResp.Contents || [];

      for (const obj of objects) {
        if (!obj.LastModified) continue;

        const lastModifiedTime = new Date(obj.LastModified).getTime();

        if (lastModifiedTime < cutoffTime) {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: STORAGE_CONFIG.bucketName,
              Key: obj.Key
            })
          );

          deletedCount++;
          console.log("Deleted:", obj.Key);
        }
      }

      isTruncated = listResp.IsTruncated;
      continuationToken = listResp.NextContinuationToken;
    }

    return res.status(200).json({
      success: true,
      deletedFiles: deletedCount,
      message: "Cleanup completed"
    });

  } catch (error) {
    console.error("Cleanup error:", error);

    return res.status(500).json({
      success: false,
      message: "Cleanup failed",
      error: error.message
    });
  }
};

