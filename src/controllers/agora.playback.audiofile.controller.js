const { db } = require('../config/firebase');
const admin = require('firebase-admin');
const { STORAGE_CONFIG } = require('../config/env');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const s3 = new S3Client({
  endpoint: STORAGE_CONFIG.cloudflareEndpoint,
  region: 'auto',
  credentials: {
    accessKeyId: STORAGE_CONFIG.cloudflareAccessKey,
    secretAccessKey: STORAGE_CONFIG.cloudflareSecretKey,
  },
});

const AUDIOFILES_PREFIX = 'audiofiles/';

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
  const ms = ts.length > 14 ? Number(ts.slice(14).padEnd(3, '0')) : 0;
  return new Date(Date.UTC(year, month, day, hour, min, sec, ms));
}

/**
 * List mix recording m3u8 keys for a channel (same source as playback, no signed URLs).
 */
async function getMixRecordingKeys({ channelName, prefix = 'recordings/mix/' }) {
  if (!channelName) throw new Error('channelName is required');

  const data = await s3.send(
    new ListObjectsV2Command({
      Bucket: STORAGE_CONFIG.bucketName,
      Prefix: prefix,
    })
  );

  const files = (data.Contents || []).filter(
    (obj) =>
      obj.Key.includes(channelName) && obj.Key.endsWith('.m3u8')
  );

  return files.map((obj) => ({
    key: obj.Key,
    lastModified: obj.LastModified,
    size: obj.Size,
  }));
}

/**
 * Download m3u8 and all .ts segments from S3 to a temp dir; return paths and recording time.
 */
async function downloadHlsToTemp(s3Key) {
  const basePath = s3Key.substring(0, s3Key.lastIndexOf('/') + 1);
  const playlistResp = await s3.send(
    new GetObjectCommand({
      Bucket: STORAGE_CONFIG.bucketName,
      Key: s3Key,
    })
  );
  const playlistText = await playlistResp.Body.transformToString('utf-8');
  const lines = playlistText.split('\n');

  const tmpDir = path.join(os.tmpdir(), `agora-audio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const m3u8Path = path.join(tmpDir, 'playlist.m3u8');
  const updatedLines = [];
  let recordingDate = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      updatedLines.push(rawLine);
      continue;
    }
    if (line.startsWith('#')) {
      updatedLines.push(rawLine);
      continue;
    }
    if (line.endsWith('.ts')) {
      const segmentKey = basePath + line;
      const segmentResp = await s3.send(
        new GetObjectCommand({
          Bucket: STORAGE_CONFIG.bucketName,
          Key: segmentKey,
        })
      );
      const segmentBuf = await segmentResp.Body.transformToByteArray();
      const segmentFilename = line.split('?')[0];
      const segmentPath = path.join(tmpDir, segmentFilename);
      await fs.writeFile(segmentPath, Buffer.from(segmentBuf));
      updatedLines.push(segmentFilename);
      if (!recordingDate) {
        recordingDate = extractRecordingTimeFromKey(segmentFilename);
      }
      continue;
    }
    updatedLines.push(rawLine);
  }

  await fs.writeFile(m3u8Path, updatedLines.join('\n'), 'utf-8');
  return { tmpDir, m3u8Path, recordingTime: recordingDate ? recordingDate.getTime() : null };
}

/**
 * Convert local HLS (m3u8 + ts) to a single audio file using ffmpeg.
 * Returns path to the output file.
 */
function convertHlsToAudio(m3u8Path, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', m3u8Path,
      '-acodec', 'libmp3lame',
      '-q:a', '2',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Ensure ffmpeg is available.
 */
function checkFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Get or create audio file for a single mix recording (no signed URL).
 * Converts HLS to MP3 and stores in Cloudflare under audiofiles/.
 * Uses Firestore cache to avoid re-converting.
 */
async function getOrCreateAudioFileForRecording({ channelName, recordingKey }) {
  const docId = recordingKey.replace(/\//g, '_');
  const docRef = db
    .collection('meetings')
    .doc(channelName)
    .collection('recordingAudioFiles')
    .doc(docId);

  const snap = await docRef.get();
  if (snap.exists) {
    const cached = snap.data();
    if (cached.audioFileKey) {
      return {
        audioFileKey: cached.audioFileKey,
        recordingTime: cached.recordingTime,
        playablePath: cached.audioFileKey,
      };
    }
  }

  let tmpDir;
  try {
    const { tmpDir: dir, recordingTime } = await downloadHlsToTemp(recordingKey);
    tmpDir = dir;

    const hasFfmpeg = await checkFfmpeg();
    if (!hasFfmpeg) {
      throw new Error('ffmpeg is not installed or not in PATH. Install ffmpeg to convert HLS to audio.');
    }

    const safeName = recordingKey.split('/').pop().replace(/\.m3u8$/, '') || 'recording';
    const outputFileName = `${channelName}_${safeName}_${Date.now()}.mp3`;
    const outputKey = `${AUDIOFILES_PREFIX}${outputFileName}`;
    const outputPath = path.join(tmpDir, 'output.mp3');

    await convertHlsToAudio(path.join(tmpDir, 'playlist.m3u8'), outputPath);
    const audioBuffer = await fs.readFile(outputPath);

    await s3.send(
      new PutObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: outputKey,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
      })
    );

    const payload = {
      key: recordingKey,
      audioFileKey: outputKey,
      recordingTime,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await docRef.set(payload);

    return {
      audioFileKey: outputKey,
      recordingTime,
      playablePath: outputKey,
    };
  } finally {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('Temp cleanup failed:', e.message);
      }
    }
  }
}

/**
 * Fetch all mix recordings as audio files (no signed URLs).
 * Converts each to MP3 and stores under audiofiles/; returns keys/paths for playback.
 */
async function getMixRecordingsAsAudioFiles({ channelName, prefix = 'recordings/mix/' }) {
  const keys = await getMixRecordingKeys({ channelName, prefix });
  if (!keys.length) return [];

  const results = [];
  for (const { key } of keys) {
    const item = await getOrCreateAudioFileForRecording({ channelName, recordingKey: key });
    results.push(item);
  }
  return results;
}

// --- HTTP handlers ---

exports.fetchAllMixRecordingsAsAudioFiles = async (req, res) => {
  try {
    const { channelName, prefix = 'recordings/mix/' } = req.body;

    if (!channelName) {
      return res.status(400).json({
        success: false,
        error_message: 'channelName is required',
      });
    }

    const trackSnap = await db
      .collection('meetings')
      .doc(channelName)
      .collection('recordingTrack')
      .get();

    if (trackSnap.empty) {
      return res.status(404).json({
        success: false,
        error_message: 'No recording tracks found',
      });
    }

    const tracks = trackSnap.docs.map((d) => d.data());
    const recordings = await getMixRecordingsAsAudioFiles({ channelName, prefix });
    const ONE_MINUTE_MS = 60 * 1000;
    const allResults = [];

    for (const track of tracks) {
      const { startTime, stopTime } = track;
      if (!startTime || !stopTime) continue;

      const matched = recordings.filter(
        (r) =>
          r.recordingTime &&
          r.recordingTime >= startTime &&
          r.recordingTime <= stopTime
      );

      allResults.push(
        ...matched.map((r) => ({
          url: r.playablePath,
          audioFileKey: r.audioFileKey,
          startTime,
        }))
      );
    }

    if (!allResults.length) {
      return res.status(404).json({
        success: false,
        error_message: 'No recordings matched any track',
      });
    }

    res.status(200).json({
      success: true,
      data: allResults,
    });
  } catch (error) {
    console.error('fetchAllMixRecordingsAsAudioFiles error:', error);
    res.status(500).json({
      success: false,
      error_message: error.message || 'Failed to list recordings as audio files',
    });
  }
};

exports.getIndividualMixRecordingAsAudioFile = async (req, res) => {
  try {
    const { channelName, startTime, endTime, type } = req.body;

    if (!channelName || !startTime || !endTime || !type) {
      return res.status(400).json({
        success: false,
        message: 'channelName, startTime, endTime and type are required',
      });
    }

    const recordings = await getMixRecordingsAsAudioFiles({ channelName, type });
    if (!recordings.length) {
      return res.status(200).json({ success: true, data: null });
    }

    const ONE_MINUTE_MS = 60 * 1000;
    const matched = recordings.find(
      (rec) =>
        rec.recordingTime >= startTime - ONE_MINUTE_MS &&
        rec.recordingTime <= endTime + ONE_MINUTE_MS
    );

    if (!matched) {
      return res.status(200).json({ success: true, data: null });
    }

    return res.status(200).json({
      success: true,
      data: {
        playablePath: matched.playablePath,
        audioFileKey: matched.audioFileKey,
      },
    });
  } catch (error) {
    console.error('getIndividualMixRecordingAsAudioFile error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch individual mix recording as audio file',
      error: error.message,
    });
  }
};

/**
 * Stream an audio file from audiofiles/ by key (no signed URL exposed to client).
 */
exports.streamAudioFile = async (req, res) => {
  try {
    const key = req.query.key || req.body?.key;
    if (!key || !key.startsWith(AUDIOFILES_PREFIX)) {
      return res.status(400).json({
        success: false,
        error_message: 'Valid key under audiofiles/ is required',
      });
    }

    const response = await s3.send(
      new GetObjectCommand({
        Bucket: STORAGE_CONFIG.bucketName,
        Key: key,
      })
    );

    res.setHeader('Content-Type', response.ContentType || 'audio/mpeg');
    if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength);
    response.Body.pipe(res);
  } catch (error) {
    console.error('streamAudioFile error:', error);
    if (res.headersSent) return;
    res.status(500).json({
      success: false,
      error_message: error.message || 'Failed to stream audio file',
    });
  }
};
