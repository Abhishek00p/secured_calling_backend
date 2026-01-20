const axios = require('axios');
const { db } = require('../config/firebase');
const { AGORA_CONFIG, STORAGE_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');
const { createAgoraToken } = require('./agora.token.controller');

const BASE_URL = `https://api.agora.io/v1/apps/${AGORA_CONFIG.appId}/cloud_recording`;
const AUTH_HEADER = "Basic " + Buffer.from(
  `${AGORA_CONFIG.customerId}:${AGORA_CONFIG.customerCert}`
).toString("base64");

const MAX_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * Helper function to generate document ID for recordings
 */
const getDocId = (cname, type) => `${cname}_${type}`;

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

