const mongoose = require('mongoose');

const candidateSchema = new mongoose.Schema({
    interviewId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    role: { type: String, default: "Software Engineer" },
    resumeText: { type: String, default: "No resume provided." },
    status: { type: String, default: "Invite Sent" },
    aiScore: { type: Number, default: null }, 
    securityFlags: { type: Number, default: 0 },
    videoUrl: { type: String, default: null }, 
    dateAdded: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Candidate', candidateSchema);