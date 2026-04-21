Hire-Wire: AI-Powered Interview & Proctoring Platform

An intelligent, fully-automated hiring platform that features AI-driven resume screening, an interactive technical coding sandbox, and real-time biometric video proctoring.

---

Full AI Analysis Capabilities
Hire-Wire performs a complete, multi-layered analysis of candidates:
1. Pre-Screening: AI parses uploaded PDFs/TXTs, checks for role-mismatch, and ranks candidates with a 0-100 CV score.
2. Adaptive Difficulty: The AI Interviewer scales its questions (Fundamentals vs. Architecture) based on the candidate's years of experience.
3. Code Execution & Evaluation: Tracks typing speed (WPM) and runs code via the Piston API. The AI evaluates time/space complexity, syntax, and logic.
4. Biometric Proctoring: Uses `face-api.js` to map 68 facial landmarks. Automatically flags off-screen gazing, tab-switching, and face-hiding.
5. Behavioral Analysis: Evaluates communication skills, clarity, and checks for question-dodging (auto-docking points for "buzzword-dropping").
6. Post-Interview Reporting: Generates a comprehensive JSON report for the HR Dashboard, including sub-scores, proctoring logs, and stealth video recordings.

---

Tech Stack & Packages

Frontend (`/frontend`)
- Core: React 19, Vite, React Router DOM
- Styling: Tailwind CSS
- AI/Biometrics: `face-api.js` (In-browser facial landmark detection)
- Audio: Web Speech API (Native STT & TTS)

Backend (`/backend`)
- Core: Node.js (v22.5.0+ required), Express.js
- Database: `node:sqlite` (Native SQLite built into modern Node.js)
- AI Inference: `groq-sdk` (Llama-3.1-8b-instant & Whisper-large-v3)
- Utilities: `multer` (Memory storage), `pdfreader` (Resume parsing)
- External Services: `nodemailer` (Emails), `cloudinary` (Video hosting)

---

Prerequisites (For a New Device)
1. Node.js v22.5.0 or higher: Strictly required for the native `node:sqlite` database module to work.
2. Git: To clone the repository.

---

Required API Keys & Accounts
To run this project fully, you need to register for the following free services:

1. Groq API Key (For LLM & Speech-to-Text)
   - Go to GroqCloud.
   - Create an account and generate an API key.
2. Cloudinary API Keys (For stealth video uploads)
   - Go to Cloudinary.
   - Create a free account. Navigate to your Dashboard to find your `Cloud Name`, `API Key`, and `API Secret`.
3. Gmail App Password (For sending HR invites/rejections)
   - Go to your Google Account -> Security -> 2-Step Verification.
   - Scroll down to "App Passwords" and generate a new password for "Mail".

---

Complete Installation Guide

1. Clone the Repository
```bash
git clone <your-repo-url>
cd Hire-Wire
```

2. Install All Packages
From the root directory, install all required dependencies for both the frontend and backend automatically:
```bash
npm run install:all
```

Create a `.env` file inside the `/backend` folder and add your keys:
```env
# Server Config
PORT=5000

# AI Services
GROQ_API_KEY=gsk_your_groq_api_key_here

# HR Email Configurations
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_16_character_app_password

# Video Hosting (Cloudinary)
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
```

3. Frontend Setup
Open a new terminal, navigate to the frontend directory, and install packages:
```bash
cd frontend
npm install react react-dom react-router-dom face-api.js socket.io-client tailwindcss @vitejs/plugin-react vite
```

CRITICAL STEP: Face-API Models
For the biometric eye-tracking to work, you must download the pre-trained neural network weights.
1. Create a folder named `models` inside `/frontend/public/` (so it becomes `/frontend/public/models/`).
2. Download the following files from the official face-api.js weights repo:
   - `tiny_face_detector_model-weights_manifest.json`
   - `tiny_face_detector_model-shard1`
   - `face_landmark_68_model-weights_manifest.json`
   - `face_landmark_68_model-shard1`
3. Place all 4 files directly into your new `public/models/` folder.

4. Run the Application
Start the backend server (ensure you are using Node v22.5.0+):
```bash
# In the /backend directory
node server.js
```
*(Note: The database `hirewire.db` will automatically generate on first run).*

Start the frontend development server:
```bash
# In the /frontend directory
npm run dev
```

The HR Dashboard will now be accessible at `http://localhost:5173`!