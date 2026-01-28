const { db } = require('../config/firebase');
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

/**
 * Get individual mix recordings with speaking events
 * POST /api/recordings/individual-mix
 */
// exports.getIndividualMixRecording = async (req, res) => {
//   try {
//     const { channelName } = req.body;

//     // 1️⃣ Validation
//     if (!channelName) {
//       return res.status(400).json({
//         success: false,
//         message: "channelName is required"
//       });
//     }

//     // 2️⃣ Fetch recordings
//     const recordings = await getMixRecordingsList({ channelName });
//     if (!recordings.length) {
//       return res.status(200).json({
//         success: true,
//         data: []
//       });
//     }

//     // 3️⃣ Fetch recording tracks from Firestore
//     const allRecordingTrack = await getRecordingTracks(channelName);

//     const usersList = [];

//     // 4️⃣ Core mapping logic
//     for (const track of allRecordingTrack) {
//       const matchedRecording = recordings.find(rec => {
//         console.log(`recording time ${rec.recordingTime}, trackStart : ${track.startTime}, trackEnd: ${track.stopTime}`);
//         const ONE_MINUTE_MS = 60 * 1000;
//         return rec.recordingTime >= (track.startTime - ONE_MINUTE_MS) &&
//           rec.recordingTime <= track.stopTime + ONE_MINUTE_MS;
//       }
//       );

//       console.log("recording match ? ", matchedRecording);

//       if (!matchedRecording) continue;

//       const { playableUrl } = matchedRecording;
//       console.log("speaking events total length", track);
//       const enrichedSpeakingEvents = (track.speakingEvents || []).map(event => ({
//         ...event,
//         recordingUrl: playableUrl,
//         trackStartTime: track.startTime,
//         trackStopTime: track.stopTime
//       }));
//       console.log("enrichedSpeakingEvents length", enrichedSpeakingEvents.length);
//       usersList.push({
//         trackId: Number.isInteger(Number(track.id)) ? Number(track.id) : null,
//         recordingUrl: playableUrl,
//         speakingEvents: enrichedSpeakingEvents
//       });
//     }

//     // 5️⃣ Success response
//     return res.status(200).json({
//       success: true,
//       data: usersList
//     });

//   } catch (error) {
//     console.error("getIndividualMixRecording error:", error);

//     return res.status(500).json({
//       success: false,
//       message: "Failed to fetch individual mix recordings",
//       error: error.message
//     });
//   }
// };

// exports.listIndividualRecordings = async (req, res) => {
//   try {
//     const { channelName } = req.body;

//     if (!channelName) {
//       return res.status(400).json({
//         success: false,
//         error_message: "channelName is required"
//       });
//     }

//     const prefix = `recordings/individual/`;

//     // Fetch all objects under individual recordings
//     const listResp = await s3.send(new ListObjectsV2Command({
//       Bucket: STORAGE_CONFIG.bucketName,
//       Prefix: prefix,
//     }));

//     const allFiles = listResp.Contents || [];

//     // Filter only .m3u8 files containing channelName
//     const playlistFiles = allFiles.filter(obj =>
//       obj.Key.includes(channelName) && obj.Key.endsWith(".m3u8")
//     );

//     if (playlistFiles.length === 0) {
//       return res.status(404).json({
//         success: false,
//         error_message: "No individual .m3u8 found for this channel"
//       });
//     }

//     const userIds = new Set();
//     playlistFiles.forEach(file => {
//       const fileName = file.Key.split("/").pop();
//       const match = fileName.match(/__uid_s_(.*?)__uid_e/);
//       if (match) userIds.add(match[1]);
//     });
//     const userMap = {};


//     await Promise.all(
//       Array.from(userIds).map(async (uid) => {
//         try {
//           const snap = await db.collection("users").doc(uid).get();
//           if (snap.exists) {
//             userMap[uid] = snap.data()?.username || snap.data()?.name || "Unknown";
//           } else {
//             userMap[uid] = "Unknown";
//           }
//         } catch (e) {
//           userMap[uid] = "Unknown";
//         }
//       })
//     );
//     const results = await Promise.all(
//       playlistFiles.map(async (file) => {

//         const fileName = file.Key.split("/").pop(); // just the name

//         // Extract UID using naming pattern
//         const match = fileName.match(/__uid_s_(.*?)__uid_e/);
//         const userId = match ? match[1] : "unknown";

//         // Get playlist content
//         const playlistResp = await s3.send(new GetObjectCommand({
//           Bucket: STORAGE_CONFIG.bucketName,
//           Key: file.Key
//         }));

//         const playlistData =
//           await playlistResp.Body.transformToString("utf-8");

//         const lines = playlistData.split("\n");
//         // ⭐ extract recording time from FIRST .ts segment
//         let recordingDate = null;

//         for (const rawLine of lines) {
//           const line = rawLine.trim();

//           // skip comments / empty lines
//           if (!line || line.startsWith('#')) continue;

//           // allow .ts or .ts?query
//           if (line.includes('.ts')) {
//             recordingDate = extractRecordingTimeFromKey(
//               line.split('?')[0]
//             );
//             if (recordingDate) break;
//           }
//         }

//         const basePath = file.Key.replace(fileName, "");

//         // Convert TS file names → signed URLs
//         const rewritten = await Promise.all(
//           lines.map(async (line) => {
//             if (line.endsWith(".ts")) {
//               const segKey = basePath + line;
//               return await getSignedUrl(
//                 s3,
//                 new GetObjectCommand({
//                   Bucket: STORAGE_CONFIG.bucketName,
//                   Key: segKey
//                 }),
//                 { expiresIn: 3600 }
//               );
//             }
//             return line;
//           })
//         );

//         const finalPlaylist = rewritten.join("\n");
//         const secureKey = `secure/${Date.now()}_${fileName}`;

//         // Upload secure playlist
//         await s3.send(new PutObjectCommand({
//           Bucket: STORAGE_CONFIG.bucketName,
//           Key: secureKey,
//           Body: finalPlaylist,
//           ContentType: "application/vnd.apple.mpegurl"
//         }));

//         const signedPlaylistUrl = await getSignedUrl(
//           s3,
//           new GetObjectCommand({
//             Bucket: STORAGE_CONFIG.bucketName,
//             Key: secureKey,
//           }),
//           { expiresIn: 3600 }
//         );

//         return {
//           userId: userId,
//           username: userMap[userId] || "Unknown",
//           playlistKey: file.Key,
//           playableUrl: signedPlaylistUrl,
//           lastModified: file.LastModified,
//           size: file.Size,
//           recordingTime: recordingDate
//             ? recordingDate.toISOString()
//             : null, // ⭐ NEW FIELD
//         };
//       })
//     );

//     res.status(200).json({
//       success: true,
//       channelName,
//       data: results
//     });

//   } catch (e) {
//     console.error("Individual recordings error:", e);
//     res.status(500).json({
//       success: false,
//       error_message: "Failed to fetch individual recordings"
//     });
//   }
// };

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
                 │    ├── source: "agora-volume"

*/
// exports.getRecordingsByUserId = async (req, res) => {
//   try {
//     const { meetingId, userId } = req.body;

//     if (!meetingId || !userId) {
//       return res.status(400).json({
//         success: false,
//         error_message: "meetingId and userId are required",
//       });
//     }


//     // 1️⃣ Fetch speaking events from Firestore
//     const eventsSnap = await db
//       .collection("meetings")
//       .doc(meetingId)
//       .collection("participants")
//       .doc(userId)
//       .collection("speakingEvents")
//       .orderBy("start", "asc")
//       .get();

//     if (eventsSnap.empty) {
//       return res.status(200).json({
//         success: true,
//         userId,
//         segments: [],
//       });
//     }

//     const speakingEvents = eventsSnap.docs.map(doc => {
//       const data = doc.data();
//       return {
//         startEpoch: toEpochMs(data.start),
//         endEpoch: toEpochMs(data.end),
//       };
//     });

//     // 2️⃣ Fetch user's audio playlists (same logic as before)
//     const prefix = `recordings/individual/`;

//     const listResp = await s3.send(
//       new ListObjectsV2Command({
//         Bucket: STORAGE_CONFIG.bucketName,
//         Prefix: prefix,
//       })
//     );

//     const allFiles = listResp.Contents || [];

//     const userPlaylists = allFiles.filter(obj =>
//       obj.Key.includes(meetingId) &&
//       obj.Key.includes(`__uid_s_${userId}__uid_e`) &&
//       obj.Key.endsWith(".m3u8")
//     );

//     if (userPlaylists.length === 0) {
//       return res.status(404).json({
//         success: false,
//         error_message: "No audio recordings found for user",
//       });
//     }

//     // 3️⃣ Process each playlist
//     const results = [];

//     for (const file of userPlaylists) {
//       const fileName = file.Key.split("/").pop();
//       const basePath = file.Key.replace(fileName, "");

//       // Extract playlist recording start time (epoch)
//       const tsStartMatch = fileName.match(/__ts_s_(\d+)/);
//       if (!tsStartMatch) continue;

//       const playlistStartEpoch = Number(tsStartMatch[1]) * 1000;

//       // Read playlist
//       const playlistResp = await s3.send(
//         new GetObjectCommand({
//           Bucket: STORAGE_CONFIG.bucketName,
//           Key: file.Key,
//         })
//       );

//       const playlistData =
//         await playlistResp.Body.transformToString("utf-8");

//       const lines = playlistData.split("\n");

//       // Replace TS with signed URLs
//       const rewritten = await Promise.all(
//         lines.map(async (line) => {
//           if (line.endsWith(".ts")) {
//             const segKey = basePath + line;
//             return await getSignedUrl(
//               s3,
//               new GetObjectCommand({
//                 Bucket: STORAGE_CONFIG.bucketName,
//                 Key: segKey,
//               }),
//               { expiresIn: 3600 }
//             );
//           }
//           return line;
//         })
//       );

//       const finalPlaylist = rewritten.join("\n");

//       const secureKey = `secure/${Date.now()}_${fileName}`;

//       await s3.send(
//         new PutObjectCommand({
//           Bucket: STORAGE_CONFIG.bucketName,
//           Key: secureKey,
//           Body: finalPlaylist,
//           ContentType: "application/vnd.apple.mpegurl",
//         })
//       );

//       const signedPlaylistUrl = await getSignedUrl(
//         s3,
//         new GetObjectCommand({
//           Bucket: STORAGE_CONFIG.bucketName,
//           Key: secureKey,
//         }),
//         { expiresIn: 3600 }
//       );

//       // 4️⃣ Map speaking events to this playlist
//       for (const event of speakingEvents) {
//         if (
//           event.startEpoch >= playlistStartEpoch &&
//           event.endEpoch > playlistStartEpoch
//         ) {
//           const seekFromSeconds =
//             Math.floor((event.startEpoch - playlistStartEpoch) / 1000);

//           results.push({
//             userId,
//             startEpoch: event.startEpoch,
//             endEpoch: event.endEpoch,
//             timeRange: `${new Date(event.startEpoch).toLocaleTimeString()} - ${new Date(event.endEpoch).toLocaleTimeString()}`,
//             playableUrl: signedPlaylistUrl,
//             seekFromSeconds,
//           });
//         }
//       }
//     }

//     // 5️⃣ Sort by time
//     results.sort((a, b) => a.startEpoch - b.startEpoch);

//     res.status(200).json({
//       success: true,
//       meetingId,
//       userId,
//       segments: results,
//     });

//   } catch (err) {
//     console.error("User speaking timeline error:", err);
//     res.status(500).json({
//       success: false,
//       error_message: "Failed to build user speaking timeline",
//     });
//   }
// };

