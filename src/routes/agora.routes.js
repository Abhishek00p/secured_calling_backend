const express = require('express');
const router = express.Router();
const agoraController = require('../controllers/agora.controller');
const { verifyToken } = require('../middlewares/auth.middleware');
const { validateAgoraTokenRequest, validateRecordingRequest } = require('../middlewares/validation.middleware');

// Token management
router.post('/token', [validateAgoraTokenRequest], agoraController.generateToken);
router.post('/verify-token', validateAgoraTokenRequest, agoraController.verifyToken);

// Recording management
router.post('/recording/start', [verifyToken, validateRecordingRequest], agoraController.startCloudRecording);
router.post('/recording/stop', [verifyToken, validateRecordingRequest], agoraController.stopCloudRecording);
router.post('/recording/status', [verifyToken, validateRecordingRequest], agoraController.queryRecordingStatus);
router.post('/recording/update', [verifyToken, validateRecordingRequest], agoraController.updateRecording);
router.post('/recording/list/mix', [verifyToken], agoraController.fetchAllMixRecordings);
router.post('/recording/list/individual', [verifyToken], agoraController.getIndividualMixRecording);
router.post('/recording/list/mix/audiofiles', [verifyToken], agoraController.fetchAllMixRecordingsAsAudioFiles);
router.post('/recording/list/individual/audiofile', [verifyToken], agoraController.getIndividualMixRecordingAsAudioFile);
router.get('/recording/audio/stream', [verifyToken], agoraController.streamAudioFile);
router.post('/recording/cleanupSecureFiles', agoraController.cleanupSecureFiles);

module.exports = router;