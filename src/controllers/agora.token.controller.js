const { RtcTokenBuilder, RtcRole } = require('agora-token');
const { db } = require('../config/firebase');
const { AGORA_CONFIG } = require('../config/env');
const { logger } = require('../middlewares/logging.middleware');

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

    if (!channelName || !uid) {
      return res.status(400).json({
        success: false,
        error_message: 'channelName and uid are required'
      });
    }

    const meetingDoc = await db
      .collection('meetings')
      .doc(channelName)
      .get();

    if (!meetingDoc.exists) {
      return res.status(404).json({
        success: false,
        error_message: 'Meeting not found'
      });
    }

    const meetingData = meetingDoc.data();

    if (!meetingData.tokens) {
      return res.status(400).json({
        success: false,
        error_message: 'No tokens found for this meeting'
      });
    }

    const userTokenData = meetingData.tokens[String(uid)];

    if (!userTokenData) {
      return res.status(401).json({
        success: false,
        error_message: 'No token for this user'
      });
    }

    const { expiry_time, token } = userTokenData;

    if (!expiry_time || !token) {
      return res.status(400).json({
        success: false,
        error_message: 'Invalid token data'
      });
    }

    if (Date.now() > Number(expiry_time)) {
      return res.status(401).json({
        success: false,
        error_message: 'Agora Token expired'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        token
      }
    });
  } catch (error) {
    logger.error('Verify token error:', error);
    return res.status(500).json({
      success: false,
      error_message: 'Failed to verify token'
    });
  }
};

// Unused helper functions preserved to avoid any behavioral changes
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

exports.createAgoraToken = createAgoraToken;

