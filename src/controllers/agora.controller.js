const { RtcTokenBuilder, RtcRole } = require('agora-token');
const axios = require('axios');
const { db } = require('../config/firebase');
const { AGORA_CONFIG, STORAGE_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");


const BASE_URL = `https://api.agora.io/v1/apps/${AGORA_CONFIG.appId}/cloud_recording`;
const AUTH_HEADER = "Basic " + Buffer.from(
  `${AGORA_CONFIG.customerId}:${AGORA_CONFIG.customerCert}`
).toString("base64");

/**
 * Generate Agora Token
 */
exports.generateToken = async (req, res) => {
  try {
    const { channelName, uid, role = 'publisher' } = req.body;

    if (!AGORA_CONFIG.appId || !AGORA_CONFIG.appCertificate) {
      return res.status(500).json({
        success: false,
        error_message: 'Agora credentials not configured'
      });
    }

    // Set token expiration time (1 hour)
    const expirationTimeInSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    // Build token
    const token = RtcTokenBuilder.buildTokenWithUid(
      AGORA_CONFIG.appId,
      AGORA_CONFIG.appCertificate,
      channelName,
      uid,
      role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER,
      privilegeExpiredTs
    );

    // Store token in Firestore
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

    res.status(200).json({
      success: true,
      data: { token }
    });
  } catch (error) {
    logger.error('Generate token error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to generate token'
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

/**
 * Start Cloud Recording
 */
exports.startCloudRecording = async (req, res) => {
  try {
    const { cname, uid, type = 'mix', token } = req.body;

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
      startedAt: new Date().toISOString(),
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
const s3 = new AWS.S3({
  endpoint: STORAGE_CONFIG.cloudflareEndpoint, // your R2 endpoint
  region: 'auto', // R2 uses "auto"
  credentials: {
    accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
    secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey
  }
});

/**
 * List Recordings from R2 filtered by channel name
 */
exports.listRecordings = async (req, res) => {
  try {
    const { channelName, prefix = 'recordings/mix/' } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        error_message: 'channelName is required'
      });
    }

    // List objects from R2 bucket
    const params = {
      Bucket: STORAGE_CONFIG.bucketName, // your bucket name
      Prefix: prefix
    };

    const data = await s3.listObjectsV2(params).promise();
    const files = (data.Contents || [])
      .filter(obj => obj.Key.includes(channelName))
    // Filter objects containing the channel name
    const filteredObjects = files
      .map(obj => {
        const signedUrl = s3.getSignedUrl('getObject', {
          Bucket: STORAGE_CONFIG.bucketName,  // e.g. "agora-recordings"
          Key: obj.Key,
          Expires: 3600,
        });

        return {
          key: obj.Key,
          lastModified: obj.LastModified,
          size: obj.Size,
          url: signedUrl
        }
      });

    // Log query to Firestore
    await db.collection('agora_recording_queries').add({
      channelName,
      prefix,
      response: filteredObjects,
      createdAt: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      data: filteredObjects
    });

  } catch (error) {
    logger.error('List recordings error:', error);
    res.status(500).json({
      success: false,
      error_message: 'Failed to list recordings'
    });
  }
};