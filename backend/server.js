import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import cors from 'cors';
import { Groq, toFile } from 'groq-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http'; // Keep http for the express server

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, '.env');

// Force load the .env file from the current directory
dotenv.config({ override: true, path: envPath });

import { sendInterviewEmail } from './utils/emailHelper.js';
import nodemailer from 'nodemailer';
import multer from 'multer';

// Use createRequire to load CommonJS modules in an ES Module environment
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { PdfReader } = require('pdfreader');

const cloudinary = require('cloudinary').v2;

const app = express();
const server = http.createServer(app);

// CONNECT TO CLOUDINARY
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// GLOBAL EMAIL TRANSPORTER (Connection Pooling for faster sending)
const transporter = nodemailer.createTransport({
    service: 'gmail', // Uses Gmail. Can be changed to 'outlook', 'smtp', etc.
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS // App Password if using Gmail 2FA
    }
});

// Middleware
app.use(cors({ origin: 'http://localhost:5173' })); 
app.use(express.json());

// File Upload Config
const upload = multer({ storage: multer.memoryStorage() });

// Initialize SQLite Database
const db = new DatabaseSync(path.join(__dirname, 'hirewire.db'));
db.exec(`
    CREATE TABLE IF NOT EXISTS interviews (
        interviewId TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        role TEXT,
        resumeText TEXT,
        transcript TEXT,
        score INTEGER,
        subScores TEXT,
        analysis TEXT,
        status TEXT DEFAULT 'Invite Sent',
        videoUrl TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);
try { db.exec("ALTER TABLE interviews ADD COLUMN code TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE interviews ADD COLUMN language TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE interviews ADD COLUMN codeOutput TEXT"); } catch (e) {}
try { db.exec("ALTER TABLE interviews ADD COLUMN redFlags INTEGER DEFAULT 0"); } catch (e) {}
try { db.exec("ALTER TABLE interviews ADD COLUMN resumeScore INTEGER"); } catch (e) {}
try { db.exec("ALTER TABLE interviews ADD COLUMN resumeAnalysis TEXT"); } catch (e) {}
console.log('[SQLite] Database initialized successfully');

// NEW: Seed the database with demo data if empty
const { count } = db.prepare('SELECT COUNT(*) AS count FROM interviews').get();
if (count === 0) {
    console.log('[SQLite] Database is empty. Seeding with demo candidates...');
    const insertDemo = db.prepare(`
        INSERT INTO interviews (
            interviewId, name, email, role, resumeText, transcript, score, subScores, analysis, status, redFlags, code, language, codeOutput, videoUrl
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Demo Candidate 1 (High performer)
    insertDemo.run(
        'demo-1', 'John Doe', 'john@example.com', 'Senior React Engineer', 'Demo resume text for John...',
        JSON.stringify([]), 93, JSON.stringify({ logic: 95, syntax: 92, communication: 92 }),
        JSON.stringify({
            technical: "Demonstrated exceptional understanding of React hooks and system architecture. Correctly identified edge cases in Llama-3 API integration.",
            coding: "Candidate successfully solved the Two Sum algorithm in O(n) time using a Hash Map. Code execution compiled perfectly on the first try with clean, readable syntax.",
            communication: "Clear, concise, and highly professional. Structured answers perfectly using the STAR method.",
            proctoring: [ { time: "04:12", event: "Looked off-screen for 3s", severity: "low" }, { time: "18:45", event: "Background noise detected", severity: "low" } ]
        }),
        'Pending Review', 2,
        "function twoSum(nums, target) {\n  const map = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    const complement = target - nums[i];\n    if (map.has(complement)) {\n      return [map.get(complement), i];\n    }\n    map.set(nums[i], i);\n  }\n  return [];\n}",
        'javascript', 'Execution finished with exit code 0 (No output).', 'https://www.w3schools.com/html/mov_bbb.mp4'
    );

    // Demo Candidate 2 (Low performer / flagged)
    insertDemo.run(
        'demo-2', 'Sarah Smith', 'sarah@example.com', 'Backend Node.js Dev', 'Demo resume text for Sarah...',
        JSON.stringify([]), 45, JSON.stringify({ logic: 50, syntax: 40, communication: 45 }),
        JSON.stringify({
            technical: "Struggled with basic Node.js routing concepts. Could not explain the difference between REST and GraphQL when prompted by the AI.",
            coding: "Attempted a Brute Force O(n^2) approach for the sorting challenge but failed to compile due to syntax errors. Required significant AI guidance to reach a solution.",
            communication: "Answers were fragmented and hesitant. Often asked the AI to repeat the question.",
            proctoring: [ { time: "02:10", event: "Tab switched (Loss of focus)", severity: "high" }, { time: "08:30", event: "Face left the frame (45s)", severity: "high" }, { time: "12:15", event: "Copy/Paste event detected in IDE", severity: "high" } ]
        }),
        'Pending Review', 12,
        "def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n):\n        for j in range(0, n-i-1):\n            if arr[j] > arr[j+1]:\n                arr[j], arr[j+1] = arr[j+1], arr[j]\n    return arr\n\nprint(bubble_sort([64, 34, 25, 12, 22, 11, 90]))",
        'python', '[11, 12, 22, 25, 34, 64, 90]\n', null
    );
}

// Request Logger (Advanced Routing Practice)
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Initialize Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Health Check
app.get('/api/status', (req, res) => {
    res.json({ status: 'Online', timestamp: new Date() });
});

// Helper function to format DB documents for the React HR Dashboard
const formatCandidate = (c) => {
    let subScores = { logic: '--', syntax: '--', communication: '--' };
    try { if (c.subScores) subScores = JSON.parse(c.subScores); } catch(e) {}
    
    let analysis = { technical: "Pending completion...", coding: "Pending completion...", communication: "Pending completion...", proctoring: [] };
    try { if (c.analysis) analysis = JSON.parse(c.analysis); } catch(e) {}

    let proctoringArray = analysis.proctoring || [];
    if (!Array.isArray(proctoringArray)) proctoringArray = [];
    if (proctoringArray.length > 0 && typeof proctoringArray[0] === 'string') {
        proctoringArray = proctoringArray.map((str, i) => ({ time: `Event ${i+1}`, event: str, severity: "high" }));
    }

    // FIX: Ensure the number of proctoring logs exactly matches the total red flags reported
    const totalFlags = c.redFlags || 0;
    if (totalFlags > proctoringArray.length) {
        const missing = totalFlags - proctoringArray.length;
        for (let i = 0; i < missing; i++) {
            proctoringArray.push({ 
                time: "System Log", 
                event: "Automated proctoring warning triggered (e.g., Tab switched, face hidden, or AI penalty)", 
                severity: "high" 
            });
        }
    }

    analysis.proctoring = proctoringArray;

    return {
        id: c.interviewId,
        name: c.name || (c.email ? c.email.split('@')[0] : 'Unknown'),
        email: c.email,
        role: c.role,
        date: new Date(c.createdAt + ' UTC').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        score: c.score != null ? c.score : '--',
        subScores: subScores,
        status: c.status,
        flags: c.redFlags != null ? c.redFlags : proctoringArray.length,
        resumeScore: c.resumeScore || null,
        resumeAnalysis: c.resumeAnalysis || "",
        judgeScore: null,
        judgeNotes: "",
        analysis: analysis,
        videoUrl: c.videoUrl,
        code: c.code || '',
        language: c.language || 'javascript',
        codeOutput: c.codeOutput || '',
        transcript: c.transcript ? JSON.parse(c.transcript) : []
    };
};

// NEW: Get All Candidates for HR Dashboard
app.get('/api/candidates', (req, res) => {
    try {
        const candidates = db.prepare('SELECT * FROM interviews ORDER BY createdAt DESC').all();
        const mappedCandidates = candidates.map(formatCandidate);
        res.status(200).json(mappedCandidates);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch candidates' });
    }
});

// NEW: Delete Candidate Route
app.delete('/api/candidates/:id', (req, res) => {
    try {
        const { id } = req.params;
        const result = db.prepare('DELETE FROM interviews WHERE interviewId = ?').run(id);
        if (result.changes > 0) {
            // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time delete.
            res.status(200).json({ success: true });
        } else {
            res.status(404).json({ error: 'Candidate not found' });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ error: 'Failed to delete candidate' });
    }
});

// The HR Invite Route
app.post('/api/invite', upload.any(), async (req, res) => {
    const { email, role } = req.body;
    if (!email) return res.status(400).json({ error: 'Email address is required' });

    const interviewId = `req-${Math.floor(Math.random() * 100000)}`;
    
    // 1. Extract Resume Text
    let resumeText = "No resume provided.";
    const uploadedFile = req.files && req.files.length > 0 ? req.files[0] : null;
    
    if (uploadedFile) {
        console.log(`[Invite] Received file: ${uploadedFile.originalname} (${uploadedFile.mimetype})`);
        try {
            const fileName = uploadedFile.originalname.toLowerCase();
            const mimeType = uploadedFile.mimetype;

            if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
                const extractedText = await new Promise((resolve, reject) => {
                    let text = "";
                    new PdfReader().parseBuffer(uploadedFile.buffer, (err, item) => {
                        if (err) reject(err);
                        else if (!item) resolve(text); // No item means EOF reached
                        else if (item.text) text += item.text + " ";
                    });
                });
                
                const cleanedText = extractedText.replace(/\n\s*\n/g, '\n').trim();
                
                if (!cleanedText) {
                    console.log(`[Invite] Warning: PDF text was empty. Injecting a mock resume so the AI can interview them!`);
                    resumeText = "Candidate is a highly motivated Web Developer with 4 years of experience building scalable web applications using React, Node.js, and Express. Proficient in database design with MongoDB and PostgreSQL. Previously worked at TechCorp where they led the migration of a legacy monolithic application to microservices, improving system performance by 40%. Strong problem-solving skills and a passion for clean, maintainable code.";
                } else {
                    resumeText = cleanedText;
                }
                console.log(`[Invite] Resume processing complete. Context size: ${resumeText.length} characters.`);
            } else if (mimeType.includes('text') || fileName.endsWith('.txt')) {
                resumeText = uploadedFile.buffer.toString('utf8');
                console.log(`[Invite] Successfully read text file. Extracted ${resumeText.length} characters.`);
            } else {
                resumeText = "Unsupported file format. Resume must be a PDF or plain text (.txt) file.";
                console.log(`[Invite] Unsupported file type: ${mimeType}`);
            }
        } catch (err) {
            console.error("Resume parsing error:", err);
            resumeText = "Failed to parse resume.";
        }
    } else {
        console.log("[Invite] No resume file was attached to the request. Body received:", req.body);
    }

    // NEW: AI Pre-Screening Role Mismatch Check
    if (resumeText && resumeText !== "Failed to parse resume.") {
        try {
            console.log(`[Invite] Running AI Gatekeeper check for role: ${role}...`);
            const prompt = `You are a strict technical recruiter. The candidate is applying for the role of "${role}".
            Analyze the resume text. Does the candidate have ANY relevant skills for this specific role?
            If they are in a completely different field (e.g., a pure Web Developer applying for a Game Developer role), reject them.
            
            RESUME TEXT:
            ${resumeText.substring(0, 3000)}
            
            Respond ONLY with valid JSON in this exact format:
            { "isMatch": true or false, "reason": "1 short sentence explaining why." }`;

            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: prompt }],
                model: "llama-3.1-8b-instant",
                temperature: 0.1,
                response_format: { type: "json_object" }
            });

            const evaluation = JSON.parse(completion.choices[0].message.content);
            if (evaluation.isMatch === false) {
                console.log(`[Invite] 🚫 Blocked: ${evaluation.reason}`);
                return res.status(400).json({ error: `AI Pre-Screening Rejected: ${evaluation.reason}` });
            }
        } catch (err) {
            console.error("Pre-screening AI error:", err);
            // Continue if AI check fails so we don't break the flow on random timeouts
        }
    }

    // 2. Save candidate context to SQLite
    const insertStmt = db.prepare(`
        INSERT INTO interviews (interviewId, name, email, role, resumeText, transcript)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(
        interviewId,
        email.split('@')[0],
        email,
        role || 'Software Engineer',
        resumeText,
        JSON.stringify([]) // NEW: Store the full conversation history
    );

    const meetingLink = `http://localhost:5173/meeting/${interviewId}`;

    // Fire and forget the email to prevent UI delay
    sendInterviewEmail(email, meetingLink).catch(err => console.error("Background email failed:", err));

    // Instant response to the frontend
    res.status(200).json({ 
        success: true, 
        message: 'Invite generated and email sending in background', 
        id: interviewId, 
        link: meetingLink 
    });
});

// NEW: Auto-Extract Email Endpoint for HR Dashboard
app.post('/api/parse-resume-email', upload.single('resume'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No resume uploaded' });

    try {
        let resumeText = "";
        const fileName = req.file.originalname.toLowerCase();
        const mimeType = req.file.mimetype;

        if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
            resumeText = await new Promise((resolve, reject) => {
                let text = "";
                new PdfReader().parseBuffer(req.file.buffer, (err, item) => {
                    if (err) reject(err);
                    else if (!item) resolve(text);
                    else if (item.text) text += item.text + " ";
                });
            });
            resumeText = resumeText.replace(/\n\s*\n/g, '\n').trim();
        } else if (mimeType.includes('text') || fileName.endsWith('.txt')) {
            resumeText = req.file.buffer.toString('utf8');
        }

        if (!resumeText) return res.status(400).json({ error: 'Empty resume text' });

        const prompt = `Extract the candidate's email address from this resume. If not found, use "unknown@example.com".\n\nRESUME TEXT:\n${resumeText.substring(0, 3000)}\n\nRespond ONLY with valid JSON in this exact format:\n{ "email": "extracted_email@example.com" }`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: prompt }],
            model: "llama-3.1-8b-instant",
            temperature: 0.1,
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(completion.choices[0].message.content);
        res.status(200).json({ email: result.email });
    } catch (err) {
        console.error("Email extraction error:", err);
        res.status(500).json({ error: 'Failed to extract email' });
    }
});

// NEW: Bulk AI Resume Screening Route
app.post('/api/bulk-screen', upload.any(), async (req, res) => {
    const { role } = req.body;
    if (!role) return res.status(400).json({ error: 'Role is required' });
    
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No resumes uploaded' });
    if (files.length > 5) return res.status(400).json({ error: 'Maximum 5 resumes allowed per bulk screen' });

    const rawEmails = req.body.emails;
    let emailsArray = [];
    if (Array.isArray(rawEmails)) emailsArray = rawEmails;
    else if (rawEmails) emailsArray = [rawEmails];

    const tempResults = [];
    let index = 0;
    for (const file of files) {
        const manualEmail = emailsArray[index];
        let resumeText = "";
        try {
            const fileName = file.originalname.toLowerCase();
            const mimeType = file.mimetype;

            if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
                resumeText = await new Promise((resolve, reject) => {
                    let text = "";
                    new PdfReader().parseBuffer(file.buffer, (err, item) => {
                        if (err) reject(err);
                        else if (!item) resolve(text);
                        else if (item.text) text += item.text + " ";
                    });
                });
                resumeText = resumeText.replace(/\n\s*\n/g, '\n').trim();
            } else if (mimeType.includes('text') || fileName.endsWith('.txt')) {
                resumeText = file.buffer.toString('utf8');
            }
        } catch (err) {
            console.error("Resume parsing error in bulk screen:", err);
            continue;
        }

        if (!resumeText) {
            index++;
            continue;
        }

        try {
            const prompt = `You are an expert technical recruiter. Analyze this resume for the role of "${role}".
            Extract the candidate's name and email address. If not found, use "Unknown" and "unknown@example.com".
            Provide a suitability score from 0 to 100 based on their match for the role.
            Provide a 2-sentence analysis explaining why they are or aren't a good fit.
            
            RESUME TEXT:
            ${resumeText.substring(0, 4000)}
            
            Respond ONLY with valid JSON in this exact format:
            { "name": "Extracted Name", "email": "email@example.com", "score": 85, "analysis": "Short analysis text" }`;

            const completion = await groq.chat.completions.create({
                messages: [{ role: "system", content: prompt }],
                model: "llama-3.1-8b-instant",
                temperature: 0.1,
                response_format: { type: "json_object" }
            });

            const aiResult = JSON.parse(completion.choices[0].message.content);
            const interviewId = `req-${Math.floor(Math.random() * 100000)}`;

            // Prefer manual email if provided, otherwise fallback to AI extraction
            const finalEmail = (manualEmail && manualEmail.trim().length > 0) ? manualEmail.trim() : aiResult.email;
            
            tempResults.push({ interviewId, aiResult, finalEmail, resumeText });
        } catch (err) {
            console.error("AI Screening Error:", err);
        }
        index++;
    }

    // Sort by score descending to find the top candidates
    tempResults.sort((a, b) => b.aiResult.score - a.aiResult.score);

    // Keep ONLY the top 2 highest-scoring candidates (who also meet a baseline score of 50)
    const topCandidates = tempResults.filter(item => item.aiResult.score >= 50).slice(0, 2);

    const results = [];
    topCandidates.forEach((item) => {
        db.prepare(`
            INSERT INTO interviews (interviewId, name, email, role, resumeText, transcript, resumeScore, resumeAnalysis, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            item.interviewId, item.aiResult.name, item.finalEmail, role, item.resumeText,
            JSON.stringify([]), item.aiResult.score, item.aiResult.analysis, 'Shortlisted'
        );

        results.push({ interviewId: item.interviewId, name: item.aiResult.name, email: item.finalEmail, score: item.aiResult.score, status: 'Shortlisted' });
    });

    res.status(200).json({ success: true, processed: tempResults.length, results });
});

// NEW: Trigger Email for a Pre-Screened Candidate
app.post('/api/send-invite/:id', async (req, res) => {
    const interviewId = req.params.id;
    const candidate = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
    
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    if (candidate.status !== 'Shortlisted') return res.status(400).json({ error: 'Candidate is not shortlisted' });

    const meetingLink = `http://localhost:5173/meeting/${interviewId}`;
    db.prepare('UPDATE interviews SET status = ? WHERE interviewId = ?').run('Invite Sent', interviewId);
    sendInterviewEmail(candidate.email, meetingLink).catch(err => console.error("Email failed:", err));

    const updated = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
    res.status(200).json({ success: true, candidate: formatCandidate(updated) });
});

// NEW: Reject a Pre-Screened Candidate
app.post('/api/reject-invite/:id', async (req, res) => {
    const interviewId = req.params.id;
    try {
        const candidate = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        
        if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
        
        db.prepare('UPDATE interviews SET status = ? WHERE interviewId = ?').run('Rejected', interviewId);
        
        const updated = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        res.status(200).json({ success: true, candidate: formatCandidate(updated) });
    } catch (error) {
        console.error("Reject invite error:", error);
        res.status(500).json({ error: 'Failed to reject candidate' });
    }
});

// NEW: Reject a Pre-Screened Candidate
app.post('/api/reject-invite/:id', async (req, res) => {
    const interviewId = req.params.id;
    try {
        const candidate = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        
        if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
        
        db.prepare('UPDATE interviews SET status = ? WHERE interviewId = ?').run('Rejected', interviewId);
        
        const updated = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        res.status(200).json({ success: true, candidate: formatCandidate(updated) });
    } catch (error) {
        console.error("Reject invite error:", error);
        res.status(500).json({ error: 'Failed to reject candidate' });
    }
});

// NEW: Universal Code Execution Route (Powered by Piston API)
// Your frontend terminal can call this to safely compile and run candidate code
let pistonRuntimes = []; // Cache runtimes to ensure correct versions

app.post('/api/execute', async (req, res) => {
    const { language, source, interviewId } = req.body;
    if (!language || !source) return res.status(400).json({ error: 'Language and source code are required' });

    // Map common languages to their Piston identifiers
    const langMap = {
        'javascript': 'javascript', 'python': 'python', 'java': 'java', 
        'c++': 'c++', 'cpp': 'c++', 'c': 'c', 'ruby': 'ruby', 'go': 'go'
    };

    const targetLang = langMap[language.toLowerCase()] || language.toLowerCase();

    try {
        // Piston API v2 requires an exact version string. We fetch and cache the runtimes to get the valid versions.
        if (pistonRuntimes.length === 0) {
            const rRes = await fetch('https://emacs.piston.rs/api/v2/runtimes');
            if (rRes.ok) pistonRuntimes = await rRes.json();
        }
        
        const runtime = pistonRuntimes.find(r => r.language === targetLang || (r.aliases && r.aliases.includes(targetLang)));
        const version = runtime ? runtime.version : '*'; // Fallback safely

        // Piston is a free, open-source code execution engine
        const response = await fetch('https://emacs.piston.rs/api/v2/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language: runtime ? runtime.language : targetLang,
                version: version,
                files: [{ content: source }]
            })
        });
        const result = await response.json();
        
        let output = 'Execution failed';
        if (result.run) {
            output = result.run.output;
            if (output.trim() === "") {
                output = "Execution finished with exit code 0 (No output).";
            }
        } else if (result.message) {
            output = result.message;
        }

        if (interviewId) {
            try {
                db.prepare('UPDATE interviews SET code = ?, language = ?, codeOutput = ? WHERE interviewId = ?')
                  .run(source, language, output, interviewId);
                  
                const updatedInterview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
                if (updatedInterview) {
                    // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time updates.
                }
            } catch (e) {
                console.error("Failed to update code in DB", e);
            }
        }

        res.json({ output });
    } catch (error) {
        console.error("Code Execution Error/Timeout:", error);
        res.json({ output: "Execution Error: " + (error.message || "Timeout reached") });
    }
});

// NEW: Start Interview & Generate Custom Greeting
app.post('/api/start-interview', async (req, res) => {
    const { interviewId } = req.body;
    const interview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
    if (!interview) return res.status(404).json({ error: 'Interview not found in database. Please generate an invite from the HR Dashboard.' });

    const systemPrompt = `
        # ROLE & PERSONA
        You are Sarah, an elite, highly experienced, and EXTREMELY STRICT female Senior Engineering Manager at a top-tier tech company. You are conducting a live, verbal video interview with a candidate for the role of: ${interview.role}. You have a very high bar, expect excellence, and will ruthlessly penalize poor answers.
        
        Candidate Resume Context: ${(interview.resumeText || "").substring(0, 2000)}

        # ADAPTIVE DIFFICULTY (FRESHER VS EXPERIENCED)
        Analyze the candidate's resume to determine their experience level:
        - FRESHER (0-1 years): Focus Phase 1 and Phase 2 on core programming fundamentals, syntax, and basic algorithms.
        - EXPERIENCED (2+ years): Focus Phase 1 and Phase 2 on system design, architecture, complex debugging, and real-world trade-offs.

        # INSTRUCTIONS
        1. Introduce yourself briefly and professionally as Sarah, the Senior Engineering Manager. DO NOT introduce yourself as an AI.
        2. Briefly outline the agenda: Phase 1 is a resume deep-dive, Phase 2 is a technical sandbox (coding), and Phase 3 is Q&A.
        3. Immediately start Phase 1 by asking EXACTLY ONE clear, targeted question based on their resume. Do not ask multi-part questions.
        4. CONVERSATIONAL PACING: Sound like a real human. Occasionally use natural filler words (e.g., "Hmm...", "Well...", "Right."). Use ellipses (...) frequently to create thoughtful pauses.
        5. Establish a strict, controlled tone. Do not thank them for their time.
        6. ABSOLUTELY NO STAGE DIRECTIONS. Output only the exact words you will speak out loud. No parentheses, no asterisks.
        7. PACING: Keep your introduction natural and conversational. Adapt your length, but aim for 3-5 sentences to set the stage without overwhelming the candidate.
    `;

    try {
        const groqPromise = groq.chat.completions.create({
            messages: [{ role: "system", content: systemPrompt }],
            model: "llama-3.1-8b-instant", // FAST model requirement
            temperature: 0.6,
            max_tokens: 150,
        });
        
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("AI Timeout")), 5000));
        const chatCompletion = await Promise.race([groqPromise, timeoutPromise]);
        
        let greeting = chatCompletion.choices[0]?.message?.content || "Let's begin the technical assessment.";
        
        // Programmatic safeguard: Strip out any stray (pauses) or *sighs* the AI tries to sneak in
        greeting = greeting.replace(/\([^)]*\)/g, '').replace(/\*([^*]+)\*/g, '').trim();
        
        const transcript = JSON.parse(interview.transcript);
        transcript.push({ sender: 'ai', text: greeting });
        
        db.prepare('UPDATE interviews SET transcript = ?, status = ? WHERE interviewId = ?')
          .run(JSON.stringify(transcript), 'In Progress', interviewId);
        
        const updatedInterview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time updates.
        
        res.status(200).json({ greeting });
    } catch (error) {
        console.error("Start Interview Error:", error);
        if (error.message === "AI Timeout") {
            return res.status(200).json({ greeting: "Hi there. Thanks for joining. Let's dive right into the technical assessment." });
        }
        res.status(500).json({ error: error.message || 'Failed to generate greeting from AI' });
    }
});

// GLOBAL IDEMPOTENCY CACHE (Prevents Double API Calls)
const processedMessageCache = new Set();

// NEW: The AI Interviewer Route
app.post('/api/chat', async (req, res) => {
    const { messageId, candidateMessage, phase, interviewId, code, language, warningCount } = req.body;

    // 🛑 STRICT SERVER-SIDE LOCK: Reject identical overlapping requests
    if (messageId && processedMessageCache.has(messageId)) {
        console.warn(`[API] 🚫 Blocked duplicate request for message ID: ${messageId}`);
        return res.status(409).json({ error: "Duplicate request detected." });
    }
    if (messageId) processedMessageCache.add(messageId);

    const interview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
    if (!interview) return res.status(404).json({ error: 'Interview not found in database.' });

    // NEW: Sync the frontend's system warning count (tab switches/face tracking) with the database
    if (warningCount && warningCount > (interview.redFlags || 0)) {
        db.prepare('UPDATE interviews SET redFlags = ? WHERE interviewId = ?').run(warningCount, interviewId);
    }

    const transcript = JSON.parse(interview.transcript);
    // Save candidate's message to the transcript
    transcript.push({ sender: 'candidate', text: candidateMessage });

    // Check if we are already mid-conversation (length > 1 means AI already sent the initial greeting)
    const isMidInterview = transcript.length > 1;

    // NEW: Continuous Learning / RAG Mechanism
    // Fetch recent past candidates for this role to "train" the AI's current expectations
    const pastInterviews = db.prepare(`SELECT status, analysis FROM interviews WHERE role = ? AND status IN ('Hired', 'Rejected') AND analysis IS NOT NULL ORDER BY createdAt DESC LIMIT 3`).all(interview.role);
    
    let trainingContext = "";
    if (pastInterviews.length > 0) {
        trainingContext = "\n\n        COMPANY HIRING HISTORY (Continuous Learning Data):";
        pastInterviews.forEach(p => {
            try {
                const analysisObj = JSON.parse(p.analysis);
                if (analysisObj.technical) {
                    trainingContext += `\n        - Past ${p.status} Candidate: ${analysisObj.technical}`;
                }
            } catch (e) {}
        });
        trainingContext += "\n        Use this historical data to calibrate your strictness. If past candidates failed certain concepts, drill harder on those topics. If they succeeded, raise the bar!";
    }

    // The "Lead Technical Architect" Master Persona Prompt
    const systemPrompt = `
        # ROLE & PERSONA
        You are Sarah, an elite, highly experienced, and EXTREMELY STRICT female Senior Engineering Manager conducting a live technical interview for the role of ${interview.role}.
        You are speaking to the candidate over a live audio feed. Act exactly like a tough, no-nonsense human interviewer. You expect excellence and will ruthlessly penalize BS.
        You are NOT their friend. You are NOT their mentor. You are strictly evaluating them.
        
        # INTERVIEW STATE
        - Candidate Resume: ${(interview.resumeText || "").substring(0, 2000)}${trainingContext}
        - Current Phase: Phase ${phase} (1=Intro/Experience, 2=Coding/Sandbox, 3=Deep Q&A)
        - System Warnings (Cheating/Tab-Switching): ${warningCount || 0}
        - Current Code in Editor (${language || 'None'}):
        ${code || '// No code written yet.'}
        
        # ADAPTIVE DIFFICULTY (FRESHER VS EXPERIENCED)
        Remember their experience level from the resume:
        - FRESHER (0-1 years): Ask fundamental/algorithmic questions. Expect textbook knowledge.
        - EXPERIENCED (2+ years): Ask advanced architecture, scaling, and deep technical trade-off questions. Expect real-world battle scars.

        # BEHAVIORAL RULES - STRICT!
        1. CONVERSATIONAL PACING: Sound like a real human. Occasionally start sentences with filler words (e.g., "Hmm...", "Well...", "Okay, so..."). Use ellipses (...) heavily to create thoughtful, natural pauses.
        2. NEVER reveal you are an AI. Be cold, clinical, and strictly evaluative. 
        3. DYNAMIC PACING: Adapt your response length based on the context. Use short follow-ups (1-2 sentences) for quick clarifications. Use medium responses (3-4 sentences) when setting up a scenario, technical task, or hint. NEVER monologue or send walls of text.
        4. SINGLE QUESTION RULE: End every response with EXACTLY ONE clear, direct question. Never ask multi-part questions.
        5. ABSOLUTELY NO STAGE DIRECTIONS: Output plain spoken text only.
        6. INTERNAL METRICS: Continuously evaluate problem-solving, code clarity, and communication. Append exactly "[RED_FLAG]" if they dodge a question or cheat.
        7. CALL TERMINATION: When the interview is over, append exactly "[END_CALL]" to your final message.
        
        # INTERVIEW FLOW (HOW TO REACT - CRITICAL)
        - FOLLOW-UP LOGIC: If their answer is correct, acknowledge briefly and go deeper (Adaptive Difficulty). If partial, give a hint (not a solution). If incorrect, challenge them.
        - TIMER PRESSURE: Impose soft time limits. Say "You should be able to outline this in 2 to 3 minutes." Prompt them to move forward if delayed.
        - ANTI-CHEATING: If "System Warnings" > 0, immediately demand: "Explain your approach step-by-step" or "What are the edge cases?". Increase probing depth aggressively.
        ${phase === 1 ? `- PHASE 1 (INTRO/EXPERIENCE): You are in the resume deep-dive phase. Ask challenging questions referencing specific projects/skills from their resume. DO NOT ask them to write code yet.` : ''}
        ${phase === 2 ? `- PHASE 2 (TECHNICAL SANDBOX): You are now in the coding phase. STOP asking about their past experience/resume. Give them a live coding or debugging task relevant to ${interview.role} and ask them to write it in the code editor.` : ''}
        ${phase >= 3 ? `- PHASE 3 (Q&A): You are in the final phase. Stop asking technical questions. Explicitly ask "Do you have any questions for me?". Respond concisely.` : ''}
        - FINAL WRAP UP: Once Q&A is done, wrap up the interview gracefully and append exactly "[END_CALL]" to your final message.

        # IDE & TERMINAL AWARENESS
        - You can "see" their screen. Focus heavily on their code logic.
        - If they just ran code and there's a syntax or logic error, push them: "Your code just threw an error. A senior engineer should catch that. Walk me through your debugging steps."
        - IGNORING SYSTEM ERRORS: If the terminal output specifically says "Execution Error: Backend connection failed" or mentions "fetch", DO NOT blame the candidate. Say: "Looks like our sandbox environment is having a network issue, let's just talk through the logic instead."
        
        ${phase === 2 ? `\nCRITICAL OVERRIDE: You are in Phase 2 (Coding). If you haven't given a coding task yet, you MUST pivot and give one right now. Do not ask about the resume.` : ''}
        ${phase >= 3 ? `\nCRITICAL OVERRIDE: You are in Phase 3 (Q&A). If you haven't asked yet, you MUST explicitly ask if they have questions for you.` : ''}

        Respond naturally as Sarah the interviewer now to the candidate's latest input.
    `;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        // Keep only the last 6 messages to stay well under the 6000 TPM limit
        const recentTranscript = transcript.slice(-6);

        const messageHistory = [
            { role: "system", content: systemPrompt },
            ...recentTranscript.map(msg => ({
                role: msg.sender === 'candidate' ? 'user' : 'assistant',
                content: msg.text
            }))
        ];

        const stream = await groq.chat.completions.create({
            messages: messageHistory,
            model: "llama-3.1-8b-instant", // FAST model requirement
            temperature: 0.7, 
            max_tokens: 150,
            stream: true, // ⚡ ULTRA-LOW LATENCY: Enable streaming
        });

        let aiResponse = "";
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || "";
            aiResponse += content;
            // Instantly beam the token to the frontend
            res.write(`data: ${JSON.stringify({ chunk: content })}\n\n`);
        }

        
        // Programmatic safeguard: Strip out any stray (pauses) or *sighs* the AI tries to sneak in
        aiResponse = aiResponse.replace(/\([^)]*\)/g, '').replace(/\*([^*]+)\*/g, '').trim();

        // NEW: Dynamic Point Deduction Interceptor
        if (aiResponse.includes('[RED_FLAG]')) {
            aiResponse = aiResponse.replace(/\[RED_FLAG\]/g, '').trim(); // Remove it so the candidate doesn't hear it
            db.prepare('UPDATE interviews SET redFlags = COALESCE(redFlags, 0) + 1 WHERE interviewId = ?').run(interviewId);
            console.log(`[PENALTY] Candidate dodged a question! Red Flag added for interview ${interviewId}`);
        }
        
        // Save AI's response to the transcript
        transcript.push({ sender: 'ai', text: aiResponse });
        
        res.write(`data: [DONE]\n\n`);
        res.end();

        let updateQuery = 'UPDATE interviews SET transcript = ?';
        let queryParams = [JSON.stringify(transcript)];

        if (code !== undefined) {
            updateQuery += ', code = ?';
            queryParams.push(code);
        }
        if (language !== undefined) {
            updateQuery += ', language = ?';
            queryParams.push(language);
        }

        updateQuery += ' WHERE interviewId = ?';
        queryParams.push(interviewId);

        db.prepare(updateQuery).run(...queryParams);
        
        const updatedInterview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time updates.

    } catch (error) {
        console.error("Groq AI Error:", error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    } finally {
        if (messageId) {
            setTimeout(() => processedMessageCache.delete(messageId), 60000); // Clear cache after 60s
        }
    }
});

// NEW: Get Interview Report/Transcript Route
app.get('/api/report/:id', async (req, res) => {
    const interviewId = req.params.id;
    const forceRefresh = req.query.force === 'true';
    const interviewData = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
    
    if (!interviewData) {
        return res.status(404).json({ error: "Interview record not found." });
    }

    // If AI analysis already exists and we aren't forcing a refresh, just return the data immediately
    if (interviewData.analysis && !forceRefresh) {
        return res.status(200).json({
            ...interviewData,
            transcript: JSON.parse(interviewData.transcript),
            subScores: interviewData.subScores ? JSON.parse(interviewData.subScores) : undefined,
            analysis: interviewData.analysis ? JSON.parse(interviewData.analysis) : undefined
        });
    }

    // Otherwise, generate the dynamic HR analysis!
    const transcript = JSON.parse(interviewData.transcript);
    const transcriptText = (transcript || []).map(m => `${m.sender.toUpperCase()}: ${m.text}`).join('\n');
    
    const analysisPrompt = `
        You are an elite Lead Technical Architect and Principal Recruiter evaluating a high-stakes technical interview transcript.
        Your job is to provide a ruthlessly precise, evidence-based evaluation of the candidate for the role of ${interviewData.role}.
        The candidate's hiring outcome depends entirely on this analysis. Do not hallucinate. Base everything strictly on the transcript.
        
        TRANSCRIPT:
        ${transcriptText}
        
        System Logged Red Flags (Warnings/Cheats): ${interviewData.redFlags || 0}

        EVALUATION CRITERIA:
        1. ABORTED SESSION CHECK: Evaluate if the transcript reached a natural conclusion. If it ends abruptly in the middle, you MUST formally state "The meeting was disbanded or disconnected early before completion." in the technical analysis and assign a score based only on the partial data (or 0 if they barely started).
        2. Did they answer the specific technical questions asked, or did they deflect with buzzwords?
        3. Did they demonstrate "First Principles" thinking in the Deep-Dive and Sandbox phases?
        4. Did their code execute successfully, handle edge cases, and have optimal time/space complexity?
        5. Did they require multiple hints to get to the answer, or did they solve terminal errors independently?

        Provide a JSON response strictly in the following format:
        {
            "score": <number 0-100. Be strict. 90+ is an instant hire, 75-89 is strong, <75 is a reject.>,
            "subScores": { 
                "logic": <number 0-100>, 
                "syntax": <number 0-100>, 
                "communication": <number 0-100> 
            },
            "analysis": {
                "technical": "<Detailed paragraph referencing the exact questions asked (e.g., architecture, DB choices) and a precise critique of the candidate's answers. Note any buzzword-dropping vs actual depth.>",
                "coding": "<Detailed paragraph evaluating their technical sandbox/coding performance. Mention specific code logic, time/space complexity, edge cases missed, and if they fixed terminal errors on their own.>",
                "communication": "<Detailed paragraph evaluating their clarity, high-agency ownership, and handling of disagreements. Mention if they were concise or rambled.>",
                "proctoring": [
                    { "time": "Phase X or MM:SS", "event": "List specific cheating attempts, tab switches, or evasive answers. (Generate multiple entries if System Logged Red Flags > 1)", "severity": "high" }
                ]
            }
        }
        Respond ONLY with valid JSON. Do not include markdown formatting like \`\`\`json.
    `;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "system", content: analysisPrompt }],
            model: "llama-3.1-8b-instant", // UPGRADE: Swapped to supported fast model
            temperature: 0.1, // Highly deterministic for JSON output
            max_tokens: 1500,
            response_format: { type: "json_object" } // CRITICAL: Forces pure JSON API output
        });

        let aiResponse = chatCompletion.choices[0]?.message?.content.trim();
        let cleanJson = aiResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        // Fallback cleanup in case AI writes conversational text around the block
        const jsonStart = cleanJson.indexOf('{');
        const jsonEnd = cleanJson.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
            cleanJson = cleanJson.substring(jsonStart, jsonEnd + 1);
        }
        const analysisResult = JSON.parse(cleanJson);

        const score = analysisResult.score != null ? analysisResult.score : 0;
        const subScores = analysisResult.subScores || { logic: 0, syntax: 0, communication: 0 };
        const analysisObj = analysisResult.analysis || { technical: "N/A", coding: "N/A", communication: "N/A", proctoring: [] };

        // Save the generated analysis to the candidate's profile
        db.prepare('UPDATE interviews SET score = ?, subScores = ?, analysis = ?, status = ? WHERE interviewId = ?')
          .run(
              score,
              JSON.stringify(subScores),
              JSON.stringify(analysisObj),
              "Pending Review",
              interviewId
          );

        const updatedInterview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
        // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time updates.

        res.status(200).json({
            ...updatedInterview,
            transcript: JSON.parse(updatedInterview.transcript),
            subScores: JSON.parse(updatedInterview.subScores),
            analysis: JSON.parse(updatedInterview.analysis)
        });
    } catch (error) {
        console.error("AI Analysis Error:", error);
        res.status(500).json({ error: 'Failed to generate dynamic HR analysis.' });
    }
});

// NEW: Auto-Draft HR Email Route
app.post('/api/draft-email', async (req, res) => {
    const { name, role, decision, score, notes } = req.body;

    // Advanced: Validate incoming request data
    if (!name || !role || !decision) {
        return res.status(400).json({ error: 'Missing required fields: name, role, decision.' });
    }

    const systemPrompt = `
        You are the Lead Technical Recruiter at an elite tech company.
        Your job is to draft a highly professional, empathetic, and concise email to a candidate.
        
        Candidate Name: ${name}
        Role applied for: ${role}
        Decision: ${decision} (Either 'hire' or 'reject')
        Technical Assessment Score: ${score}/100
        Hiring Manager Notes: ${notes || "No additional notes."}

        RULES:
        1. If the decision is 'hire', congratulate them, mention a specific strength from the notes/score, and outline the next steps (offer letter coming soon).
        2. If the decision is 'reject', be polite, thank them for their time, mention the assessment was highly competitive, and wish them well. Do NOT mention their specific score in a rejection.
        3. Do not include subject lines or placeholder brackets like [Your Name]. Just write the body of the email.
    `;

    try {
        const chatCompletion = await groq.chat.completions.create({
            messages: [{ role: "system", content: systemPrompt }],
            model: "llama-3.1-8b-instant", // UPGRADE: Swapped to supported fast model
            temperature: 0.6, // Slight creativity for natural language
            max_tokens: 300,
        });

        const draftedLetter = chatCompletion.choices[0]?.message?.content;
        res.status(200).json({ draft: draftedLetter });

    } catch (error) {
        console.error("Drafting Error:", error);
        res.status(500).json({ error: 'Failed to draft email' });
    }
});

// NEW: Send Official Decision Email Route
app.post('/api/send-email', async (req, res) => {
    const { email, subject, message } = req.body;

    try {
        // Fire and forget email to prevent UI freezing
        transporter.sendMail({
            from: '"Hire-Wire HR" <hr@hire-wire.com>',
            to: email,
            subject: subject,
            text: message
        }).catch(err => console.error("Background decision email failed:", err));

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Email Send Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// 3. THE VIDEO UPLOAD ROUTE (Cloudinary + MongoDB)
app.post('/api/upload-video', upload.single('video'), async (req, res) => {
    const { interviewId } = req.body;
    
    if (!req.file) return res.status(400).json({ error: 'No video file provided' });

    console.log(`[Cloudinary] Uploading video for interview: ${interviewId}...`);

    // We use a "Stream" because video files are too heavy for standard uploads
    const uploadStream = cloudinary.uploader.upload_stream(
        { 
            resource_type: "video", 
            folder: "hirewire_interviews",
            timeout: 600000 // Increase timeout to 10 minutes to support large video streams
        },
        async (error, result) => {
            if (error) {
                console.error("Cloudinary Upload Error:", error);
                return res.status(500).json({ error: 'Failed to upload video to cloud' });
            }

            console.log(`✅ Video uploaded successfully! Link: ${result.secure_url}`);

            try {
                // Update the candidate in SQLite with the new video link
                const currentRecord = db.prepare('SELECT status FROM interviews WHERE interviewId = ?').get(interviewId);
                const currentStatus = currentRecord ? currentRecord.status : 'In Progress';
                const newStatus = ['Hired', 'Rejected', 'Reviewed', 'Pending Review'].includes(currentStatus) ? currentStatus : 'Pending Review';

                db.prepare('UPDATE interviews SET videoUrl = ?, status = ? WHERE interviewId = ?')
                  .run(result.secure_url, newStatus, interviewId);
                  
                const updatedInterview = db.prepare('SELECT * FROM interviews WHERE interviewId = ?').get(interviewId);
                
                if (updatedInterview) {
                    // TODO: Replace with WebSocket broadcast if HR dashboard needs real-time updates.
                }
                
                res.status(200).json({ success: true, videoUrl: result.secure_url });
            } catch (dbError) {
                console.error("Database Update Error:", dbError);
                res.status(500).json({ error: 'Video uploaded, but failed to save URL to database' });
            }
        }
    );

    // Start the upload stream
    uploadStream.end(req.file.buffer);
});

// NEW: Highly Advanced Whisper Transcription Route
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: await toFile(req.file.buffer, 'audio.webm'),
            model: "whisper-large-v3-turbo", // Lightning fast, free model
            response_format: "json",
        });

        res.json({ text: transcription.text });
    } catch (error) {
        console.error("Whisper Error:", error);
        res.status(500).json({ error: 'Failed to transcribe audio' });
    }
});

// Global Error Handler Fallback
app.use((err, req, res, next) => {
    console.error('[Unhandled Server Error]:', err.stack);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => { // Use 'server.listen' instead of 'app.listen'
    console.log(`[Server] Hire-Wire Backend is running on port ${PORT}`);
});