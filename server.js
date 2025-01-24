const express = require("express");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs").promises;
const path = require("path");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Token file path
const TOKEN_PATH = path.join(__dirname, "token.json");

// Initialize Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

// Scopes for accessing Google Fit data
const SCOPES = [
  "https://www.googleapis.com/auth/fitness.activity.read",
  "https://www.googleapis.com/auth/fitness.location.read",
  "https://www.googleapis.com/auth/fitness.body.read",
];

// Function to load saved tokens
async function loadSavedCredentials() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    oauth2Client.setCredentials(credentials);
    return true;
  } catch (err) {
    return false;
  }
}

// Function to save tokens
async function saveCredentials(tokens) {
  try {
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
    console.log("Tokens stored to", TOKEN_PATH);
  } catch (err) {
    console.error("Error saving tokens:", err);
  }
}

async function fetchFitnessData(startTimeMillis, endTimeMillis) {
  const fitness = google.fitness({ version: "v1", auth: oauth2Client });

  // Separate requests for each data type to ensure we get all data
  const requests = [
    // Steps request
    fitness.users.dataset.aggregate({
      userId: "me",
      requestBody: {
        aggregateBy: [
          {
            dataTypeName: "com.google.step_count.delta",
            dataSourceId:
              "derived:com.google.step_count.delta:com.google.android.gms:estimated_steps",
          },
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis,
        endTimeMillis,
      },
    }),
    // Distance request
    fitness.users.dataset.aggregate({
      userId: "me",
      requestBody: {
        aggregateBy: [
          {
            dataTypeName: "com.google.distance.delta",
            dataSourceId:
              "derived:com.google.distance.delta:com.google.android.gms:merge_distance_delta",
          },
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis,
        endTimeMillis,
      },
    }),
    // Calories request
    fitness.users.dataset.aggregate({
      userId: "me",
      requestBody: {
        aggregateBy: [
          {
            dataTypeName: "com.google.calories.expended",
            dataSourceId:
              "derived:com.google.calories.expended:com.google.android.gms:merge_calories_expended",
          },
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis,
        endTimeMillis,
      },
    }),
    // Active minutes request
    fitness.users.dataset.aggregate({
      userId: "me",
      requestBody: {
        aggregateBy: [
          {
            dataTypeName: "com.google.activity.segment",
            dataSourceId:
              "derived:com.google.activity.segment:com.google.android.gms:merge_activity_segments",
          },
        ],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis,
        endTimeMillis,
      },
    }),
  ];

  const [
    stepsResponse,
    distanceResponse,
    caloriesResponse,
    activeMinutesResponse,
  ] = await Promise.all(requests);

  // Process and combine the data
  const dailyData = {};

  // Process steps
  stepsResponse.data.bucket.forEach((bucket) => {
    const date = new Date(parseInt(bucket.startTimeMillis))
      .toISOString()
      .split("T")[0];
    if (!dailyData[date])
      dailyData[date] = {
        steps: 0,
        distance: 0,
        calories: 0,
        activeMinutes: 0,
      };

    const steps = bucket.dataset[0]?.point?.[0]?.value?.[0]?.intVal || 0;
    dailyData[date].steps = steps;
  });

  // Process distance
  distanceResponse.data.bucket.forEach((bucket) => {
    const date = new Date(parseInt(bucket.startTimeMillis))
      .toISOString()
      .split("T")[0];
    if (!dailyData[date])
      dailyData[date] = {
        steps: 0,
        distance: 0,
        calories: 0,
        activeMinutes: 0,
      };

    const distance = bucket.dataset[0]?.point?.[0]?.value?.[0]?.fpVal || 0;
    dailyData[date].distance = Math.round((distance / 1000) * 100) / 100; // Convert to km
  });

  // Process calories
  caloriesResponse.data.bucket.forEach((bucket) => {
    const date = new Date(parseInt(bucket.startTimeMillis))
      .toISOString()
      .split("T")[0];
    if (!dailyData[date])
      dailyData[date] = {
        steps: 0,
        distance: 0,
        calories: 0,
        activeMinutes: 0,
      };

    const calories = bucket.dataset[0]?.point?.[0]?.value?.[0]?.fpVal || 0;
    dailyData[date].calories = Math.round(calories);
  });

  // Process active minutes
  activeMinutesResponse.data.bucket.forEach((bucket) => {
    const date = new Date(parseInt(bucket.startTimeMillis))
      .toISOString()
      .split("T")[0];
    if (!dailyData[date])
      dailyData[date] = {
        steps: 0,
        distance: 0,
        calories: 0,
        activeMinutes: 0,
      };

    let activeMinutes = 0;
    bucket.dataset[0]?.point?.forEach((point) => {
      if (
        point.value[0]?.intVal === 72 || // Running
        point.value[0]?.intVal === 7 || // Walking
        point.value[0]?.intVal === 8
      ) {
        // Biking
        const duration =
          parseInt(point.endTimeNanos) - parseInt(point.startTimeNanos);
        activeMinutes += Math.round(duration / (60 * 1000000000)); // Convert nanos to minutes
      }
    });
    dailyData[date].activeMinutes = activeMinutes;
  });

  return dailyData;
}

// Routes
app.get("/api/fitness-data", async (req, res) => {
  try {
    const hasCredentials = await loadSavedCredentials();
    if (!hasCredentials) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const endTimeMillis = Date.now();
    const startTimeMillis = endTimeMillis - 30 * 24 * 60 * 60 * 1000; // Last 30 days

    const dailyData = await fetchFitnessData(startTimeMillis, endTimeMillis);
    res.json(dailyData);
  } catch (error) {
    console.error("Error fetching fitness data:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/auth", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force prompt to ensure we get refresh token
  });
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    await saveCredentials(tokens);
    res.send("Authentication successful!");
  } catch (err) {
    console.error("Error during authentication:", err);
    res.status(500).send("Authentication failed.");
  }
});

// Start the application
async function startApp() {
  const hasCredentials = await loadSavedCredentials();

  if (hasCredentials) {
    console.log("Loaded saved credentials");
  } else {
    console.log(
      "No saved credentials found. Please authenticate at /auth endpoint"
    );
  }

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    if (!hasCredentials) {
      console.log(`Please visit http://localhost:${port}/auth to authenticate`);
    }
  });
}

startApp();
