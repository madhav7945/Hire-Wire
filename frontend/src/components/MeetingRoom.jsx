import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as faceapi from 'face-api.js';

const MeetingRoom = () => {
    const { id } = useParams();
    const navigate = useNavigate();
    const videoRef = useRef(null);
    const canvasRef = useRef(null); // NEW: Canvas for Face API overlay
    const streamRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const recognitionRef = useRef(null);
    const screenStreamRef = useRef(null);
    const isAiSpeakingRef = useRef(false);
    const audioQueueRef = useRef([]);
    const isPlayingRef = useRef(false);
    const fullAiResponseForEndCallCheckRef = useRef('');
    const lastSubmittedTextRef = useRef(''); // NEW: For de-duping
    const lastSubmittedTimeRef = useRef(0); // NEW: For de-duping
    const hasStartedInterviewRef = useRef(false); // NEW: Prevents double-mount greeting in React Strict Mode
    const hasReceivedGreetingRef = useRef(false); // NEW: Prevents startup race condition
    const isProcessingInputRef = useRef(false); // CRITICAL: Hard Execution Lock
    const isFinalizingRef = useRef(false); // Fixes stale closure in STT onend
    const isMicMutedRef = useRef(false); // Prevents STT auto-restart when muted
    const spokenTextsRef = useRef({}); // NEW: Track spoken text per message
    const sttSilenceTimerRef = useRef(null); // NEW: STT lag reduction
    const activeUtteranceRef = useRef(null); // NEW: Prevents TTS garbage collection glitches
    const lastFaceWarningTimeRef = useRef(0); // NEW: Debounce face/eye warnings
    const faceDetectionIntervalRef = useRef(null); // NEW: Interval for face-api

    const [joined, setJoined] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [isCamOff, setIsCamOff] = useState(false);
    const [isScreenSharing, setIsScreenSharing] = useState(false);
    const [currentPhase, setCurrentPhase] = useState(1);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [code, setCode] = useState('');
    const [language, setLanguage] = useState('javascript');
    const [warningCount, setWarningCount] = useState(0);
    const [terminalOutput, setTerminalOutput] = useState([]);
    const [isFinalizing, setIsFinalizing] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [isCandidateSpeaking, setIsCandidateSpeaking] = useState(false);
    const [isAiThinking, setIsAiThinking] = useState(false);
    const [interimTranscript, setInterimTranscript] = useState('');
    const [wpm, setWpm] = useState(0); // NEW: Typing speed state

    const messagesEndRef = useRef(null);
    const lastAnalyzedCodeRef = useRef('');
    const typingStartTimeRef = useRef(null); // NEW: Typing timer
    const keystrokeCountRef = useRef(0); // NEW: Keystroke counter
    const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}));

    // Helper: Gracefully stops all active media tracks (camera, mic, screen share) to prevent hardware lock bugs
    const stopMediaStreams = () => {
        [streamRef.current, screenStreamRef.current].forEach(stream => {
            if (stream) stream.getTracks().forEach(track => track.stop());
        });
    };

    // --- SIMPLE STT ENGINE ---
    const setupSpeechRecognition = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) return;

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event) => {
            let interim = '';
            let final = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) final += event.results[i][0].transcript;
                else interim += event.results[i][0].transcript;
            }

            setInterimTranscript(interim);

            clearTimeout(sttSilenceTimerRef.current);

            if (final.trim()) {
                setInterimTranscript('');
                // Block input if AI is speaking (No Barge-in)
                if (!isAiSpeakingRef.current && !isFinalizingRef.current) {
                    handleCandidateInput(final.trim(), true);
                }
            } else if (interim.trim()) {
                // Custom silence detection to aggressively reduce STT lag
                sttSilenceTimerRef.current = setTimeout(() => {
                    if (!isAiSpeakingRef.current && !isFinalizingRef.current) {
                        handleCandidateInput(interim.trim(), true);
                        setInterimTranscript('');
                        try { recognition.stop(); } catch(e) {} // Force flush
                    }
                }, 2000); // 2.0s silence threshold (faster response, but still allows short pauses)
            }
        };

        recognition.onend = () => {
            clearTimeout(sttSilenceTimerRef.current);
            if (!isFinalizingRef.current && !isMicMutedRef.current && !isAiSpeakingRef.current) {
                try { recognition.start(); } catch (e) {}
            }
        };

        recognitionRef.current = recognition;
        if (!isAiSpeakingRef.current) {
            try { recognition.start(); } catch (e) {}
        }
    };

    // --- LIVE TTS ENGINE (Sentence by Sentence) ---
    const processAudioQueue = async () => {
        if (isPlayingRef.current || audioQueueRef.current.length === 0) return;

        isPlayingRef.current = true;
        setIsAiThinking(false); // Ensure thinking stops and bubbles appear when speech starts

        if (!isAiSpeakingRef.current) {
            setIsAiSpeaking(true);
            isAiSpeakingRef.current = true;
            if (!isMicMutedRef.current && recognitionRef.current) {
                try { recognitionRef.current.stop(); } catch(e) {}
            }
        }

        // Ensure browser voices are fully loaded
        let voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) {
            await new Promise(resolve => {
                const interval = setInterval(() => {
                    if (window.speechSynthesis.getVoices().length > 0) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 50);
                setTimeout(() => { clearInterval(interval); resolve(); }, 2000); // 2s max wait
            });
            voices = window.speechSynthesis.getVoices();
        }

        while (audioQueueRef.current.length > 0) {
            const { text: textToSpeak, replyId } = audioQueueRef.current.shift();
            const cleanText = textToSpeak.replace(/\[.*?\]/g, '').replace(/[*_~`#]/g, '').trim(); // Standardized to perfectly match display text
            if (!cleanText) continue;

            await new Promise((resolve) => {
                const utterance = new SpeechSynthesisUtterance(cleanText);
                activeUtteranceRef.current = utterance; // 🛡️ CRITICAL: Prevents Chrome from deleting the voice mid-sentence
                
                // Prioritize ultra-realistic Cloud/Neural female voices first
                const femaleVoice = 
                    voices.find(v => v.name.includes('Jenny') && v.name.includes('Natural')) || // Edge ultra-realistic
                    voices.find(v => v.name.includes('Aria') && v.name.includes('Natural')) ||  // Edge ultra-realistic
                    voices.find(v => v.name.includes('Samantha')) || // macOS native female
                    voices.find(v => v.name.includes('Google US English')) || // Chrome native female
                    voices.find(v => v.name.includes('Zira')) || // Windows offline female
                    voices.find(v => (v.name.includes('Female') || v.name.includes('female')) && v.lang.startsWith('en')) || 
                    voices.find(v => v.lang.startsWith('en-US')) || 
                    voices[0];
                
                if (femaleVoice) utterance.voice = femaleVoice;
                utterance.rate = 1.05; // Slightly conversational speed
                
                // Live ChatGPT-style text sync!
                utterance.onstart = () => {
                    setIsAiThinking(false); // Stop thinking ONLY when audio actually begins
                    const baseText = (spokenTextsRef.current[replyId] || "").trim();
                    setMessages(prev => prev.map(msg => 
                        msg.id === replyId ? { ...msg, displayedText: baseText } : msg
                    ));
                };

                utterance.onboundary = (event) => {
                    if (event.name === 'word') {
                        const baseText = (spokenTextsRef.current[replyId] || "").trim();
                        const spokenNow = cleanText.substring(0, event.charIndex);
                        setMessages(prev => prev.map(msg => 
                            msg.id === replyId ? { ...msg, displayedText: (baseText + " " + spokenNow).trim() } : msg
                        ));
                    }
                };

                utterance.onend = () => {
                    spokenTextsRef.current[replyId] = ((spokenTextsRef.current[replyId] || "") + " " + cleanText).trim();
                    setMessages(prev => prev.map(msg => 
                        msg.id === replyId ? { ...msg, displayedText: spokenTextsRef.current[replyId] } : msg
                    ));
                    activeUtteranceRef.current = null;
                    resolve();
                };

                utterance.onerror = (e) => {
                    setIsAiThinking(false);
                    // Fallback to show full text if error occurs
                    spokenTextsRef.current[replyId] = ((spokenTextsRef.current[replyId] || "") + " " + cleanText).trim();
                    setMessages(prev => prev.map(msg => 
                        msg.id === replyId ? { ...msg, displayedText: spokenTextsRef.current[replyId] } : msg
                    ));
                    activeUtteranceRef.current = null;
                    resolve(); 
                };
                
                window.speechSynthesis.speak(utterance);
            });

            // 🌬️ Human Breathing Pause: Wait 400ms before starting the next sentence
            if (audioQueueRef.current.length > 0) {
                await new Promise(res => setTimeout(res, 400));
            }
        }

        // This part only runs when the queue is empty and all audio has been played
        isPlayingRef.current = false;
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;

        if (fullAiResponseForEndCallCheckRef.current.includes('[END_CALL]')) {
            handleEndInterview();
        } else {
            if (!isMicMutedRef.current && recognitionRef.current) {
                try { recognitionRef.current.start(); } catch(e) {}
            }
        }
    };

    const speakSentence = (text, replyId) => {
        if (!text) return;
        audioQueueRef.current.push({ text, replyId });
        processAudioQueue();
    };

    // Update the clock in the control bar every minute
    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})), 60000);
        return () => clearInterval(timer);
    }, []);

    // Auto-scroll chat to the bottom on new messages or transcripts
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Dynamic AI Code Analysis
    useEffect(() => {
        if (!joined || code.trim().length < 15 || currentPhase !== 2) return;

        // Wait 10 seconds after the candidate stops typing to "analyze"
        const analyzeTimeout = setTimeout(async () => {
            // 🛑 CRITICAL: Ensure idle analysis doesn't collide with user speech/run
            if (code !== lastAnalyzedCodeRef.current && !isProcessingInputRef.current) {
                lastAnalyzedCodeRef.current = code;
                
                try {
                    const response = await fetch('http://localhost:5000/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                            candidateMessage: `[System Note: The candidate has paused typing. Language: ${language}. Current code:]\n${code}\n[Provide a short, 1-sentence critique, tip, or thought-provoking question about this code. Do not mention that this is a system note.]`, 
                            phase: currentPhase,
                            interviewId: id,
                            code,
                            language,
                            warningCount
                        })
                    });
                    const data = await response.json();
                    if (data.reply && !isProcessingInputRef.current) { // Ensure user hasn't started talking
                        const modifiedReply = `[Code Analysis] ${data.reply}`;
                        const replyId = crypto.randomUUID();
                        setMessages(prev => [...prev, { id: replyId, sender: 'ai', text: modifiedReply, displayedText: '' }]);
                        speakSentence(modifiedReply, replyId);
                    } else if (data.error) {
                        console.error(`Backend Error: ${data.error}`);
                    }
                } catch (err) {
                    console.error("Analysis error:", err);
                }
            }
        }, 2000); // Reduced delay from 10 seconds to 2 seconds

        return () => clearTimeout(analyzeTimeout);
    }, [code, joined, currentPhase, id]);

    const startRecording = (stream) => {
        if (typeof MediaRecorder === 'undefined') {
            console.warn("MediaRecorder API is not supported in this browser.");
            return;
        }
        // === STEALTH RECORDING START ===
        // We record silently. No UI alerts. No red dots.
        const options = MediaRecorder.isTypeSupported('video/webm') ? { mimeType: 'video/webm' } : {};
        const mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        mediaRecorder.start(1000); 
    };

    const handleEndInterview = async () => {
        setIsFinalizing(true);
        isFinalizingRef.current = true;
        window.speechSynthesis.cancel(); // Stop AI speaking immediately
        // The backend should send the final message audio.

        // Kill camera light immediately so they know the interview is over
        stopMediaStreams();
        if (recognitionRef.current) {
            recognitionRef.current.onend = null;
            try { recognitionRef.current.stop(); } catch(e) {}
        }

        // Fire and forget: The Covert Upload happens silently in the background
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.onstop = () => {
                if (chunksRef.current.length === 0) return;
                const videoBlob = new Blob(chunksRef.current, { type: 'video/webm' });
                const formData = new FormData();
                formData.append('video', videoBlob, 'stealth_interview.webm');
                formData.append('interviewId', id); 

                fetch('http://localhost:5000/api/upload-video', { method: 'POST', body: formData, keepalive: true })
                    .catch(err => console.error("Background upload failed:", err));
            };
            mediaRecorderRef.current.stop();
        }
        
        // PRE-GENERATE ANALYSIS: Fire and forget so HR gets the report instantly without delay
        fetch(`http://localhost:5000/api/report/${id}`).catch(err => console.error("Auto-report generation failed:", err));
        
        // Wait 2.5 seconds before navigating to show the "Finalizing..." state smoothly
        setTimeout(() => {
            navigate('/');
        }, 2500);
    };

    const handleCheatAttempt = (action) => {
        setWarningCount(c => c + 1);
        const warningMsg = `WARNING: ${action} detected. This incident has been logged.`;
        
        const warnId = crypto.randomUUID();
        setMessages(prev => [...prev, { id: warnId, sender: 'ai', text: warningMsg, displayedText: '' }]);
        speakSentence(`Warning. ${action} detected.`, warnId);
    };

    // NEW: Strict Camera Monitoring & Auto-Termination
    useEffect(() => {
        let cameraWarningTimer;
        let warningsGiven = 0;

        if (isCamOff && joined && !isFinalizing) {
            cameraWarningTimer = setInterval(() => {
                warningsGiven++;
                if (warningsGiven >= 3) {
                    handleCheatAttempt("Extended disabled camera");
                    clearInterval(cameraWarningTimer);
                    handleEndInterview(); // Kill the meeting!
                } else {
                    handleCheatAttempt("Disabled camera");
                }
            }, 10000); // Warn every 10 seconds
        }

        return () => clearInterval(cameraWarningTimer);
    }, [isCamOff, joined, isFinalizing]);

    useEffect(() => {
        if (joined) {
            if (hasStartedInterviewRef.current) return; // Prevent double-greeting in Strict Mode
            hasStartedInterviewRef.current = true;
            
            setIsAiThinking(true);
            fetch('http://localhost:5000/api/start-interview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ interviewId: id })
            })
            .then(res => res.json())
            .then(data => {
                hasReceivedGreetingRef.current = true; // Unlock the microphone submissions!
                if (data.greeting) {
                    const greetId = crypto.randomUUID();
                    setMessages(prev => [...prev, { id: greetId, sender: 'ai', text: data.greeting, displayedText: '' }]);
                    speakSentence(data.greeting, greetId);
                } else if (data.error) {
                    setIsAiThinking(false);
                    setMessages([{ sender: 'ai', text: `Backend Error: ${data.error}` }]);
                }
            }).catch(err => {
                setIsAiThinking(false);
                console.error(err);
                setMessages([{ sender: 'ai', text: `Connection Error: Unable to reach the backend.` }]);
            });

            navigator.mediaDevices.getUserMedia({ 
                video: true, 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            })
                .then(stream => {
                    streamRef.current = stream;
                    if (videoRef.current) videoRef.current.srcObject = stream;
                    startRecording(stream);
                    setupSpeechRecognition();

                // === NEW: INITIALIZE EYE & HEAD POSE TRACKING ===
                const startProctoring = async () => {
                    try {
                        // Load models from the public/models directory
                        await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
                        await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
                        
                        faceDetectionIntervalRef.current = setInterval(async () => {
                            if (videoRef.current && videoRef.current.readyState === 4 && !isFinalizingRef.current) {
                                const detections = await faceapi.detectSingleFace(
                                    videoRef.current, 
                                    new faceapi.TinyFaceDetectorOptions({ inputSize: 160 })
                                ).withFaceLandmarks();

                                const now = Date.now();
                                
                                // --- NEW: DRAW FACE LANDMARKS OVERLAY ---
                                if (canvasRef.current) {
                                    const displaySize = { width: videoRef.current.videoWidth, height: videoRef.current.videoHeight };
                                    if (canvasRef.current.width !== displaySize.width) {
                                        faceapi.matchDimensions(canvasRef.current, displaySize);
                                    }
                                    const ctx = canvasRef.current.getContext('2d');
                                    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
                                    
                                    if (detections) {
                                        const resizedDetections = faceapi.resizeResults(detections, displaySize);
                                        faceapi.draw.drawFaceLandmarks(canvasRef.current, resizedDetections);
                                    }
                                }
                                // -----------------------------------------

                                if (!detections) {
                                    // Face completely disappeared (Looked down or walked away)
                                    if (now - lastFaceWarningTimeRef.current > 15000) { 
                                        handleCheatAttempt("Face not visible in frame");
                                        lastFaceWarningTimeRef.current = now;
                                    }
                                } else {
                                    // Eye & Head Movement Detection (Looking off-screen)
                                    const landmarks = detections.landmarks;
                                    const nose = landmarks.getNose();
                                    const jawOutline = landmarks.getJawOutline();
                                    
                                    const leftEdge = jawOutline[0].x;
                                    const rightEdge = jawOutline[jawOutline.length - 1].x;
                                    const noseX = nose[3].x;
                                    
                                    // Calculate nose position relative to face width (0.5 is perfectly centered)
                                    const faceWidth = rightEdge - leftEdge;
                                    const nosePosition = (noseX - leftEdge) / faceWidth;

                                    // If < 0.25 or > 0.75, the candidate has sharply turned their head/eyes to look away
                                    if ((nosePosition < 0.25 || nosePosition > 0.75) && (now - lastFaceWarningTimeRef.current > 12000)) {
                                        handleCheatAttempt("Looking off-screen (Eye/Head movement)");
                                        lastFaceWarningTimeRef.current = now;
                                    }
                                }
                            }
                        }, 2000); // Check every 2 seconds to optimize CPU usage
                    } catch (e) {
                        console.warn("Face-API models not found in /models. Eye tracking disabled.", e);
                    }
                };
                startProctoring();
                // =================================================
                }).catch(err => console.error(err));

            const handleVisibility = () => { if (document.hidden) handleCheatAttempt("Tab switching"); };
            document.addEventListener("visibilitychange", handleVisibility);
            
            return () => {
                document.removeEventListener("visibilitychange", handleVisibility);
                window.speechSynthesis.cancel(); // Cleanup speech on unmount
                if (recognitionRef.current) { recognitionRef.current.onend = null; try { recognitionRef.current.stop(); } catch(e) {} }
                
                // Emergency backup video upload if candidate closes tab early
                if (!isFinalizingRef.current && mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
                    mediaRecorderRef.current.onstop = () => {
                        if (chunksRef.current.length > 0) {
                            const videoBlob = new Blob(chunksRef.current, { type: 'video/webm' });
                            const formData = new FormData();
                            formData.append('video', videoBlob, 'stealth_interview_aborted.webm');
                            formData.append('interviewId', id); 
                            fetch('http://localhost:5000/api/upload-video', { method: 'POST', body: formData, keepalive: true }).catch(()=>{});
                        }
                    };
                    try { mediaRecorderRef.current.stop(); } catch(e) {}
                }
                stopMediaStreams();
            };
        }
    }, [joined, id]);

    const handleJoin = async () => {
        try {
            // Pre-check camera and mic access before allowing the interview to start
            const testStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            testStream.getTracks().forEach(track => track.stop()); // Clean up immediately
            
            setJoined(true);
            // 🔊 HTML5 AUDIO WARM-UP HACK: Unlocks modern browser Autoplay policies
            const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
            silentAudio.play().catch(() => {});
    
            // 🔊 TTS WARM-UP HACK: Explicitly unlock SpeechSynthesis during the user click event!
            window.speechSynthesis.cancel();
            const silentUtterance = new SpeechSynthesisUtterance('');
            silentUtterance.volume = 0;
            window.speechSynthesis.speak(silentUtterance);
        } catch (err) {
            alert("Camera and Microphone access are strictly required to start the proctored interview. Please allow permissions in your browser.");
            console.error("Media access denied:", err);
        }
    };

    const toggleMic = () => {
        if (streamRef.current) {
            const audioTrack = streamRef.current.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                setIsMuted(!audioTrack.enabled);
                isMicMutedRef.current = !audioTrack.enabled;
                if (audioTrack.enabled) {
                    if (recognitionRef.current) try { recognitionRef.current.start(); } catch(e) {}
                } else {
                    if (recognitionRef.current) {
                        try { recognitionRef.current.stop(); } catch(e) {}
                    }
                }
            }
        }
    };

    const toggleCam = () => {
        if (streamRef.current) {
            const videoTrack = streamRef.current.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                setIsCamOff(!videoTrack.enabled);
            }
        }
    };

    const toggleScreenShare = async () => {
        if (!isScreenSharing) {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                screenStreamRef.current = screenStream;
                if (videoRef.current) videoRef.current.srcObject = screenStream;
                setIsScreenSharing(true);
                
                screenStream.getVideoTracks()[0].onended = () => {
                    if (videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
                    setIsScreenSharing(false);
                    screenStreamRef.current = null;
                };
            } catch (err) { console.error("Screen share failed", err); }
        } else {
            if (videoRef.current && streamRef.current) videoRef.current.srcObject = streamRef.current;
            setIsScreenSharing(false);
            if (screenStreamRef.current) {
                screenStreamRef.current.getTracks().forEach(track => track.stop());
                screenStreamRef.current = null;
            }
        }
    };

    const handleCandidateInput = async (text, isSpeech = false) => {
        if (!text.trim() || !hasReceivedGreetingRef.current || isProcessingInputRef.current) return;

        const now = Date.now();
        const cleanText = text.toLowerCase().trim().replace(/[^\w\s]/gi, '');
        if (isSpeech && (now - lastSubmittedTimeRef.current < 4000)) {
            if (cleanText === lastSubmittedTextRef.current || lastSubmittedTextRef.current.includes(cleanText)) {
                return;
            }
        }
        
        isProcessingInputRef.current = true;
        lastSubmittedTextRef.current = cleanText;
        lastSubmittedTimeRef.current = now;

        const displayMsg = isSpeech ? `🗣️ ${text}` : text;
        
        const currentMsgCount = messages.filter(m => m.sender === 'candidate').length + 1;
        let newPhase = currentPhase;
        // Automatically transition based on conversation length as a fallback
        if (currentMsgCount >= 4 && newPhase < 2) newPhase = 2;
        if (currentMsgCount >= 8 && newPhase < 3) newPhase = 3;
        if (newPhase !== currentPhase) setCurrentPhase(newPhase);

        setMessages(prev => [...prev, { sender: 'candidate', text: displayMsg }]);
        const replyId = crypto.randomUUID();
        setMessages(prev => [...prev, { id: replyId, sender: 'ai', text: '', displayedText: '' }]);

        setIsAiThinking(true);

        let apiMessage = text;
        if (newPhase === 2 && currentPhase === 1) {
            apiMessage += "\n\n[System Note: Phase 2 has started. STOP asking about the resume. You MUST immediately give a specific coding or debugging task.]";
        } else if (newPhase === 3 && currentPhase === 2) {
            apiMessage += "\n\n[System Note: Phase 3 has started. STOP asking technical questions. You MUST immediately ask if the candidate has any questions for you.]";
        }

        try {
            const response = await fetch('http://localhost:5000/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    candidateMessage: apiMessage, 
                    phase: newPhase,
                    interviewId: id,
                    code,
                    language,
                    warningCount
                })
            });

            const reader = response.body.getReader();
            const decoder = new TextDecoder("utf-8");
            let fullText = "";
            let buffer = "";
            
            let sentenceBuffer = "";
            fullAiResponseForEndCallCheckRef.current = ''; // Reset for new response

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // Keep the last incomplete line in the buffer
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const dataStr = line.replace('data: ', '').trim();
                        if (dataStr === '[DONE]') break;
                        try {
                            const parsed = JSON.parse(dataStr);
                            const token = parsed.chunk || "";
                            fullText += token;
                            sentenceBuffer += token;
                            fullAiResponseForEndCallCheckRef.current = fullText;

                            // Sync UI Phase instantly if AI mentions phase transitions
                            const lowerText = fullText.toLowerCase();
                            if (newPhase < 2 && (lowerText.includes("technical sandbox") || lowerText.includes("let's code") || lowerText.includes("write a function") || lowerText.includes("implement"))) {
                                setCurrentPhase(2);
                                newPhase = 2;
                            } else if (newPhase < 3 && (lowerText.includes("any questions for me") || lowerText.includes("do you have any questions"))) {
                                setCurrentPhase(3);
                                newPhase = 3;
                            }

                            // Update the background text, but leave displayedText alone to be updated by TTS
                            setMessages(prev => prev.map(msg => msg.id === replyId ? { ...msg, text: fullText } : msg));

                            // Check if we have a complete sentence to speak
                            if (/[.?!]\s|[\n]/.test(sentenceBuffer)) {
                                const parts = sentenceBuffer.split(/(?<=[.?!])\s+/);
                                if (parts.length > 1) {
                                    for (let i = 0; i < parts.length - 1; i++) {
                                        speakSentence(parts[i], replyId);
                                    }
                                    sentenceBuffer = parts[parts.length - 1];
                                }
                            }
                        } catch (e) { console.error("SSE JSON Parse Error:", e, dataStr); }
                    }
                }
            }
            
            if (sentenceBuffer.trim().length > 0) {
                speakSentence(sentenceBuffer.trim(), replyId);
            } else if (fullText.trim().length === 0) {
                setIsAiThinking(false); // Safety fallback if Groq returned completely empty
            }
            
        } catch (error) {
            setIsAiThinking(false);
            console.error("Chat error:", error);
            const errId = crypto.randomUUID();
            const errorMsg = "System connection lost.";
            setMessages(prev => [...prev, { id: errId, sender: 'ai', text: errorMsg, displayedText: '' }]);
            speakSentence(errorMsg, errId);
        } finally {
            // Wait for all queued audio to finish playing before releasing the lock
            const waitForAudio = () => {
                return new Promise(resolve => {
                    const interval = setInterval(() => {
                        if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
                            clearInterval(interval);
                            resolve();
                        }
                    }, 100);
                });
            };
            await waitForAudio();
            isProcessingInputRef.current = false;
            setIsAiThinking(false); // SUPER SAFE FALLBACK: guarantee it turns off when lock releases
        }
    };

    const handleSend = (e) => {
        e.preventDefault();
        if (!input.trim()) return;
        handleCandidateInput(input, false);
        setInput('');
    };

    const runCode = async () => {
        if (!code.trim()) return;
        
        // 🛑 1. HARD EXECUTION LOCK
        if (isProcessingInputRef.current) {
            console.warn("🚫 [SYSTEM LOCK] Blocked overlapping code execution.");
            return;
        }
        isProcessingInputRef.current = true;

        setTerminalOutput(prev => [...prev, { type: 'system', text: '> Running code execution...' }]);
        
        try {
            // Ensure phase updates to technical sandbox if they execute code
            let execPhase = currentPhase;
            if (execPhase < 2) {
                setCurrentPhase(2);
                execPhase = 2;
            }

            const response = await fetch('http://localhost:5000/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    language, 
                    source: code,
                    interviewId: id
                })
            });
            
            const data = await response.json();
            const outputMsg = data.output || "Execution finished with exit code 0 (No output).";
            const hasError = data.error || (data.output && data.output.toLowerCase().includes('error'));
            
            setTerminalOutput(prev => [...prev, { type: hasError ? 'error' : 'success', text: outputMsg.trim() }]);
            
            // Real dynamic AI integration for Code Execution
            setIsAiThinking(true);
            try {
                const aiResponse = await fetch('http://localhost:5000/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        candidateMessage: `[System Note: The candidate executed their code. Language: ${language}. Terminal_Output:\n${outputMsg}\nHas Error: ${!!hasError}. Review this output and provide a short, direct technical response based on your IDE rules.]`, 
                        phase: execPhase,
                        interviewId: id,
                        code,
                        language,
                        warningCount
                    })
                });

                const aiData = await aiResponse.json();
                setIsAiThinking(false);
                if (aiData.reply) {
                    const codeReplyId = crypto.randomUUID();
                    setMessages(prev => [...prev, { id: codeReplyId, sender: 'ai', text: aiData.reply, displayedText: '' }]);
                    speakSentence(aiData.reply, codeReplyId);
                } else if (aiData.error) {
                    setMessages(prev => [...prev, { sender: 'ai', text: `Backend Error: ${aiData.error}` }]);
                }
            } catch (error) {
                setIsAiThinking(false);
                console.error("Execution AI connection failed", error);
            }
        } catch (error) {
            setTerminalOutput(prev => [...prev, { type: 'error', text: 'Execution Error: Backend connection failed or timed out.' }]);
            console.error("Execution failed", error);
        } finally {
            // 🔓 RELEASE LOCK
            isProcessingInputRef.current = false;
        }
    };

    if (!joined) {
        return (
            <div className="min-h-screen bg-[#202124] flex items-center justify-center font-sans text-white">
                <div className="max-w-5xl w-full p-6 flex flex-col md:flex-row items-center gap-12">
                    <div className="w-full md:w-[60%] aspect-video bg-[#3c4043] rounded-xl border border-white/10 flex flex-col items-center justify-center shadow-2xl relative overflow-hidden">
                        <div className="text-center">
                            <div className="w-20 h-20 bg-[#202124] rounded-full flex items-center justify-center mx-auto mb-4 shadow-inner">
                                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-400"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"></path><rect x="2" y="6" width="14" height="12" rx="2"></rect></svg>
                            </div>
                            <p className="text-slate-300 font-medium text-lg">Camera is starting...</p>
                        </div>
                        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4">
                            <div className="w-14 h-14 rounded-full bg-[#EA4335] flex items-center justify-center border border-white/10 shadow-lg cursor-not-allowed opacity-80"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"></path><path d="M5 10v2a7 7 0 0 0 12 5l-1.5-1.5a5 5 0 0 1-9-3.5V10"></path><path d="M9 9v3a3 3 0 0 0 5.12 2.12l-1.5-1.5A1 1 0 0 1 11 12V9"></path></svg></div>
                            <div className="w-14 h-14 rounded-full bg-[#EA4335] flex items-center justify-center border border-white/10 shadow-lg cursor-not-allowed opacity-80"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M21 21v-4a2 2 0 0 0-2-2h-3.32"></path><path d="m15.66 11.23-3.16-3.16a2 2 0 0 0-2.83 0l-4.83 4.83a2 2 0 0 0 0 2.83l3.16 3.16"></path></svg></div>
                        </div>
                    </div>
                    <div className="w-full md:w-[40%] flex flex-col items-center md:items-start text-center md:text-left">
                        <h1 className="text-4xl font-normal mb-2 text-white">Ready to join?</h1>
                        <p className="text-slate-400 mb-10 text-lg">Hire-Wire AI Proctor is waiting.</p>
                        <button onClick={handleJoin} className="bg-[#8AB4F8] hover:bg-[#9BBFF9] text-gray-900 font-medium py-3 px-10 rounded-full text-lg transition-all shadow-md">
                            Join now
                        </button>
                        <div className="mt-10 text-xs text-slate-500 max-w-xs">
                            By joining, you agree to our Terms of Service and Privacy Policy. This session will be recorded.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen bg-[#202124] text-white flex flex-col font-sans overflow-hidden">
            <style>{`
                /* Professional Typing Cursor */
                @keyframes smoothBlink {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0; }
                }
                .typing-cursor {
                    animation: smoothBlink 0.8s cubic-bezier(0.4, 0, 0.6, 1) infinite;
                }

                /* Smooth Chat Bubble Entrance */
                @keyframes slideIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .msg-enter {
                    animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }

                /* Modern AI Thinking Dots */
                @keyframes subtleWave {
                    0%, 100% { transform: translateY(0); opacity: 0.3; }
                    50% { transform: translateY(-4px); opacity: 1; }
                }
                .dot-1 { animation: subtleWave 1.4s infinite ease-in-out; }
                .dot-2 { animation: subtleWave 1.4s infinite ease-in-out 0.2s; }
                .dot-3 { animation: subtleWave 1.4s infinite ease-in-out 0.4s; }

                /* Smooth CSS Audio Visualizer */
                @keyframes audioBar {
                    0%, 100% { height: 6px; }
                    50% { height: 20px; }
                }
                .audio-bar-1 { animation: audioBar 0.9s infinite ease-in-out; }
                .audio-bar-2 { animation: audioBar 1.1s infinite ease-in-out 0.2s; }
                .audio-bar-3 { animation: audioBar 0.8s infinite ease-in-out 0.4s; }
                .audio-bar-4 { animation: audioBar 1.0s infinite ease-in-out 0.1s; }
                .audio-bar-5 { animation: audioBar 1.2s infinite ease-in-out 0.3s; }
            `}</style>
            
            {/* Top Info Bar (Interview Phase Tracker) */}
            <div className="bg-[#121418] border-b border-white/5 py-2 px-6 flex items-center justify-between text-xs font-medium tracking-wide shadow-sm z-10 shrink-0">
                <div className="flex items-center gap-6">
                    <div className={`flex items-center gap-2 ${currentPhase === 1 ? 'text-white' : currentPhase > 1 ? 'text-blue-400' : 'text-slate-500'}`}>
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] border ${currentPhase === 1 ? 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)] border-transparent' : currentPhase > 1 ? 'bg-blue-500/20 border-blue-500/30' : 'bg-slate-800 border-slate-700'}`}>1</div>
                        <span>Introductions</span>
                    </div>
                    <div className={`w-4 h-[1px] ${currentPhase > 1 ? 'bg-blue-500/50' : 'bg-slate-700'}`}></div>
                    <div className={`flex items-center gap-2 ${currentPhase === 2 ? 'text-white' : currentPhase > 2 ? 'text-blue-400' : 'text-slate-500'}`}>
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] border ${currentPhase === 2 ? 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)] border-transparent' : currentPhase > 2 ? 'bg-blue-500/20 border-blue-500/30' : 'bg-slate-800 border-slate-700'}`}>2</div>
                        <span>Technical Sandbox</span>
                    </div>
                    <div className={`w-4 h-[1px] ${currentPhase > 2 ? 'bg-blue-500/50' : 'bg-slate-700'}`}></div>
                    <div className={`flex items-center gap-2 ${currentPhase === 3 ? 'text-white' : 'text-slate-500'}`}>
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] border ${currentPhase === 3 ? 'bg-blue-600 shadow-[0_0_8px_rgba(37,99,235,0.5)] border-transparent' : 'bg-slate-800 border-slate-700'}`}>3</div>
                        <span>Q & A</span>
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden p-4 gap-4">
                {/* Left Area: Video Feeds + Code Editor */}
                <div className="flex-1 flex flex-col gap-4 overflow-hidden">
                    {/* Top: Video Gallery */}
                    <div className="flex gap-4 shrink-0 justify-center">
                        {/* AI Proctor Video feed */}
                        <div className="w-full max-w-[400px] xl:max-w-[480px] aspect-video bg-[#3c4043] rounded-xl relative overflow-hidden flex items-center justify-center shadow-md border border-white/5">
                            <div className="flex flex-col items-center gap-4 z-10">
                                <div className={`w-24 h-24 rounded-full flex items-center justify-center relative transition-all duration-700 ${isAiThinking ? 'bg-indigo-500/20 scale-105 shadow-[0_0_25px_rgba(99,102,241,0.3)]' : isAiSpeaking ? 'bg-blue-500/20' : 'bg-[#1e8e3e]/20'}`}>
                                    {/* Base static border */}
                                    <div className={`absolute inset-0 rounded-full border-2 transition-all duration-700 ${isAiThinking ? 'border-indigo-500/30' : isAiSpeaking ? 'border-blue-500/40' : 'border-[#1e8e3e]/40'}`}></div>
                                    
                                    {/* Sleek Processing Rings (Only visible when thinking) */}
                                    {isAiThinking && (
                                        <>
                                            <div className="absolute inset-[-6px] rounded-full border-2 border-transparent border-t-indigo-400 border-l-indigo-400 animate-spin opacity-80" style={{ animationDuration: '1.5s' }}></div>
                                            <div className="absolute inset-[-12px] rounded-full border border-transparent border-b-indigo-500/50 border-r-indigo-500/50 animate-spin opacity-50" style={{ animationDuration: '2.5s', animationDirection: 'reverse' }}></div>
                                        </>
                                    )}

                                    {/* Speaking Ripple (Hidden while thinking so it doesn't look messy) */}
                                    {!isAiThinking && (
                                        <div className={`absolute inset-0 rounded-full border-2 animate-ping ${isAiSpeaking ? 'border-blue-500/40' : 'border-[#1e8e3e]/40'}`} style={{ animationDuration: '2.5s' }}></div>
                                    )}
                                    
                                    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-colors duration-500 ${isAiThinking ? 'text-indigo-300' : isAiSpeaking ? 'text-[#8ab4f8]' : 'text-[#81c995]'}`}><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
                                </div>
                                <div className="text-sm font-medium text-slate-200">AI Proctor</div>
                            </div>
                            <div className={`absolute bottom-3 left-3 px-2 py-1 rounded text-xs text-white flex items-center gap-2 backdrop-blur-sm transition-all ${isAiSpeaking || isAiThinking ? 'bg-blue-600/90 shadow-[0_0_15px_rgba(37,99,235,0.8)]' : 'bg-black/50'}`}>
                                <div className={`w-1.5 h-1.5 rounded-full ${isAiSpeaking || isAiThinking ? 'bg-white animate-pulse' : 'bg-[#81c995]'}`}></div>
                                {isAiSpeaking ? 'Speaking...' : isAiThinking ? 'Thinking...' : 'Listening...'}
                            </div>
                            {/* Smooth CSS Audio Visualizer */}
                            <div className={`absolute bottom-3 right-3 flex items-end gap-1 h-6 transition-opacity duration-300 ${isAiSpeaking ? 'opacity-100' : 'opacity-0'}`}>
                                <div className={`w-1.5 bg-[#8ab4f8] rounded-t-full shadow-[0_0_8px_rgba(138,180,248,0.6)] ${isAiSpeaking ? 'audio-bar-1' : 'h-[6px]'}`}></div>
                                <div className={`w-1.5 bg-[#8ab4f8] rounded-t-full shadow-[0_0_8px_rgba(138,180,248,0.6)] ${isAiSpeaking ? 'audio-bar-2' : 'h-[6px]'}`}></div>
                                <div className={`w-1.5 bg-[#8ab4f8] rounded-t-full shadow-[0_0_8px_rgba(138,180,248,0.6)] ${isAiSpeaking ? 'audio-bar-3' : 'h-[6px]'}`}></div>
                                <div className={`w-1.5 bg-[#8ab4f8] rounded-t-full shadow-[0_0_8px_rgba(138,180,248,0.6)] ${isAiSpeaking ? 'audio-bar-4' : 'h-[6px]'}`}></div>
                                <div className={`w-1.5 bg-[#8ab4f8] rounded-t-full shadow-[0_0_8px_rgba(138,180,248,0.6)] ${isAiSpeaking ? 'audio-bar-5' : 'h-[6px]'}`}></div>
                            </div>
                        </div>

                        {/* Candidate feed */}
                        <div className="w-full max-w-[400px] xl:max-w-[480px] aspect-video bg-[#3c4043] rounded-xl relative overflow-hidden shadow-md border border-white/5">
                            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover mirror" />
                            <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover mirror pointer-events-none opacity-50" />
                            <div className={`absolute bottom-3 left-3 px-2 py-1 rounded text-xs text-white flex items-center gap-2 backdrop-blur-sm transition-all ${isCandidateSpeaking ? 'bg-blue-600/90 shadow-[0_0_15px_rgba(37,99,235,0.8)]' : 'bg-black/50'}`}>
                                {isCandidateSpeaking && <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div>}
                                You {isCandidateSpeaking ? '(Speaking...)' : ''}
                            </div>
                        </div>
                    </div>

                    {/* Bottom: Workspace */}
                    <div className="flex-1 bg-[#1e1f22] rounded-xl border border-white/10 shadow-md flex flex-col overflow-hidden">
                        <div className="bg-[#2b2d31] px-4 py-3 border-b border-white/5 flex items-center justify-between">
                            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[#8ab4f8]"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                                Technical Workspace
                            </div>
                            <div className="flex items-center gap-4">
                                {wpm > 0 && (
                                    <span className="text-[11px] text-slate-400 font-mono tracking-wider bg-[#121418] px-2 py-1 rounded border border-white/5 shadow-inner" title="Words Per Minute">{wpm} WPM</span>
                                )}
                                <select 
                                    value={language} 
                                    onChange={(e) => setLanguage(e.target.value)}
                                    className="bg-[#121418] text-xs text-slate-300 border border-white/10 rounded px-2 py-1 outline-none"
                                >
                                    <option value="javascript">JavaScript</option>
                                    <option value="python">Python</option>
                                    <option value="java">Java</option>
                                    <option value="cpp">C++</option>
                                    <option value="c">C</option>
                                    <option value="ruby">Ruby</option>
                                    <option value="go">Go</option>
                                </select>
                                <button onClick={runCode} className="text-[11px] font-bold tracking-wide uppercase bg-[#1e8e3e] hover:bg-[#188038] text-white px-3 py-1.5 rounded flex items-center gap-1 transition-colors shadow-sm">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                                    Run
                                </button>
                                <div className="flex gap-2">
                                    <div className="w-3 h-3 rounded-full bg-[#EA4335]"></div>
                                    <div className="w-3 h-3 rounded-full bg-[#FBBC04]"></div>
                                    <div className="w-3 h-3 rounded-full bg-[#34A853]"></div>
                                </div>
                            </div>
                        </div>
                        
                        {/* Split Pane: Code Editor Top, Terminal Bottom */}
                        <div className="flex-1 flex flex-col overflow-hidden">
                            <textarea 
                                className="flex-[2] p-5 bg-transparent text-[#a8c7fa] font-mono text-[14px] outline-none resize-none leading-relaxed placeholder:text-slate-600 border-b border-white/5"
                                placeholder="// Write your solution here..."
                                spellCheck="false"
                                value={code}
                                onChange={(e) => {
                                    setCode(e.target.value);
                                    if (currentPhase < 2 && e.target.value.length > 10) setCurrentPhase(2);
                                    
                                    // --- REAL-TIME TYPING SPEED CALCULATION ---
                                    if (!typingStartTimeRef.current) typingStartTimeRef.current = Date.now();
                                    keystrokeCountRef.current += 1;
                                    
                                    const elapsedMinutes = (Date.now() - typingStartTimeRef.current) / 60000;
                                    if (elapsedMinutes > 0.05) { // Only update after ~3 seconds to prevent erratic initial spikes
                                        setWpm(Math.round((keystrokeCountRef.current / 5) / elapsedMinutes));
                                    }
                                }}
                                onCopy={(e) => { e.preventDefault(); handleCheatAttempt("Code copying"); }}
                                onPaste={(e) => { e.preventDefault(); handleCheatAttempt("Code pasting"); }}
                            ></textarea>
                            
                            {/* Terminal Output */}
                            <div className="flex-1 bg-[#121418] p-4 font-mono text-[12px] overflow-y-auto relative">
                                <div className="absolute top-2 right-4 text-[10px] text-slate-500 uppercase tracking-wider font-bold">Terminal</div>
                                {terminalOutput.length === 0 ? (
                                    <div className="text-slate-600 italic mt-4">$ Waiting for execution...</div>
                                ) : (
                                    <div className="space-y-1.5 mt-2">
                                        {terminalOutput.map((out, idx) => (
                                            <div key={idx} className={`${out.type === 'system' ? 'text-slate-400' : out.type === 'error' ? 'text-rose-400' : 'text-[#81c995]'} whitespace-pre-wrap`}>
                                                {out.type !== 'system' && <span className="text-slate-500 mr-2">$ </span>}
                                                <span>{out.text}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Side: Chat Panel */}
                <div className="w-80 lg:w-96 bg-[#282a2d] rounded-xl border border-white/10 shadow-md flex flex-col overflow-hidden shrink-0">
                    <div className="p-4 border-b border-white/5 bg-[#282a2d] flex items-center justify-between">
                        <h2 className="text-sm font-medium text-white">In-call messages</h2>
                        <div className="px-2 py-1 bg-rose-500/10 text-rose-400 text-xs rounded font-medium border border-rose-500/20">
                            Warnings: {warningCount}
                        </div>
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto space-y-5">
                        <div className="text-center text-xs text-slate-500 bg-white/5 p-3 rounded-lg mb-4">
                            Messages are visible to the AI Proctor and recorded.
                        </div>
                        {messages.map((m, i) => {
                            if (m.sender === 'ai') {
                                const cleanFullText = m.text.replace(/^🗣️\s*/, '').replace(/\[.*?\]/g, '').replace(/[*_~`#]/g, '').trim();
                                const spokenLen = m.displayedText ? m.displayedText.length : 0;
                                
                                const spoken = cleanFullText.substring(0, spokenLen);
                                const unspoken = cleanFullText.substring(spokenLen);
                                const isStreamEmpty = cleanFullText.length === 0;

                                if (isStreamEmpty && isAiThinking) return null; // Let the dedicated thinking bubble handle this state

                                return (
                                    <div key={i} className="flex flex-col items-start transition-all duration-300">
                                        <div className="text-[11px] text-slate-400 mb-1 ml-1">AI Proctor</div>
                                        <div className="max-w-[90%] p-3 text-[13px] leading-relaxed shadow-sm bg-[#3c4043] rounded-2xl rounded-tl-sm transition-all duration-300 ease-out">
                                            {isStreamEmpty ? (
                                                <span className="animate-pulse text-slate-200">...</span>
                                            ) : (
                                                <>
                                                    <span className="text-slate-100">{spoken}</span>
                                                    <span className="text-slate-400">{unspoken}</span>
                                                    {unspoken.length > 0 && (
                                                        <span className="ml-1 inline-block w-1.5 h-3 bg-slate-400 animate-pulse align-middle"></span>
                                                    )}
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            } else {
                                return (
                                    <div key={i} className="flex flex-col items-end msg-enter">
                                        <div className="text-[11px] text-slate-400 mb-1 ml-1">You</div>
                                        <div className="max-w-[90%] p-3 text-[13px] leading-relaxed shadow-sm bg-[#8ab4f8] text-gray-900 rounded-2xl rounded-tr-sm font-medium">
                                            {m.text.replace(/^🗣️\s*/, '')}
                                        </div>
                                    </div>
                                );
                            }
                        })}
                        {isAiThinking && (
                            <div className="flex flex-col items-start msg-enter">
                                <div className="text-[11px] text-slate-400 mb-1 ml-1">AI Proctor</div>
                                <div className="max-w-[90%] px-4 py-3.5 shadow-sm bg-[#3c4043] text-slate-200 rounded-2xl rounded-tl-sm flex items-center gap-1.5">
                                    <div className="w-1.5 h-1.5 bg-[#8ab4f8] rounded-full dot-1"></div>
                                    <div className="w-1.5 h-1.5 bg-[#8ab4f8] rounded-full dot-2"></div>
                                    <div className="w-1.5 h-1.5 bg-[#8ab4f8] rounded-full dot-3"></div>
                                </div>
                            </div>
                        )}
                        {/* Live streaming text so the user sees their barge-in instantly */}
                        {interimTranscript && (
                            <div className="flex flex-col items-end msg-enter">
                                <div className="text-[11px] text-slate-400 mb-1 ml-1">You</div>
                                <div className="max-w-[90%] p-3 text-[13px] leading-relaxed shadow-sm bg-[#8ab4f8]/70 text-gray-900 rounded-2xl rounded-tr-sm font-medium italic opacity-80">
                                    {interimTranscript}
                                    <span className="ml-[2px] inline-block w-1.5 h-[1em] bg-gray-700 rounded-[1px] align-middle typing-cursor"></span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>
                    <form onSubmit={handleSend} className="p-4 bg-[#282a2d]">
                        <div className="relative flex items-center bg-[#3c4043] rounded-full border border-transparent focus-within:border-[#8ab4f8] transition-colors pr-2">
                            <input
                                value={input} onChange={e => setInput(e.target.value)}
                                className="w-full bg-transparent p-3 pl-5 text-sm text-white outline-none placeholder:text-slate-400"
                                placeholder="Send a message..."
                            />
                            <button type="submit" className={`p-2 rounded-full ${input.trim() ? 'bg-transparent text-[#8ab4f8] hover:bg-white/10' : 'text-slate-500 cursor-not-allowed'}`} disabled={!input.trim()}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                            </button>
                        </div>
                    </form>
                </div>
            </div>

            {/* Bottom Control Bar */}
            <div className="h-20 bg-[#202124] px-6 flex items-center justify-between shrink-0">
                {/* Left: Time & Info */}
                <div className="flex-1 flex items-center gap-4 text-sm font-medium text-white">
                    {currentTime} <span className="text-slate-500">|</span> Hire-Wire Assessment
                </div>

                {/* Center: Controls */}
                <div className="flex items-center justify-center gap-3">
                    <button onClick={toggleMic} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors text-white border border-white/5 ${isMuted ? 'bg-[#EA4335] hover:bg-[#D93025]' : 'bg-[#3c4043] hover:bg-[#4a4d51]'}`}>
                        {isMuted ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"></path><path d="M5 10v2a7 7 0 0 0 12 5l-1.5-1.5a5 5 0 0 1-9-3.5V10"></path><path d="M9 9v3a3 3 0 0 0 5.12 2.12l-1.5-1.5A1 1 0 0 1 11 12V9"></path></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
                        )}
                    </button>
                    <button onClick={toggleCam} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors text-white border border-white/5 ${isCamOff ? 'bg-[#EA4335] hover:bg-[#D93025]' : 'bg-[#3c4043] hover:bg-[#4a4d51]'}`}>
                        {isCamOff ? (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="2" y1="2" x2="22" y2="22"></line><path d="M21 21v-4a2 2 0 0 0-2-2h-3.32"></path><path d="m15.66 11.23-3.16-3.16a2 2 0 0 0-2.83 0l-4.83 4.83a2 2 0 0 0 0 2.83l3.16 3.16"></path></svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"></path><rect x="2" y="6" width="14" height="12" rx="2"></rect></svg>
                        )}
                    </button>
                    <button onClick={toggleScreenShare} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors text-white border border-white/5 ${isScreenSharing ? 'bg-[#8ab4f8] text-gray-900' : 'bg-[#3c4043] hover:bg-[#4a4d51]'}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v4"></path><path d="M14 10V4a2 2 0 0 0-4 0v6"></path><path d="M10 10.5V3a2 2 0 0 0-4 0v9"></path><path d="m7 15-1.76-1.76a2 2 0 0 0-2.83 2.82l3.6 3.6C7.5 21.14 9.2 22 12 22h2a8 8 0 0 0 8-8V7a2 2 0 1 0-4 0v5"></path></svg>
                    </button>
                    <button
                        onClick={handleEndInterview}
                        disabled={isFinalizing}
                        className={`h-10 ml-2 rounded-full flex items-center justify-center transition-all shadow-md text-white ${isFinalizing ? 'px-6 bg-amber-500 cursor-wait' : 'w-16 bg-[#EA4335] hover:bg-[#D93025]'}`}
                        title="Leave call"
                    >
                        {isFinalizing ? (
                            <div className="flex items-center gap-2 text-sm font-bold">
                                <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                Finalizing...
                            </div>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 2.6 3.4z"></path></svg>
                        )}
                    </button>
                </div>

                {/* Right: Info/Activities */}
                <div className="flex-1 flex justify-end items-center gap-4 text-slate-400">
                     <button className="hover:text-white transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>
                    </button>
                    <button className="hover:text-white transition-colors text-[#8ab4f8]">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                    </button>
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-[#1e8e3e]/20 text-[#81c995] font-bold text-xs border border-[#1e8e3e]/30">
                        AI
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MeetingRoom;