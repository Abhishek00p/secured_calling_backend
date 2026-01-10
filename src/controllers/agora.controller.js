const { RtcTokenBuilder, RtcRole } = require('agora-token');
const axios = require('axios');
const { db } = require('../config/firebase');
const { AGORA_CONFIG, STORAGE_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");


const BASE_URL = `https://api.agora.io/v1/apps/${AGORA_CONFIG.appId}/cloud_recording`;
const AUTH_HEADER = "Basic " + Buffer.from(
  `${AGORA_CONFIG.customerId}:${AGORA_CONFIG.customerCert}`
).toString("base64");

const MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours


async function createAgoraToken({ channelName, uid, role = 'publisher' }) {
  if (!AGORA_CONFIG.appId || !AGORA_CONFIG.appCertificate) {
    throw new Error('Agora credentials not configured');
  }

  const expirationTimeInSeconds = 3600;
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  const token = RtcTokenBuilder.buildTokenWithUid(
    AGORA_CONFIG.appId,
    AGORA_CONFIG.appCertificate,
    channelName,
    uid,
    role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
    privilegeExpiredTs
  );

  await db.collection('meetings').doc(channelName).update({
    [`tokens.${uid}`]: {
      token,
      uid,
      role,
      expiry_time: privilegeExpiredTs,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(privilegeExpiredTs * 1000).toISOString()
    }
  });

  return {
    token,
    expiry: privilegeExpiredTs
  };
}

/**
 * Generate Agora Token
 */
exports.generateToken = async (req, res) => {
  try {
    const { channelName, uid, role } = req.body;

    const result = await createAgoraToken({ channelName, uid, role });

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Generate token error:', error);

    res.status(500).json({
      success: false,
      error_message: error.message || 'Failed to generate token'
    });
  }
};


/**
 * Verify Agora Token
 */
exports.verifyToken = async (req, res) => {
  try {
    const { channelName, uid } = req.body;

    const meetingDoc = await db.collection('meetings')
      .doc(channelName)
      .get();

    if (!meetingDoc.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'Meeting not found'
      });
    }

    const meetingData = meetingDoc.data();
    const expiresAt = new Date(meetingData.expiresAt);

    if (expiresAt < new Date()) {
      return res.status(401).json({
        success: false,
        error_message: 'Token expired'
      });
    }

    if (meetingData.uid !== uid) {
      return res.status(401).json({
        success: false,
        error_message: 'Invalid user ID'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        token: meetingData.token,
        role: meetingData.role
      }
    });
  } catch (error) {
    logger.error('Verify token error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to verify token'
    });
  }
};

/**
 * Helper function to generate document ID for recordings
 */
const getDocId = (cname, type) => `${cname}_${type}`;

function generate7DigitId() {
  return Math.floor(1000000 + Math.random() * 9000000); // 1000000 to 9999999
}
async function generateUniqueUserId() {
  let uniqueId;
  let docExists = true;

  while (docExists) {
    uniqueId = generate7DigitId();
    const docRef = db.collection('users').doc(uniqueId.toString());
    const docSnap = await docRef.get();
    docExists = docSnap.exists; // true if ID already exists
  }

  return uniqueId;
}
/**
 * Start Cloud Recording
 */
exports.startCloudRecording = async (req, res) => {
  try {
    const { cname, type = 'mix' } = req.body;

    const uid = type === 'mix' ? 9999999 : 9999998;
    const { token } = await createAgoraToken({ channelName: cname, uid, role: 'subscriber' });
    // Acquire recording resource
    const acquireResponse = await axios.post(
      `${BASE_URL}/acquire`,
      {
        cname,
        uid: uid.toString(),
        clientRequest: { resourceExpiredHour: 24 }
      },
      { headers: { Authorization: AUTH_HEADER }, validateStatus: (status) => true }
    );
    if (acquireResponse.status >= 400) {
      logger.error(`Failed to get credential for starting recording : ${acquireResponse.status}, ${acquireResponse.data}`);
      return res.status(acquireResponse.status).json({
        success: false,
        error_message: acquireResponse.data.toString()
      });
    }
    const resourceId = acquireResponse.data.resourceId;
    logger.info(`this is acquire response : ${JSON.stringify(acquireResponse.data, null, 2)} `);
    // fetch meeting data
    const participantsSnapshot = await db
      .collection("meetings")
      .doc(cname.toString())
      .collection("participants")
      .get();

    const participantIds = participantsSnapshot.docs.map(doc => doc.id.toString());

    //storage config
    const storageConfig = {
      vendor: 11,
      region: 0,
      bucket: STORAGE_CONFIG.bucketName,
      accessKey: STORAGE_CONFIG.cloudflareAccessKey,
      secretKey: STORAGE_CONFIG.cloudflareSecretKey,
      fileNamePrefix: ["recordings", type],
      extensionParams: {
        "endpoint": "https://684d7d3ceda1fe3533f104f1cf8197c7.r2.cloudflarestorage.com"
      }
    };
    const recordingConfig = type === "mix"
      ? {
        channelType: 1,
        streamTypes: 0,
        audioProfile: 1, // ✅ valid in mix
        maxIdleTime: 160,
      }
      : {
        channelType: 1,
        streamTypes: 0,
        subscribeUidGroup: 0,
        maxIdleTime: 160, // ✅ simpler config for individual

      };
    // Start recording
    const startResponse = await axios.post(
      `${BASE_URL}/resourceid/${resourceId}/mode/${type}/start`,
      {
        cname,
        uid: uid.toString(),
        clientRequest: {
          token: token,
          recordingConfig: recordingConfig,
          streamSubscribe: {
            audioUidList: {
              subscribeAudioUids: ["#allstream#"]
            }
          },
          storageConfig,
        },
      },
      {
        headers: { Authorization: AUTH_HEADER }, validateStatus: (status) => true
      }
    );
    if (startResponse.status >= 400) {
      let parsed = null;

      // Try to parse Agora error JSON safely
      try {
        parsed = typeof startResponse.data === "string"
          ? JSON.parse(startResponse.data)
          : startResponse.data;
      } catch (e) {
        parsed = { raw: startResponse.data };
      }
      // Extract useful info if available
      const errorDetails = {
        cname: parsed?.cname || null,
        uid: parsed?.uid || null,
        code: parsed?.code || null,
        reason: parsed?.reason || "Unknown error",
        raw: parsed
      };

      logger.error(`Failed to start recording: ${startResponse.status} - ${errorDetails.reason}`);
      return res.status(startResponse.status).json({
        success: false,
        error_message: errorDetails.reason
      });
    }
    // Store recording info in Firestore
    await db.collection('recordings').doc(getDocId(cname, type)).set({
      cname,
      type,
      resourceId,
      sid: startResponse.data.sid,
      recorderUid: uid,
      status: 'started',
      startedAt: Date.now(),
      startResponse: startResponse.data
    });

    res.status(200).json({
      success: true,
      data: startResponse.data
    });
  } catch (error) {
    logger.error(`Start recording error: ${error}`);

    res.status(500).json({
      success: false,
      error_message: 'Failed to start recording'
    });
  }
};

/**
 * Stop Cloud Recording
 */
exports.stopCloudRecording = async (req, res) => {
  try {
    const { cname, type } = req.body;

    const docRef = db.collection('recordings').doc(getDocId(cname, type));
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'No active recording found'
      });
    }

    const data = docSnap.data();
    if (data.status === 'stopped') {
      return res.status(400).json({
        success: false,
        error_message: 'Recording already stopped'
      });
    }

    const { resourceId, sid, recorderUid } = data;

    // Stop recording
    const stopResponse = await axios.post(
      `${BASE_URL}/resourceid/${resourceId}/sid/${sid}/mode/${type}/stop`,
      {
        cname,
        uid: recorderUid.toString(),
        clientRequest: {}
      },
      {
        headers: { Authorization: AUTH_HEADER }, validateStatus: (status) => true
      }
    );
    if (stopResponse.status >= 400) {
      let parsed = null;

      // Try to parse Agora error JSON safely
      try {
        parsed = typeof stopResponse.data === "string"
          ? JSON.parse(stopResponse.data)
          : stopResponse.data;
      } catch (e) {
        parsed = { raw: stopResponse.data };
      }


      logger.error(`Failed to stop recording: ${stopResponse.status} - ${JSON.stringify(parsed)}`);
      return res.status(stopResponse.status).json({
        success: false,
        error_message: JSON.stringify(parsed)
      });
    }
    // Update Firestore
    await docRef.update({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stopResponse: stopResponse.data
    });

    res.status(200).json({
      success: true,
      data: stopResponse.data
    });
  } catch (error) {
    logger.error('Stop recording error:', error);
    if (error.response?.status === 404) {
      return res.status(200).json({
        success: true,
        message: 'Recording was not active or already stopped'
      });
    }
    res.status(500).json({
      success: false,
      error_message: 'Failed to stop recording'
    });
  }
};

/**
 * Query Cloud Recording Status
 */
exports.queryRecordingStatus = async (req, res) => {
  try {
    const { cname, type } = req.body;

    const docRef = db.collection('recordings').doc(getDocId(cname, type));
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'Recording not found'
      });
    }

    const data = docSnap.data();
    const { resourceId, sid } = data;

    const response = await axios.get(
      `${BASE_URL}/resourceid/${resourceId}/sid/${sid}/mode/${type}/query`,
      {
        headers: { Authorization: AUTH_HEADER },

        validateStatus: (status) => true
      },
    );

    if (response.status >= 400) {
      let parsed = null;

      // Try to parse Agora error JSON safely
      try {
        parsed = typeof response.data === "string"
          ? JSON.parse(response.data)
          : response.data;
      } catch (e) {
        parsed = { raw: response.data };
      }


      logger.error(`Failed to get status of  recording: ${response.status} - ${JSON.stringify(parsed)}`);
      return res.status(response.status).json({
        success: false,
        error_message: JSON.stringify(parsed)
      });
    }
    // Update status in Firestore
    await docRef.update({
      queryResponse: response.data,
      lastQueried: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      data: response.data
    });
  } catch (error) {
    logger.error('Query recording status error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to query recording status'
    });
  }
};

/**
 * Update Recording
 */

exports.updateRecording = async (req, res) => {
  try {
    const { cname, type, uid, audioSubscribeUids = [] } = req.body;

    const docRef = db.collection('recordings').doc(getDocId(cname, type));
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'No active recording found'
      });
    }

    const data = docSnap.data();
    if (data.status === 'stopped') {
      return res.status(400).json({
        success: false,
        error_message: 'Recording already stopped'
      });
    }

    const { resourceId, sid } = data;

    const response = await axios.post(
      `${BASE_URL}/resourceid/${resourceId}/sid/${sid}/mode/${type}/update`,
      {
        cname,
        uid: uid.toString(),
        clientRequest: {
          streamSubscribe: {
            audioUidList: {
              subscribeAudioUids: audioSubscribeUids.length > 0 ? audioSubscribeUids : ['#allstream#']
            }
          }
        }
      },
      { headers: { Authorization: AUTH_HEADER } }
    );

    // Log update to Firestore
    await db.collection('agora_recording_updates').add({
      cname,
      type,
      request: {
        audioSubscribeUids
      },
      response: response.data,
      createdAt: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      data: response.data
    });
  } catch (error) {
    logger.error('Update recording error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to update recording'
    });
  }
};
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

  // 1. List objects
  const data = await s3.send(
    new ListObjectsV2Command({
      Bucket: STORAGE_CONFIG.bucketName,
      Prefix: prefix,
    })
  );

  // 2. Filter m3u8 files
  const files = (data.Contents || []).filter(
    (obj) =>
      obj.Key.includes(channelName) &&
      obj.Key.endsWith(".m3u8")
  );

  if (!files.length) {
    return [];
  }

  // 3. Process playlists
  return Promise.all(
    files.map(async (obj) => {
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
              { expiresIn: 3600 }
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

      return {
        key: obj.Key,
        playableUrl: signedM3u8Url,
        lastModified: obj.LastModified,
        size: obj.Size,
        recordingTime: recordingEpoch,
      };
    })
  );
}

exports.listMixRecordings = async (req, res) => {
  try {
    const { channelName, prefix = "recordings/mix/" } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        error_message: "channelName is required",
      });
    }

    const recordings = await getMixRecordingsList({
      channelName,
      prefix,
    });

    if (!recordings.length) {
      return res.status(404).json({
        success: false,
        error_message: "No .m3u8 playlist found for the channel",
      });
    }

    res.status(200).json({
      success: true,
      data: recordings,
    });
  } catch (error) {
    console.error("List recordings error:", error);

    res.status(500).json({
      success: false,
      error_message: "Failed to list recordings",
    });
  }
};
async function getRecordingTracks(meetingId) {
  try {
    const snapshot = await db
      .collection("meetings")
      .doc(meetingId)
      .collection("recordingTrack")
      .get();

    const tracks = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const trackData = { id: doc.id, ...doc.data() };

        const eventsSnap = await db
          .collection("meetings")
          .doc(meetingId)
          .collection("recordingTrack")
          .doc(doc.id)
          .collection("speakingEvents")
          .get();

        const speakingEvents = eventsSnap.docs.map(e => ({
          id: e.id,
          ...e.data()
        }));

        return {
          ...trackData,
          speakingEvents,
        };
      })
    );

    return tracks;
  } catch (error) {
    console.error("Error fetching recordingTrack with speakingEvents:", error);
    return [];
  }
}

function findRecordingForTrack(track, recordings) {
  return recordings.find(rec =>
    rec.recordingTime >= track.startTime &&
    rec.recordingTime <= track.xstopTime
  );
}
/**
 * Get individual mix recordings with speaking events
 * POST /api/recordings/individual-mix
 */
exports.getIndividualMixRecording = async (req, res) => {
  try {
    const { channelName } = req.body;

    // 1️⃣ Validation
    if (!channelName) {
      return res.status(400).json({
        success: false,
        message: "channelName is required"
      });
    }

    // 2️⃣ Fetch recordings
    const recordings = await getMixRecordingsList({ channelName });
    if (!recordings.length) {
      return res.status(200).json({
        success: true,
        data: []
      });
    }

    // 3️⃣ Fetch recording tracks from Firestore
    const allRecordingTrack = await getRecordingTracks(channelName);

    const usersList = [];

    // 4️⃣ Core mapping logic
    for (const track of allRecordingTrack) {
      const matchedRecording = recordings.find(rec => {
        console.log(`recording time ${rec.recordingTime}, trackStart : ${track.startTime}, trackEnd: ${track.stopTime}`);
        const ONE_MINUTE_MS = 60 * 1000;
        return rec.recordingTime >= (track.startTime - ONE_MINUTE_MS) &&
          rec.recordingTime <= track.stopTime;
      }
      );

      console.log("recording match ? ", matchedRecording);

      if (!matchedRecording) continue;

      const { playableUrl } = matchedRecording;
      console.log("speaking events total length", track);
      const enrichedSpeakingEvents = (track.speakingEvents || []).map(event => ({
        ...event,
        recordingUrl: playableUrl,
        trackStartTime: track.startTime,
        trackStopTime: track.stopTime
      }));
      console.log("enrichedSpeakingEvents length", enrichedSpeakingEvents.length);
      usersList.push({
        trackId: Number.isInteger(Number(track.id)) ? Number(track.id) : null,
        recordingUrl: playableUrl,
        speakingEvents: enrichedSpeakingEvents
      });
    }

    // 5️⃣ Success response
    return res.status(200).json({
      success: true,
      data: usersList
    });

  } catch (error) {
    console.error("getIndividualMixRecording error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch individual mix recordings",
      error: error.message
    });
  }
};



exports.listIndividualRecordings = async (req, res) => {
  try {
    const { channelName } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        error_message: "channelName is required"
      });
    }

    const prefix = `recordings/individual/`;

    // Fetch all objects under individual recordings
    const listResp = await s3.send(new ListObjectsV2Command({
      Bucket: STORAGE_CONFIG.bucketName,
      Prefix: prefix,
    }));

    const allFiles = listResp.Contents || [];

    // Filter only .m3u8 files containing channelName
    const playlistFiles = allFiles.filter(obj =>
      obj.Key.includes(channelName) && obj.Key.endsWith(".m3u8")
    );

    if (playlistFiles.length === 0) {
      return res.status(404).json({
        success: false,
        error_message: "No individual .m3u8 found for this channel"
      });
    }

    const userIds = new Set();
    playlistFiles.forEach(file => {
      const fileName = file.Key.split("/").pop();
      const match = fileName.match(/__uid_s_(.*?)__uid_e/);
      if (match) userIds.add(match[1]);
    });
    const userMap = {};


    await Promise.all(
      Array.from(userIds).map(async (uid) => {
        try {
          const snap = await db.collection("users").doc(uid).get();
          if (snap.exists) {
            userMap[uid] = snap.data()?.username || snap.data()?.name || "Unknown";
          } else {
            userMap[uid] = "Unknown";
          }
        } catch (e) {
          userMap[uid] = "Unknown";
        }
      })
    );
    const results = await Promise.all(
      playlistFiles.map(async (file) => {

        const fileName = file.Key.split("/").pop(); // just the name

        // Extract UID using naming pattern
        const match = fileName.match(/__uid_s_(.*?)__uid_e/);
        const userId = match ? match[1] : "unknown";

        // Get playlist content
        const playlistResp = await s3.send(new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: file.Key
        }));

        const playlistData =
          await playlistResp.Body.transformToString("utf-8");

        const lines = playlistData.split("\n");
        // ⭐ extract recording time from FIRST .ts segment
        let recordingDate = null;

        for (const rawLine of lines) {
          const line = rawLine.trim();

          // skip comments / empty lines
          if (!line || line.startsWith('#')) continue;

          // allow .ts or .ts?query
          if (line.includes('.ts')) {
            recordingDate = extractRecordingTimeFromKey(
              line.split('?')[0]
            );
            if (recordingDate) break;
          }
        }

        const basePath = file.Key.replace(fileName, "");

        // Convert TS file names → signed URLs
        const rewritten = await Promise.all(
          lines.map(async (line) => {
            if (line.endsWith(".ts")) {
              const segKey = basePath + line;
              return await getSignedUrl(
                s3,
                new GetObjectCommand({
                  Bucket: STORAGE_CONFIG.bucketName,
                  Key: segKey
                }),
                { expiresIn: 3600 }
              );
            }
            return line;
          })
        );

        const finalPlaylist = rewritten.join("\n");
        const secureKey = `secure/${Date.now()}_${fileName}`;

        // Upload secure playlist
        await s3.send(new PutObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: secureKey,
          Body: finalPlaylist,
          ContentType: "application/vnd.apple.mpegurl"
        }));

        const signedPlaylistUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: STORAGE_CONFIG.bucketName,
            Key: secureKey,
          }),
          { expiresIn: 3600 }
        );

        return {
          userId: userId,
          username: userMap[userId] || "Unknown",
          playlistKey: file.Key,
          playableUrl: signedPlaylistUrl,
          lastModified: file.LastModified,
          size: file.Size,
          recordingTime: recordingDate
            ? recordingDate.toISOString()
            : null, // ⭐ NEW FIELD
        };
      })
    );

    res.status(200).json({
      success: true,
      channelName,
      data: results
    });

  } catch (e) {
    console.error("Individual recordings error:", e);
    res.status(500).json({
      success: false,
      error_message: "Failed to fetch individual recordings"
    });
  }
};


const toEpochMs = (ts) => {
  if (!ts) return null;
  return ts.seconds * 1000 + Math.floor(ts.nanoseconds / 1e6);
};
/*
meetings
 └── meetingId
     └── participants
         └── userId
             ├── uid: "23"
             ├── joinedAt: timestamp
             └── speakingEvents
                 ├── autoId1
                 │    ├── start: Timestamp
                 │    ├── end: Timestamp
                 │    ├── source: "agora-volume"
                 ├── autoId2
                 │    ├── start: Timestamp
                 │    ├── end: Timestamp

*/
exports.getRecordingsByUserId = async (req, res) => {
  try {
    const { meetingId, userId } = req.body;

    if (!meetingId || !userId) {
      return res.status(400).json({
        success: false,
        error_message: "meetingId and userId are required",
      });
    }


    // 1️⃣ Fetch speaking events from Firestore
    const eventsSnap = await db
      .collection("meetings")
      .doc(meetingId)
      .collection("participants")
      .doc(userId)
      .collection("speakingEvents")
      .orderBy("start", "asc")
      .get();

    if (eventsSnap.empty) {
      return res.status(200).json({
        success: true,
        userId,
        segments: [],
      });
    }

    const speakingEvents = eventsSnap.docs.map(doc => {
      const data = doc.data();
      return {
        startEpoch: toEpochMs(data.start),
        endEpoch: toEpochMs(data.end),
      };
    });

    // 2️⃣ Fetch user's audio playlists (same logic as before)
    const prefix = `recordings/individual/`;

    const listResp = await s3.send(
      new ListObjectsV2Command({
        Bucket: STORAGE_CONFIG.bucketName,
        Prefix: prefix,
      })
    );

    const allFiles = listResp.Contents || [];

    const userPlaylists = allFiles.filter(obj =>
      obj.Key.includes(meetingId) &&
      obj.Key.includes(`__uid_s_${userId}__uid_e`) &&
      obj.Key.endsWith(".m3u8")
    );

    if (userPlaylists.length === 0) {
      return res.status(404).json({
        success: false,
        error_message: "No audio recordings found for user",
      });
    }

    // 3️⃣ Process each playlist
    const results = [];

    for (const file of userPlaylists) {
      const fileName = file.Key.split("/").pop();
      const basePath = file.Key.replace(fileName, "");

      // Extract playlist recording start time (epoch)
      const tsStartMatch = fileName.match(/__ts_s_(\d+)/);
      if (!tsStartMatch) continue;

      const playlistStartEpoch = Number(tsStartMatch[1]) * 1000;

      // Read playlist
      const playlistResp = await s3.send(
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: file.Key,
        })
      );

      const playlistData =
        await playlistResp.Body.transformToString("utf-8");

      const lines = playlistData.split("\n");

      // Replace TS with signed URLs
      const rewritten = await Promise.all(
        lines.map(async (line) => {
          if (line.endsWith(".ts")) {
            const segKey = basePath + line;
            return await getSignedUrl(
              s3,
              new GetObjectCommand({
                Bucket: STORAGE_CONFIG.bucketName,
                Key: segKey,
              }),
              { expiresIn: 3600 }
            );
          }
          return line;
        })
      );

      const finalPlaylist = rewritten.join("\n");

      const secureKey = `secure/${Date.now()}_${fileName}`;

      await s3.send(
        new PutObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: secureKey,
          Body: finalPlaylist,
          ContentType: "application/vnd.apple.mpegurl",
        })
      );

      const signedPlaylistUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: secureKey,
        }),
        { expiresIn: 3600 }
      );

      // 4️⃣ Map speaking events to this playlist
      for (const event of speakingEvents) {
        if (
          event.startEpoch >= playlistStartEpoch &&
          event.endEpoch > playlistStartEpoch
        ) {
          const seekFromSeconds =
            Math.floor((event.startEpoch - playlistStartEpoch) / 1000);

          results.push({
            userId,
            startEpoch: event.startEpoch,
            endEpoch: event.endEpoch,
            timeRange: `${new Date(event.startEpoch).toLocaleTimeString()} - ${new Date(event.endEpoch).toLocaleTimeString()}`,
            playableUrl: signedPlaylistUrl,
            seekFromSeconds,
          });
        }
      }
    }

    // 5️⃣ Sort by time
    results.sort((a, b) => a.startEpoch - b.startEpoch);

    res.status(200).json({
      success: true,
      meetingId,
      userId,
      segments: results,
    });

  } catch (err) {
    console.error("User speaking timeline error:", err);
    res.status(500).json({
      success: false,
      error_message: "Failed to build user speaking timeline",
    });
  }
};

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

async function stopAgoraRecordingInternal({ cname, type, resourceId, sid, recorderUid }) {
  const stopResponse = await axios.post(
    `${BASE_URL}/resourceid/${resourceId}/sid/${sid}/mode/${type}/stop`,
    {
      cname,
      uid: recorderUid.toString(),
      clientRequest: {}
    },
    { headers: { Authorization: AUTH_HEADER } }
  );

  return stopResponse.data;
}
exports.autoStopExpiredMeetingsRecordings = async () => {
  const now = Date.now();

  const snapshot = await db
    .collection('recordings')
    .where('status', '==', 'started')
    .get();

  for (const doc of snapshot.docs) {
    const recording = doc.data();

    try {
      const meetingSnap = await db
        .collection('meetings')
        .doc(recording.cname.toString())
        .get();

      if (!meetingSnap.exists) continue;

      const meeting = meetingSnap.data();

      const scheduledEnd = new Date(meeting.scheduledEndTime).getTime();
      const actualEnd = meeting.actualEndTime
        ? new Date(meeting.actualEndTime).getTime()
        : null;

      const meetingEnded =
        meeting.status === 'ended' ||
        actualEnd !== null ||
        scheduledEnd < now;

      if (!meetingEnded) continue;

      // 🔥 STOP Agora recording
      await stopAgoraRecordingInternal({
        cname: recording.cname,
        type: recording.type,
        resourceId: recording.resourceId,
        sid: recording.sid,
        recorderUid: recording.recorderUid
      });
      const stopReason = "MEETING_ENDED"
      if (now - recording.startedAt > MAX_DURATION_MS) {
        stopReason = 'MAX_DURATION_EXCEEDED'
      }

      // 🔥 Update Firestore
      await doc.ref.update({
        status: 'auto_stopped',
        stoppedAt: now,
        stopReason: stopReason || 'MEETING_ENDED'
      });

      console.log(`Auto-stopped recording for meeting ${recording.cname}`);
    } catch (err) {
      console.error(`Auto-stop failed for ${recording.cname}`, err.message);
    }
  }
};
