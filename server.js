const express = require("express");
const { google } = require("googleapis");
const dotenv = require("dotenv");
const { Client } = require("@notionhq/client");
const fs = require("fs").promises;
const path = require("path");
const cron = require("node-cron");

dotenv.config();

const app = express();
const port = 3000;

// Add middleware to parse JSON bodies
app.use(express.json());
app.use(express.static("public"));

// Initialize Notion client
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// Token file path
const TOKEN_PATH = path.join(__dirname, "token.json");

// Initialize Google OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  "http://localhost:3000/auth/callback"
);

const SCOPES = [
  "https://www.googleapis.com/auth/fitness.activity.read",
  "https://www.googleapis.com/auth/fitness.location.read",
  "https://www.googleapis.com/auth/fitness.body.read",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
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

// Credentials management functions
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
    dailyData[date].steps =
      bucket.dataset[0]?.point?.[0]?.value?.[0]?.intVal || 0;
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
    dailyData[date].distance = Math.round((distance / 1000) * 100) / 100;
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
    dailyData[date].calories = Math.round(
      bucket.dataset[0]?.point?.[0]?.value?.[0]?.fpVal || 0
    );
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
        activeMinutes += Math.round(duration / (60 * 1000000000));
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
    const startDate = new Date("2025-01-15T00:00:00Z");
    const startTimeMillis = startDate.getTime();

    const dailyData = await fetchFitnessData(startTimeMillis, endTimeMillis);
    console.log("Fetched data:", dailyData);

    for (const [date, data] of Object.entries(dailyData)) {
      await updateNotion(date, data);
    }

    console.log("Sync completed successfully");
    return dailyData;
  } catch (err) {
    console.error("Error during sync:", err);
    throw err;
  }
}

// Schedule syncs
cron.schedule("0 12,15,18,21,0 * * *", async () => {
  console.log("Running scheduled sync...");
  await syncData();
});

cron.schedule("35 5 * * *", async () => {
  console.log("Running sync at 05:35");
  await syncData();
});

// Add authentication routes
app.get("/auth", (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force prompt to ensure we get a refresh token
  });
  res.redirect(authUrl);
});

// API Routes
app.post("/api/sync", async (req, res) => {
  try {
    const data = await syncData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/user", async (req, res) => {
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    res.json({
      name: data.name,
      picture: data.picture,
      email: data.email,
    });
  } catch (error) {
    console.error("Error fetching user profile:", error);
    res.status(500).json({ error: "Failed to fetch user profile" });
  }
});

// Main route serving the dashboard
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Fitness Dashboard</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
          tailwind.config = {
            theme: {
              extend: {
                colors: {
                  background: '#030712',
                  card: '#111827',
                  border: '#1F2937'
                }
              }
            },
            darkMode: 'class'
          }
        </script>
        <style>
          .animate-spin {
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        </style>
    </head>
    <body class="bg-background text-white min-h-screen">
        <div class="container mx-auto px-4 py-8">
            <!-- Header Section -->
            <div class="flex items-center justify-between mb-8">
                <div class="flex items-center space-x-4">
                    <img src="/api/placeholder/64/64" alt="Profile" 
                         class="w-16 h-16 rounded-full border-2 border-border">
                    <div>
                        <h1 class="text-2xl font-bold">Fitness Dashboard</h1>
                        <p class="text-gray-400">Your Daily Progress</p>
                    </div>
                </div>
                <button 
                    id="syncButton"
                    class="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center space-x-2 transition-colors duration-200"
                    onclick="syncData()"
                >
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>Sync Now</span>
                </button>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <!-- Steps Card -->
                <div class="bg-card p-6 rounded-lg border border-border">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="text-gray-400">Steps</h3>
                        <svg class="w-6 h-6 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                  d="M19.057 12.828a7 7 0 00-9.9-9.9l-2.829 2.83a7 7 0 009.9 9.9l2.828-2.83z" />
                        </svg>
                    </div>
                    <div id="stepsCount" class="text-2xl font-bold mb-2">0/10000</div>
                    <div class="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                        <div id="stepsProgress" 
                             class="bg-blue-600 h-2.5 rounded-full transition-all duration-500" 
                             style="width: 0%">
                        </div>
                    </div>
                </div>

                <!-- Distance Card -->
                <div class="bg-card p-6 rounded-lg border border-border">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="text-gray-400">Distance</h3>
                        <svg class="w-6 h-6 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                    </div>
                    <div id="distanceCount" class="text-2xl font-bold mb-2">0/8 km</div>
                    <div class="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                        <div id="distanceProgress" 
                             class="bg-green-600 h-2.5 rounded-full transition-all duration-500" 
style="width: 0%">
                        </div>
                    </div>
                </div>

                <!-- Calories Card -->
                <div class="bg-card p-6 rounded-lg border border-border">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="text-gray-400">Calories</h3>
                        <svg class="w-6 h-6 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                  d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
                        </svg>
                    </div>
                    <div id="caloriesCount" class="text-2xl font-bold mb-2">0/2500 kcal</div>
                    <div class="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                        <div id="caloriesProgress" 
                             class="bg-orange-600 h-2.5 rounded-full transition-all duration-500" 
                             style="width: 0%">
                        </div>
                    </div>
                </div>

                <!-- Active Minutes Card -->
                <div class="bg-card p-6 rounded-lg border border-border">
                    <div class="flex justify-between items-center mb-4">
                        <h3 class="text-gray-400">Active Minutes</h3>
                        <svg class="w-6 h-6 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <div id="activeMinutesCount" class="text-2xl font-bold mb-2">0/60 min</div>
                    <div class="w-full bg-gray-800 rounded-full h-2.5 overflow-hidden">
                        <div id="activeMinutesProgress" 
                             class="bg-purple-600 h-2.5 rounded-full transition-all duration-500" 
                             style="width: 0%">
                        </div>
                    </div>
                </div>
            </div>

            <!-- Activity Timeline -->
            <div class="bg-card p-6 rounded-lg border border-border">
                <h3 class="text-xl font-bold mb-4">Today's Activities</h3>
                <div id="activityTimeline" class="space-y-4">
                    <p class="text-gray-500 text-center py-4">No activities recorded yet today</p>
                </div>
            </div>
        </div>

        <script>
            async function syncData() {
                const syncButton = document.getElementById('syncButton');
                const originalContent = syncButton.innerHTML;
                
                // Update button to loading state
                syncButton.disabled = true;
                syncButton.innerHTML = \`
                    <svg class="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24">
                        <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              fill="none" stroke="currentColor" stroke-width="2" />
                    </svg>
                    Syncing...
                \`;

                try {
                    const response = await fetch('/api/sync', { method: 'POST' });
                    const data = await response.json();
                    
                    // Get today's data
                    const today = new Date().toISOString().split('T')[0];
                    const todayData = data[today] || {
                        steps: 0,
                        distance: 0,
                        calories: 0,
                        activeMinutes: 0
                    };
                    
                    // Update progress bars with animation
                    function updateMetric(id, value, max, unitText) {
                        const percentage = Math.min((value / max) * 100, 100);
                        document.getElementById(\`\${id}Count\`).textContent = \`\${value}/\${max} \${unitText}\`;
                        document.getElementById(\`\${id}Progress\`).style.width = \`\${percentage}%\`;
                    }

                    updateMetric('steps', todayData.steps, 10000, '');
                    updateMetric('distance', todayData.distance, 8, 'km');
                    updateMetric('calories', todayData.calories, 2500, 'kcal');
                    updateMetric('activeMinutes', todayData.activeMinutes, 60, 'min');

                    // Update activity timeline
                    const timeline = document.getElementById('activityTimeline');
                    if (todayData.activeMinutes > 0) {
                        timeline.innerHTML = \`
                            <div class="flex items-center justify-between p-4 bg-gray-800 rounded-lg">
                                <div class="flex items-center space-x-4">
                                    <div class="p-2 bg-blue-500/20 rounded-full">
                                        <svg class="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                                  d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                                        </svg>
                                    </div>
                                    <div>
                                        <p class="font-medium">Active Time</p>
                                        <p class="text-sm text-gray-400">\${todayData.activeMinutes} minutes of activity</p>
                                    </div>
                                </div>
                            </div>
                        \`;
                    }

                } catch (error) {
                    console.error('Sync failed:', error);
                    // Show error state
                    alert('Sync failed. Please try again.');
                } finally {
                    // Restore button state
                    syncButton.disabled = false;
                    syncButton.innerHTML = originalContent;
                }
            }

            // Initial sync on page load
            syncData();
        </script>
    </body>
    </html>
  `);
});

// Start the application
async function startApp() {
  const hasCredentials = await loadSavedCredentials();

  if (hasCredentials) {
    console.log("Loaded saved credentials");

    // Perform initial sync on startup
    await syncData();

    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
    });
  } else {
    console.log(
      "No saved credentials found. Please authenticate at /auth endpoint"
    );

    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log("Please visit /auth to authenticate with Google Fit");
    });
  }
}

startApp();
