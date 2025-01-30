// Add these imports at the top of your file
const { initializeApp } = require("firebase/app");
const {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  getDocs,
} = require("firebase/firestore");

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDaRHpvux-OrHxq6ovjGHQuCQxtcjeUJfc",
  authDomain: "fitsync-4d5cb.firebaseapp.com",
  projectId: "fitsync-4d5cb",
  storageBucket: "fitsync-4d5cb.firebasestorage.app",
  messagingSenderId: "388040657143",
  appId: "1:388040657143:web:f6c2dd4c3209c6f570ebf2",
  measurementId: "G-RYTRL5DMEX",
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Function to save fitness data to Firestore
async function saveFitnessDataToFirestore(date, data) {
  try {
    const docRef = doc(db, "fitnessData", date);
    await setDoc(docRef, {
      ...data,
      date: date, // Ensure date field exists in document
      timestamp: new Date().toISOString(),
    });
    console.log(`Saved fitness data for ${date} to Firestore`);
  } catch (error) {
    console.error("Error saving to Firestore:", error);
    throw error;
  }
}

// Function to fetch fitness data from Firestore
async function getFitnessDataFromFirestore(date) {
  try {
    const docRef = doc(db, "fitnessData", date);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return docSnap.data();
    } else {
      return null;
    }
  } catch (error) {
    console.error("Error fetching from Firestore:", error);
    throw error;
  }
}

async function getFitnessDataRange(startDate, endDate) {
  try {
    const fitnessRef = collection(db, "fitnessData");
    const q = query(
      fitnessRef,
      where("date", ">=", startDate), // Changed from "timestamp" to "date"
      where("date", "<=", endDate) // Changed from "timestamp" to "date"
    );

    const querySnapshot = await getDocs(q);
    const data = {};
    querySnapshot.forEach((doc) => {
      data[doc.id] = doc.data();
    });
    return data;
  } catch (error) {
    console.error("Error fetching date range from Firestore:", error);
    throw error;
  }
}

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
  "https://google-fit-to-notion-api.onrender.com/auth/callback"
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
    const date = new Date(Number.parseInt(bucket.startTimeMillis))
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
    const date = new Date(Number.parseInt(bucket.startTimeMillis))
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
    const date = new Date(Number.parseInt(bucket.startTimeMillis))
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
    const date = new Date(Number.parseInt(bucket.startTimeMillis))
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
          Number.parseInt(point.endTimeNanos) -
          Number.parseInt(point.startTimeNanos);
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
      Steps: { number: Number.parseInt(data.steps) },
      Distance: { number: Number.parseFloat(data.distance) },
      Calories: {
        rich_text: [
          { text: { content: String(Number.parseInt(data.calories)) } },
        ],
      },
      "Active Minutes": {
        rich_text: [
          { text: { content: String(Number.parseInt(data.activeMinutes)) } },
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

async function syncData(isManualSync = false) {
  try {
    if (isManualSync) {
      console.log("Starting manual sync...");
    }

    const endTimeMillis = Date.now();
    const startDate = new Date("2025-01-15T00:00:00Z");
    const startTimeMillis = startDate.getTime();

    const dailyData = await fetchFitnessData(startTimeMillis, endTimeMillis);

    if (isManualSync) {
      console.log("Fetched data:", dailyData);
    }

    // Save data to both Notion and Firestore
    for (const [date, data] of Object.entries(dailyData)) {
      // Save to Notion
      await updateNotion(date, data);

      // Save to Firestore
      await saveFitnessDataToFirestore(date, data);
    }

    if (isManualSync) {
      console.log("Manual sync completed successfully");
    }
    return dailyData;
  } catch (err) {
    console.error("Error during sync:", err);
    throw err;
  }
}

// Update fetchLatestData function to use Firestore
async function fetchLatestData() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const data = await getFitnessDataFromFirestore(today);
    return data || {};
  } catch (error) {
    console.error("Error fetching latest data:", error);
    return {};
  }
}
// Modified scheduled syncs
cron.schedule("0 12,15,18,21,0 * * *", async () => {
  console.log("Running scheduled sync...");
  await syncData(false);
});

cron.schedule("35 5 * * *", async () => {
  console.log("Running scheduled sync at 05:35");
  await syncData(false);
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

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.redirect("/?error=missing_code");
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    await saveCredentials(tokens);
    res.redirect("/"); // Redirect to home page after successful auth
  } catch (error) {
    console.error("Error getting tokens:", error);
    res.redirect("/?error=auth_failed");
  }
});

// API Routes
app.post("/api/sync", async (req, res) => {
  try {
    const data = await syncData(true); // Pass true for manual sync
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

app.get("/api/latest-data", async (req, res) => {
  try {
    const latestData = await fetchLatestData();
    res.json(latestData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this function near other utility functions
async function checkAuthStatus() {
  try {
    const credentials = await loadSavedCredentials();
    return !!credentials;
  } catch (error) {
    return false;
  }
}

app.get("/", async (req, res) => {
  try {
    const isAuthenticated = await checkAuthStatus();
    const fitnessData = isAuthenticated
      ? await getAllFitnessDataFromFirestore()
      : {};

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
             .datepicker-style::-webkit-calendar-picker-indicator {
        filter: invert(0.8);
        cursor: pointer;
        padding-left: 100%;
        opacity: 0;
        position: absolute;
        right: 0;
        width: 100%;
        height: 100%;
    }

    .datepicker-style::-webkit-datetime-edit {
        color: #f3f4f6;
        padding: 0.25rem;
        text-align: center;
        width: 100%;
    }

    .datepicker-style::-webkit-datetime-edit-fields-wrapper {
        padding: 0.25rem;
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .datepicker-style::-webkit-datetime-edit-text {
        color: #9ca3af;
        padding: 0 0.25rem;
    }

    .datepicker-style::-webkit-inner-spin-button {
        display: none;
    }

    .datepicker-style::-webkit-search-cancel-button {
        display: none;
    }

    @supports (-moz-appearance: none) {
        .datepicker-style {
            color-scheme: dark;
            text-align: center;
        }
    }
        </style>
    </head>
    
    <body class="bg-background text-white min-h-screen">
        <div class="container mx-auto px-4 py-8">
            <!-- Auth Status Section -->
            <div class="hidden flex justify-end mb-4">
                ${
                  isAuthenticated
                    ? `
                    <button 
                        onclick="handleLogout()"
                        class=" px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors duration-200"
                    >
                        Log Out
                    </button>
                `
                    : `
                    <button 
                        onclick="window.location.href='/auth'"
                        class="hidden px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors duration-200"
                    >
                        Log In with Google Fit
                    </button>
                `
                }
            </div>

            ${
              isAuthenticated
                ? `
                <div class="flex justify-between items-center mb-8">
                    <div class="flex items-center space-x-4">
                        <img src="logo.png" alt="Logo" class="w-20  h-20 rounded-full border-2 border-border">
                        <div>
                            <h1 class="text-2xl font-bold">FitSync</h1>
                            <p class="mt-2 text-gray-400">Your Fitness Dashboard</p>
                        </div>
                    </div>

                    <!-- User Profile Dropdown -->
                    <div class="relative" id="userProfileContainer">
                        <button 
                            onclick="toggleDropdown()"
                            class="flex items-center space-x-4 px-6 py-3 rounded-lg hover:bg-gray-800 transition-colors duration-200"
                        >
                            <img id="userProfilePic" src="" alt="Profile" class="w-10 h-10 rounded-full">
                            <span id="userName" class="font-medium text-lg"></span>
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
                            </svg>
                        </button>
                        
                        <div id="profileDropdown" class="hidden absolute right-0 mt-2 w-56 bg-card rounded-lg shadow-lg border border-border z-50">
                            <a href="/profile" class="block px-6 py-3 text-base hover:bg-gray-800 rounded-t-lg">
                                Profile
                            </a>
                            <button 
                                onclick="handleLogout()"
                                class="w-full text-left px-6 py-3 text-base text-red-400 hover:bg-gray-800 rounded-b-lg"
                            >
                                Log Out
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Date Selector and Sync Button -->
                <div class="flex items-center justify-end space-x-4 mb-8">
                    <input type="date" id="dateSelector" class="bg-card text-white px-4 py-2 rounded-lg">
                    <div class="flex gap-2 sm:gap-4">
                        <a href="/calendot"
                            class="flex-1 h-[56px] sm:flex-none px-4 py-2.5 text-sm font-medium bg-indigo-950 hover:bg-indigo-900 text-indigo-100 rounded-lg 
                            border border-indigo-900 hover:border-indigo-800
                            shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_-1px_0_0_rgba(255,255,255,0.05)_inset]
                            hover:shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset,0_-1px_0_0_rgba(255,255,255,0.1)_inset]
                            transition-all duration-200 flex items-center justify-center space-x-2 group">
                            <svg class="w-4 h-4 text-gray-400 group-hover:text-gray-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                            </svg>
                            <span class="hidden sm:inline">Calendar</span>
                        </a>
                        
                        <button id="syncButton"
                            class="flex-1 sm:flex-none px-4 py-2.5 text-sm font-medium bg-indigo-950 hover:bg-indigo-900 text-indigo-100 rounded-lg 
                            border border-indigo-900 hover:border-indigo-800
                            shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset,0_-1px_0_0_rgba(255,255,255,0.05)_inset]
                            hover:shadow-[0_1px_0_0_rgba(255,255,255,0.1)_inset,0_-1px_0_0_rgba(255,255,255,0.1)_inset]
                            transition-all duration-200 flex items-center justify-center space-x-2 group"
                            onclick="syncData()">
                            <svg class="w-4 h-4 text-indigo-400 group-hover:text-indigo-300 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                            </svg>
                            <span class="hidden sm:inline">Sync Now</span>
                        </button>
                    </div>
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
                <div class="bg-card p-6 rounded-lg border border-border mb-8">
                    <h3 class="text-xl font-bold mb-4">Selected Day's Activities</h3>
                    <div id="activityTimeline" class="space-y-4">
                        <p class="text-gray-500 text-center py-4">No activities recorded for the selected day</p>
                    </div>
                </div>

                <!-- All Days Data -->
                <div class="bg-card p-6 rounded-lg border border-border">
                    <h3 class="text-xl font-bold mb-4">All Days Data</h3>
                    <div id="allDaysData" class="space-y-4">
                        <!-- Data for all days will be populated here -->
                    </div>
                </div>
            `
                : `
                <!-- Auth Required Message -->
                <div class="flex flex-col items-center justify-center min-h-[60vh] text-center">
                    <svg class="w-16 h-16 text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                    </svg>
                    <h2 class="text-2xl font-bold mb-2">Authentication Required</h2>
                    <p class="text-gray-400 mb-4">Please log in with Google Fit to view your fitness data</p>
                    <button 
                        onclick="window.location.href='/auth'"
                        class="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors duration-200"
                    >
                        Log In with Google Fit
                    </button>
                </div>
            `
            }
        </div>

        <script>
            let allData = ${JSON.stringify(fitnessData)};

            function updateDashboard() {
                const selectedDate = document.getElementById('dateSelector').value;
                const selectedData = allData[selectedDate] || {
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

                updateMetric('steps', selectedData.steps, 10000, '');
                updateMetric('distance', selectedData.distance, 8, 'km');
                updateMetric('calories', selectedData.calories, 2500, 'kcal');
                updateMetric('activeMinutes', selectedData.activeMinutes, 60, 'min');

                // Update activity timeline
                const timeline = document.getElementById('activityTimeline');
                if (selectedData.activeMinutes > 0) {
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
                                    <p class="text-sm text-gray-400">\${selectedData.activeMinutes} minutes of activity</p>
                                </div>
                            </div>
                        </div>
                    \`;
                } else {
                    timeline.innerHTML = '<p class="text-gray-500 text-center py-4">No activities recorded for the selected day</p>';
                }
            }

          function populateAllDaysData() {
    const allDaysDataContainer = document.getElementById('allDaysData');
    allDaysDataContainer.innerHTML = '';

    Object.entries(allData).forEach(([date, data]) => {
        const dayElement = document.createElement('div');
        dayElement.className = 'bg-gray-900/80 p-5 rounded-xl shadow-md backdrop-blur-md border border-gray-700 transition-all hover:scale-[1.02]';

        dayElement.innerHTML = '<h4 class="text-lg font-semibold text-white mb-2">' + date + '</h4>' +
            '<div class="space-y-1 text-gray-300 text-sm">' +
            '<p>🚶‍♂️ Steps: <span class="font-medium">' + data.steps + '</span></p>' +
            '<p>📏 Distance: <span class="font-medium">' + data.distance + ' km</span></p>' +
            '<p>🔥 Calories: <span class="font-medium">' + data.calories + ' kcal</span></p>' +
            '<p>⏳ Active Minutes: <span class="font-medium">' + data.activeMinutes + ' min</span></p>' +
            '</div>';

        allDaysDataContainer.appendChild(dayElement);
    });
}

// Initialize date selector with today's date
document.addEventListener('DOMContentLoaded', () => {
    const dateSelector = document.getElementById('dateSelector');
    const today = new Date().toISOString().split('T')[0];
    dateSelector.value = today;
    
    // Set the className for the dateSelector
    dateSelector.className = \`
        w-full sm:w-48
        bg-gray-900/80
        text-gray-100
        backdrop-blur-sm
        rounded-lg
        border border-gray-700
        focus:border-blue-500
        focus:ring-2 focus:ring-blue-500/30
        transition-all
        duration-200
        px-3 py-2
        text-sm
        shadow-sm
        hover:border-gray-600
        placeholder-gray-500
        appearance-none
        datepicker-style
    \`;

  const dateWrapper = document.createElement('div');
    dateWrapper.className = 'relative inline-block w-full sm:w-auto';
    dateSelector.parentNode.insertBefore(dateWrapper, dateSelector);
    dateWrapper.appendChild(dateSelector);
    
    const calendarIcon = document.createElement('svg');
    calendarIcon.className = 'absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none';
    calendarIcon.setAttribute('fill', 'none');
    calendarIcon.setAttribute('stroke', 'currentColor');
    calendarIcon.setAttribute('viewBox', '0 0 24 24');
    calendarIcon.innerHTML = \`
        <path 
            stroke-linecap="round" 
            stroke-linejoin="round" 
            stroke-width="2" 
            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
    \`;
    dateWrapper.appendChild(calendarIcon);

    dateSelector.addEventListener('change', updateDashboard);
    updateDashboard();
    populateAllDaysData();
});

async function syncData() {
    const syncButton = document.getElementById('syncButton');
    const originalContent = syncButton.innerHTML;

    // Update button to loading state
    syncButton.disabled = true;
    syncButton.innerHTML = '<div class="flex items-center justify-center space-x-2">' +
        '<svg class="animate-spin w-5 h-5 text-indigo-500" viewBox="0 0 24 24">' +
        '<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>' +
        '<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0116 0"></path>' +
        '</svg>' +
        '<span>Syncing...</span>' +
        '</div>';

    try {
        const response = await fetch('/api/sync', { method: 'POST' });
        allData = await response.json();
        
        updateDashboard();
        populateAllDaysData();
    } catch (error) {
        console.error('Sync failed:', error);
        alert('Sync failed. Please try again.');
    } finally {
        // Restore button state
        syncButton.disabled = false;
        syncButton.innerHTML = originalContent;
    }
}

            async function handleLogout() {
                if (confirm('Are you sure you want to log out?')) {
                    try {
                        const response = await fetch('/auth/logout', { method: 'POST' });
                        if (response.ok) {
                            window.location.href = '/';
                        } else {
                            throw new Error('Logout failed');
                        }
                    } catch (error) {
                        console.error('Logout error:', error);
                        alert('Failed to log out. Please try again.');
                    }
                }
            }

            // Add these functions to your existing JavaScript
            async function loadUserProfile() {
                try {
                    const response = await fetch('/api/user');
                    if (response.ok) {
                        const userData = await response.json();
                        document.getElementById('userProfilePic').src = userData.picture || 'default-avatar.png';
                        document.getElementById('userName').textContent = userData.name || 'User';
                    }
                } catch (error) {
                    console.error('Error loading user profile:', error);
                }
            }

            function toggleDropdown() {
                const dropdown = document.getElementById('profileDropdown');
                dropdown.classList.toggle('hidden');
            }

            // Close dropdown when clicking outside
            document.addEventListener('click', (event) => {
                const container = document.getElementById('userProfileContainer');
                const dropdown = document.getElementById('profileDropdown');
                
                if (container && !container.contains(event.target)) {
                    dropdown.classList.add('hidden');
                }
            });

            // Load user profile on page load
            if (document.getElementById('userProfileContainer')) {
                loadUserProfile();
            }
        </script>
    </body>
    </html>
  `);
  } catch (error) {
    console.error("Error loading dashboard:", error);
    res.status(500).send("Error loading dashboard");
  }
});

// Add logout endpoint
app.post("/auth/logout", async (req, res) => {
  try {
    // Clear the token file
    await fs.unlink(TOKEN_PATH).catch(() => {});
    res.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({ error: "Failed to logout" });
  }
});

async function getAllFitnessDataFromFirestore() {
  try {
    const fitnessRef = collection(db, "fitnessData");
    const querySnapshot = await getDocs(fitnessRef);
    const data = {};
    querySnapshot.forEach((doc) => {
      data[doc.id] = doc.data();
    });
    return data;
  } catch (error) {
    console.error("Error fetching all data from Firestore:", error);
    throw error;
  }
}

async function startApp() {
  const hasCredentials = await loadSavedCredentials();

  if (hasCredentials) {
    console.log("Loaded saved credentials");
    // Remove the initial sync on startup

    app.listen(port, () => {
      console.log(
        `Server running at https://google-fit-to-notion-api.onrender.com`
      );
    });
  } else {
    console.log(
      "No saved credentials found. Please authenticate at /auth endpoint"
    );

    app.listen(port, () => {
      console.log(
        `Server running at https://google-fit-to-notion-api.onrender.com`
      );
      console.log("Please visit /auth to authenticate with Google Fit");
    });
  }
}

startApp();

// Add this new route
app.get("/profile", async (req, res) => {
  const isAuthenticated = await checkAuthStatus();
  if (!isAuthenticated) {
    return res.redirect("/");
  }

  try {
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>User Profile - Fitness Dashboard</title>
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
            </head>
            <body class="bg-background text-white min-h-screen">
                <div class="container mx-auto px-4 py-8">
                    <div class="max-w-2xl mx-auto">
                        <a href="/" class="inline-flex items-center space-x-2 text-gray-400 hover:text-white mb-8">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
                            </svg>
                            <span>Back to Dashboard</span>
                        </a>

                        <div class="bg-card rounded-lg border border-border p-8">
                            <div class="flex items-center space-x-6 mb-6">
                                <img src="${data.picture}" alt="Profile" class="w-24 h-24 rounded-full border-4 border-border">
                                <div>
                                    <h1 class="text-2xl font-bold">${data.name}</h1>
                                    <p class="text-gray-400">${data.email}</p>
                                </div>
                            </div>

                            <div class="border-t border-border pt-6">
                                <h2 class="text-xl font-semibold mb-4">Account Information</h2>
                                <div class="space-y-4">
                                    <div>
                                        <label class="text-gray-400 block mb-1">Name</label>
                                        <p class="font-medium">${data.name}</p>
                                    </div>
                                    <div>
                                        <label class="text-gray-400 block mb-1">Email</label>
                                        <p class="font-medium">${data.email}</p>
                                    </div>
                                </div>
                            </div>

                            <div class="mt-8">
                                <button 
                                    onclick="handleLogout()"
                                    class="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors duration-200"
                                >
                                    Log Out
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <script>
                    async function handleLogout() {
                        if (confirm('Are you sure you want to log out?')) {
                            try {
                                const response = await fetch('/auth/logout', { method: 'POST' });
                                if (response.ok) {
                                    window.location.href = '/';
                                } else {
                                    throw new Error('Logout failed');
                                }
                            } catch (error) {
                                console.error('Logout error:', error);
                                alert('Failed to log out. Please try again.');
                            }
                        }
                    }
                </script>
            </body>
            </html>
        `);
  } catch (error) {
    console.error("Error loading profile:", error);
    res.status(500).send("Error loading profile");
  }
});

app.get("/calendot", async (req, res) => {
  try {
    const isAuthenticated = await checkAuthStatus();
    if (!isAuthenticated) {
      return res.redirect("/");
    }

    const currentDate = new Date();
    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();

    // Generate array of remaining months in the year
    const monthsToDisplay = [];
    for (let month = currentMonth; month < 12; month++) {
      monthsToDisplay.push({
        year: currentYear,
        month: month,
        startDate: new Date(currentYear, month, 1),
        endDate: new Date(currentYear, month + 1, 0),
      });
    }

    // Fetch data for all remaining months
    const monthsData = await Promise.all(
      monthsToDisplay.map(async (m) => {
        const data = await getFitnessDataRange(
          m.startDate.toISOString().split("T")[0],
          m.endDate.toISOString().split("T")[0]
        );
        return { ...m, data };
      })
    );

    // Helper function to generate calendar grid
    function generateCalendarGrid(data, year, month) {
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const firstDayOfMonth = new Date(year, month, 1).getDay();
      let html = "";

      // Empty cells for days before the first day of the month
      for (let i = 0; i < firstDayOfMonth; i++) {
        html += "<div></div>";
      }

      // Generate cells for each day of the month
      for (let day = 1; day <= daysInMonth; day++) {
        const dateString = `${year}-${String(month + 1).padStart(
          2,
          "0"
        )}-${String(day).padStart(2, "0")}`;
        const dayData = data[dateString] || {
          steps: 0,
          distance: 0,
          calories: 0,
          activeMinutes: 0,
        };
        const isToday =
          new Date(year, month, day).toDateString() ===
          new Date().toDateString();

        // Calculate completion percentage for color intensity
        const stepGoal = 10000;
        const completion =
          Math.floor(((dayData.steps / stepGoal) * 100) / 10) * 10;
        const bgColor =
          dayData.steps > 0
            ? `bg-cyan-500/${Math.max(10, Math.min(completion, 100))}`
            : "bg-gray-800";
        const borderColor = isToday ? "border-2 border-cyan-500" : "";

        html += `
          <div class="relative group">
            <div class="h-24 ${bgColor} ${borderColor} rounded-lg p-2 transition-all duration-200 hover:scale-105 hover:shadow-lg hover:z-10">
              <div class="flex flex-col h-full">
                <span class="text-sm ${
                  isToday ? "text-cyan-500 font-bold" : "text-gray-300"
                }">${day}</span>
                ${
                  dayData.steps
                    ? `
                  <div class="mt-auto">
                    <div class="text-xs text-gray-300">Steps</div>
                    <div class="text-sm font-medium">${dayData.steps.toLocaleString()}</div>
                  </div>
                `
                    : ""
                }
              </div>
            </div>

            ${
              dayData.steps
                ? `
              <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 transform scale-95 group-hover:scale-100 z-50">
                <div class="bg-gray-800 rounded-lg shadow-xl p-4 border border-gray-700">
                  <div class="text-center mb-2 font-medium text-cyan-500">${dateString}</div>
                  <div class="space-y-2">
                    <div class="flex justify-between items-center">
                      <span class="text-gray-400">🚶‍♂️ Steps</span>
                      <span class="font-medium">${dayData.steps.toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span class="text-gray-400">📏 Distance</span>
                      <span class="font-medium">${dayData.distance.toFixed(
                        2
                      )} km</span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span class="text-gray-400">🔥 Calories</span>
                      <span class="font-medium">${dayData.calories.toLocaleString()}</span>
                    </div>
                    <div class="flex justify-between items-center">
                      <span class="text-gray-400">⏳ Active</span>
                      <span class="font-medium">${
                        dayData.activeMinutes
                      } min</span>
                    </div>
                  </div>
                  <div class="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-full">
                    <div class="w-3 h-3 bg-gray-800 border-r border-b border-gray-700 transform rotate-45"></div>
                  </div>
                </div>
              </div>
            `
                : ""
            }
          </div>
        `;
      }

      return html;
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Fitness Calendar</title>
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
            }
          }

          function toggleInfo() {
            const infoContainer = document.getElementById('infoContainer');
            infoContainer.classList.toggle('hidden');
            
            // Smooth scroll to info container when opening
            if (!infoContainer.classList.contains('hidden')) {
              infoContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }

          // Close info container when clicking outside
          document.addEventListener('click', (event) => {
            const infoContainer = document.getElementById('infoContainer');
            const infoButton = document.querySelector('[onclick="toggleInfo()"]');
            
            if (!infoContainer.contains(event.target) && !infoButton.contains(event.target)) {
              infoContainer.classList.add('hidden');
            }
          });

          // Touch support for mobile
          document.addEventListener('touchstart', (event) => {
            const infoContainer = document.getElementById('infoContainer');
            const infoButton = document.querySelector('[onclick="toggleInfo()"]');
            
            if (!infoContainer.contains(event.target) && !infoButton.contains(event.target)) {
              infoContainer.classList.add('hidden');
            }
          });
        </script>
      </head>
      <body class="bg-background text-white min-h-screen">
        <div class="container mx-auto px-2 sm:px-4 py-6 sm:py-8">
          <div class="flex justify-between items-start mb-6 sm:mb-8">
            <a href="/" class="inline-flex items-center space-x-2 text-gray-400 hover:text-white">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
              </svg>
              <span>Back to Dashboard</span>
            </a>
            
            <!-- Information Icon Button -->
            <button onclick="toggleInfo()" class="p-2 text-gray-400 hover:text-cyan-500 transition-colors">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </button>
          </div>

          <!-- Hidden Explanation Container -->
          <div id="infoContainer" class="hidden mb-4 p-4 bg-gray-800 rounded-lg border border-gray-700">
            <h2 class="text-lg font-semibold mb-2">Understanding the Color Coding</h2>
            <p class="text-sm text-gray-400">
              The colors of the days represent your step count progress towards your daily goal of 10,000 steps:
            </p>
            <ul class="list-disc list-inside text-gray-400 mt-2">
              <li><span class="text-cyan-500">Cyan</span>: Steps achieved (0-10,000)</li>
              <li><span class="text-gray-600">Gray</span>: No steps recorded for the day</li>
            </ul>
            <p class="text-sm text-gray-400 mt-2">
              The opacity of the cyan color decreases as the step count decreases. This means that days with 
              fewer steps will appear more transparent, visually indicating lower activity levels.
            </p>
          </div>

          ${monthsData
            .map(
              ({ year, month, data }) => `
            <div class="mb-8 sm:mb-12">
              <h2 class="text-lg sm:text-xl font-bold mb-3 sm:mb-4">
                ${new Date(year, month).toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                })}
              </h2>
              <div class="grid grid-cols-7 gap-1 sm:gap-2">
                ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
                  .map(
                    (day) =>
                      `<div class="text-center text-xs sm:text-sm text-gray-400 font-medium">${day}</div>`
                  )
                  .join("")}
                ${generateCalendarGrid(data, year, month)}
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Error rendering calendar page:", error);
    res.status(500).send("Error rendering calendar page");
  }
});
