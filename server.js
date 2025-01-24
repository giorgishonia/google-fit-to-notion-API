const express = require("express");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const { Client } = require("@notionhq/client");
const fs = require("fs").promises;
const path = require("path");
const cron = require("node-cron");
const WebSocket = require("ws");

dotenv.config();

const app = express();
const port = 3000;

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// Token file path
const TOKEN_PATH = path.join(__dirname, "token.json");

// Initialize Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "https://google-fit-to-notion-api.onrender.com/auth/callback"
);

// Scopes for accessing Google Fit data
const SCOPES = [
  "https://www.googleapis.com/auth/fitness.activity.read",
  "https://www.googleapis.com/auth/fitness.location.read",
  "https://www.googleapis.com/auth/fitness.body.read",
];

// Function to get day name
function getDayName(dateString) {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const date = new Date(dateString);
  return days[date.getDay()];
}

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

async function updateNotion(date, data) {
  try {
    console.log(`Updating Notion for date ${date} with data:`, data);

    const response = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: "Date",
        date: {
          equals: date,
        },
      },
    });

    const dayName = getDayName(date);

    const properties = {
      Day: {
        title: [
          {
            text: {
              content: dayName,
            },
          },
        ],
      },
      Date: { date: { start: date } },
      Steps: { number: parseInt(data.steps) },
      Distance: { number: parseFloat(data.distance) },
      Calories: {
        rich_text: [{ text: { content: String(parseInt(data.calories)) } }],
      },
      "Active Minutes": {
        rich_text: [
          { text: { content: String(parseInt(data.activeMinutes)) } },
        ],
      },
    };

    if (response.results.length > 0) {
      await notion.pages.update({
        page_id: response.results[0].id,
        properties,
      });
      console.log(`Updated existing entry for ${date} (${dayName})`);
    } else {
      await notion.pages.create({
        parent: { database_id: databaseId },
        properties,
      });
      console.log(`Created new entry for ${date} (${dayName})`);
    }
  } catch (err) {
    console.error(`Error updating Notion for date ${date}:`, err);
    throw err;
  }
}

async function syncData() {
  try {
    console.log("Starting sync...");
    const endTimeMillis = Date.now();
    // Set start time to January 15th, 2025
    const startDate = new Date("2025-01-15T00:00:00Z");
    const startTimeMillis = startDate.getTime();

    const dailyData = await fetchFitnessData(startTimeMillis, endTimeMillis);

    console.log("Fetched data:", dailyData);

    for (const [date, data] of Object.entries(dailyData)) {
      await updateNotion(date, data);
    }

    console.log("Sync completed successfully");
  } catch (err) {
    console.error("Error during sync:", err);
  }
}

// WebSocket server for real-time updates
//const wss = new WebSocket.Server({ noServer: true });

// Modify the server creation and WebSocket setup
async function startApp() {
  const hasCredentials = await loadSavedCredentials();

  if (hasCredentials) {
    console.log("Loaded saved credentials");
    await syncData();
    setInterval(syncData, 24 * 60 * 60 * 1000);
  } else {
    console.log(
      "No saved credentials found. Please authenticate at /auth endpoint"
    );
  }

  // Create HTTPS server if SSL certificates are available
  let server;

  if (process.env.NODE_ENV === "production") {
    // For production, let the proxy (like Nginx) handle HTTPS
    server = app.listen(port, () => {
      console.log(
        `Server running at https://google-fit-to-notion-api.onrender.com`
      );
      if (!hasCredentials) {
        console.log(
          `Please visit https://google-fit-to-notion-api.onrender.com/auth to authenticate`
        );
      }
    });
  } else {
    // For local development
    server = app.listen(port, () => {
      console.log(
        `Server running at https://google-fit-to-notion-api.onrender.com`
      );
      if (!hasCredentials) {
        console.log(
          `Please visit https://google-fit-to-notion-api.onrender.com/auth to authenticate`
        );
      }
    });
  }

  // Set up WebSocket server with proper SSL handling
  const wss = new WebSocket.Server({
    server,
    // Add these options for better security
    clientTracking: true,
    perMessageDeflate: {
      zlibDeflateOptions: {
        chunkSize: 1024,
        memLevel: 7,
        level: 3,
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024,
      },
      // Other options
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
    },
  });

  // WebSocket connection handling
  wss.on("connection", (ws, req) => {
    console.log("Client connected from:", req.socket.remoteAddress);

    // Send authentication status immediately upon connection
    sendAuthStatus(ws);

    // Set up ping-pong to keep connection alive
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    // Send countdown timer updates
    const timerInterval = setInterval(() => {
      if (ws.isAlive) {
        sendCountdown(ws);
      }
    }, 1000);

    ws.on("close", () => {
      clearInterval(timerInterval);
      ws.isAlive = false;
      console.log("Client disconnected");
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
      clearInterval(timerInterval);
      ws.isAlive = false;
    });
  });

  // Set up ping interval to check for stale connections
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping(() => {});
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  // Handle server upgrade for WebSocket
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
}

function sendAuthStatus(ws) {
  ws.send(
    JSON.stringify({
      type: "authStatus",
      isAuthenticated: !!oauth2Client.credentials,
    })
  );
}

function sendCountdown(ws) {
  const now = new Date();
  const nextUpdate = new Date(now);
  nextUpdate.setHours(23, 55, 0, 0);
  if (now > nextUpdate) nextUpdate.setDate(nextUpdate.getDate() + 1);

  const timeLeft = nextUpdate.getTime() - now.getTime();
  const hours = Math.floor(timeLeft / (1000 * 60 * 60));
  const minutes = Math.floor((timeLeft % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((timeLeft % (1000 * 60)) / 1000);

  ws.send(
    JSON.stringify({
      type: "countdown",
      timeLeft: `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`,
    })
  );
}

cron.schedule("55 23 * * *", async () => {
  console.log("Scheduled sync started at 11:55 PM...");
  try {
    await syncData();
    console.log("Scheduled sync completed successfully.");
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "syncCompleted" }));
      }
    });
  } catch (err) {
    console.error("Error during scheduled sync:", err);
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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

    // Perform initial sync after authentication
    await syncData();

    res.send(
      "Authentication successful! Initial sync completed. The application will now sync automatically daily."
    );
  } catch (err) {
    console.error("Error during authentication:", err);
    res.status(500).send("Authentication failed.");
  }
});

app.get("/sync", async (req, res) => {
  try {
    await syncData();
    res.send("Manual sync completed successfully");
  } catch (err) {
    console.error("Error during manual sync:", err);
    res.status(500).send("Sync failed.");
  }
});

app.get("/api/fitness-data", async (req, res) => {
  try {
    // Set fixed start time to January 15, 2025
    const startDate = new Date("2025-01-15T00:00:00Z");
    const startTimeMillis = startDate.getTime();

    // Set end time to the current time
    const endTimeMillis = Date.now();

    // Fetch fitness data from January 15, 2025, to now
    const fitnessData = await fetchFitnessData(startTimeMillis, endTimeMillis);

    res.json({
      status: "success",
      message: "Fitness data retrieved successfully",
      data: fitnessData,
    });
  } catch (err) {
    console.error("Error fetching fitness data:", err);
    res.status(500).json({
      status: "error",
      message: "Failed to retrieve fitness data",
      error: err.message,
    });
  }
});

// Start the application
startApp();
