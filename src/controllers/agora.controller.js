const tokenController = require('./agora.token.controller');
const cloudRecordingController = require('./agora.cloudRecording.controller');
const playbackController = require('./agora.playback.controller');
const maintenanceController = require('./agora.maintenance.controller');

module.exports = {
  // Token management
  generateToken: tokenController.generateToken,
  verifyToken: tokenController.verifyToken,

  // Recording management
  startCloudRecording: cloudRecordingController.startCloudRecording,
  stopCloudRecording: cloudRecordingController.stopCloudRecording,
  queryRecordingStatus: cloudRecordingController.queryRecordingStatus,
  updateRecording: cloudRecordingController.updateRecording,
  autoStopExpiredMeetingsRecordings: cloudRecordingController.autoStopExpiredMeetingsRecordings,

  // Listing / playback
  fetchAllMixRecordings: playbackController.fetchAllMixRecordings,
  getIndividualMixRecording: playbackController.getIndividualMixRecording,

  // Maintenance
  cleanupSecureFiles: maintenanceController.cleanupSecureFiles,
};

