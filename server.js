require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const winston = require('winston');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const path = require('path');
const admin = require('firebase-admin');

// Load Swagger document
const swaggerDocument = YAML.load(path.join(__dirname, 'swagger.yaml'));

// Initialize Express app
const app = express();

// Configure logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  explorer: true,
  customSiteTitle: 'Secured Agora Calling App API Documentation'
}));

//Logger
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    logger.info({
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      ip: req.ip,
    });
  });

  next();
});


// Routes
app.use('/api/auth', require('./src/routes/auth.routes'));
app.use('/api/agora', require('./src/routes/agora.routes'));

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal Server Error'
  });
});


app.post('/agora-webhook', async (req, res) => {
  try {
    const { eventType, errorCode, ...rest } = req.body;
    const timestamp = Date.now();

    const docId = `${timestamp}_${eventType || 'unknown'}`;
    const data = {
      eventType: eventType || null,
      errorCode: errorCode || null,
      eventData: rest || {},
      receivedAt: admin.firestore.Timestamp.fromMillis(timestamp),
      readableTime: new Date(timestamp).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      }),
    };

    // Respond immediately to Agora
    res.status(200).send("OK");
    const db = admin.firestore();
    // Save asynchronously
    db.collection('agora_webhook_error')
      .doc(docId)
      .set(data)
      .then(() => console.log("Webhook event stored:", docId))
      .catch((err) => console.error("Firestore write error:", err));

    // recording started
    if (eventType == 40) {
      logger.info("Recording started event received");
      if (rest.payload.cname) {
        const startTime = rest.payload.notifyMs;
        db.collection("meetings").doc(rest.payload.cname).collection('recordingTrack').doc(startTime.toString()).set({
          "startTime": startTime,
          "mix": true,
        });
      }
    } else if (eventType == 41) {
      logger.info("Recording stopped event received");

      // recording stopped
      if (rest.payload?.cname) {
        const cname = rest.payload.cname;
        const stopTime = rest.payload.notifyMs;

        const trackRef = db
          .collection("meetings")
          .doc(cname)
          .collection("recordingTrack");

        // Find the active recording (no stopTime yet)
        const snap = await trackRef
          .where("stopTime", "==", null)
          .limit(1)
          .get();

        if (!snap.empty) {
          const doc = snap.docs[0];
          const startTime = doc.id; // or doc.data().startTime if you store it

          await trackRef.doc(startTime).update({
            stopTime: stopTime,
            mix: true,
          });

          console.log(`Recording stopped for ${cname}, startTime=${startTime}`);
        } else {
          console.warn(`No active recordingTrack found for ${cname}`);
        }
      }
    }



  } catch (e) {
    logger.error("Webhook processing error:", e);
    res.status(500).send("Internal Server Error");
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  console.log(`Server running on port ${PORT}`);
  console.log(`API Documentation available at http://localhost:${PORT}/api-docs`);
});