const { db } = require('../config/firebase');
const admin = require('firebase-admin');
const { STORAGE_CONFIG } = require('../config/env');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3 = new S3Client({
  endpoint: STORAGE_CONFIG.cloudflareEndpoint,
  region: "auto",
  credentials: {
    accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
    secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey,
  }
});

function extractRecordingTimeFromKey(key) {
  const match = key.match(/_(\d{14,17})\.(m3u8|ts)$/);
  if (!match) return null;

  const ts = match[1];

  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(4, 6)) - 1;
  const day = Number(ts.slice(6, 8));
  const hour = Number(ts.slice(8, 10));
  const min = Number(ts.slice(10, 12));
  const sec = Number(ts.slice(12, 14));
  const ms =
    ts.length > 14 ? Number(ts.slice(14).padEnd(3, '0')) : 0;

  return new Date(Date.UTC(year, month, day, hour, min, sec, ms));
}


async function getMixRecordingsList({
  channelName,
  prefix = "recordings/mix/",
}) {
  if (!channelName) {
    throw new Error("channelName is required");
  }

  const THREE_HOURS = 3 * 3600;

  const now = Date.now();

  // 1️⃣ List objects from S3
  const data = await s3.send(
    new ListObjectsV2Command({
      Bucket: STORAGE_CONFIG.bucketName,
      Prefix: prefix,
    })
  );

  // 2️⃣ Filter m3u8 files for this channel
  const files = (data.Contents || []).filter(
    (obj) =>
      obj.Key.includes(channelName) &&
      obj.Key.endsWith(".m3u8")
  );

  if (!files.length) {
    return [];
  }

  // 3️⃣ Process playlists
  return Promise.all(
    files.map(async (obj) => {
      const docId = obj.Key.replace(/\//g, "_");
      const docRef = db
        .collection("meetings")
        .doc(channelName)
        .collection("recordingUrls")
        .doc(docId);

      // 🔹 Check Firestore cache
      const snap = await docRef.get();
      if (snap.exists) {
        const cached = snap.data();
        if (cached.expiresAt && cached.expiresAt > now) {
          return cached; // reuse valid URL
        }
      }

      // 🔄 Regenerate if missing or expired
      const playlistResp = await s3.send(
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: obj.Key,
        })
      );

      const playlistText =
        await playlistResp.Body.transformToString("utf-8");

      const lines = playlistText.split("\n");
      const basePath = obj.Key.substring(
        0,
        obj.Key.lastIndexOf("/") + 1
      );

      const updatedLines = await Promise.all(
        lines.map(async (line) => {
          if (line.endsWith(".ts")) {
            return getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: STORAGE_CONFIG.bucketName,
                Key: basePath + line,
              }),
              { expiresIn: THREE_HOURS }
            );
          }
          return line;
        })
      );

      const updatedPlaylist = updatedLines.join("\n");
      const newKey = `secure/${Date.now()}_${obj.Key.split("/").pop()}`;

      // Upload rewritten playlist
      await s3.send(
        new PutObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: newKey,
          Body: updatedPlaylist,
          ContentType: "application/vnd.apple.mpegurl",
        })
      );

      const signedM3u8Url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: newKey,
        }),
        { expiresIn: 3600 }
      );

      // Extract recording time
      let recordingDate = null;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;

        if (line.includes(".ts")) {
          recordingDate = extractRecordingTimeFromKey(
            line.split("?")[0]
          );
          if (recordingDate) break;
        }
      }

      const recordingEpoch = recordingDate ? recordingDate.getTime() : null;

      const payload = {
        key: obj.Key,
        playableUrl: signedM3u8Url,
        lastModified: obj.LastModified,
        size: obj.Size,
        recordingTime: recordingEpoch,
        expiresAt: now + (THREE_HOURS * 1000),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Store in Firestore for reuse
      await docRef.set(payload);

      return payload;
    })
  );
}

exports.fetchAllMixRecordings = async (req, res) => {
  try {
    const { channelName, prefix = "recordings/mix/" } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        error_message: "channelName is required",
      });
    }

    // 1️⃣ Fetch all tracks
    const trackSnap = await db
      .collection("meetings")
      .doc(channelName)
      .collection("recordingTrack")
      .get();

    if (trackSnap.empty) {
      return res.status(404).json({
        success: false,
        error_message: "No recording tracks found",
      });
    }

    const tracks = trackSnap.docs.map((d) => d.data());

    const allResults = [];

    // 3️⃣ Generate / reuse recordings
    const recordings = await getMixRecordingsList({
      channelName,
      prefix,
    });


    // 2️⃣ Loop each track
    for (const track of tracks) {
      const { startTime, stopTime } = track;

      if (!startTime || !stopTime) continue;



      // 4️⃣ Match by track time window
      const matched = recordings.filter(
        (r) =>
          r.recordingTime &&
          r.recordingTime >= startTime &&
          r.recordingTime <= stopTime
      );

      allResults.push(
        ...matched.map((r) => ({
          url: r.playableUrl,
          startTime: startTime
        }))
      );
    }

    if (!allResults.length) {
      return res.status(404).json({
        success: false,
        error_message: "No recordings matched any track",
      });
    }

    res.status(200).json({
      success: true,
      data: allResults,
    });
  } catch (error) {
    console.error("List recordings error:", error);
    res.status(500).json({
      success: false,
      error_message: "Failed to list recordings",
    });
  }
};


exports.getIndividualMixRecording = async (req, res) => {
  try {
    const { channelName, startTime, endTime, type } = req.body;

    // 1️⃣ Validation
    if (!channelName || !startTime || !endTime || !type) {
      return res.status(400).json({
        success: false,
        message: "channelName, startTime, endTime and type are required"
      });
    }

    // 2️⃣ Fetch recordings for this channel
    const recordings = await getMixRecordingsList({ channelName, type });

    if (!recordings.length) {
      return res.status(200).json({
        success: true,
        data: null
      });
    }

    const ONE_MINUTE_MS = 60 * 1000;

    // 3️⃣ Find matching recording by time range
    const matchedRecording = recordings.find(rec => {
      return (
        rec.recordingTime >= (startTime - ONE_MINUTE_MS) &&
        rec.recordingTime <= (endTime + ONE_MINUTE_MS)
      );
    });

    if (!matchedRecording) {
      return res.status(200).json({
        success: true,
        data: null
      });
    }

    // 4️⃣ Return only playableUrl
    return res.status(200).json({
      success: true,
      data: {
        playableUrl: matchedRecording.playableUrl
      }
    });

  } catch (error) {
    console.error("getIndividualMixRecording error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch individual mix recording",
      error: error.message
    });
  }
};