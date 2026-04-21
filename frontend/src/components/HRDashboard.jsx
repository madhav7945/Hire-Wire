import React, { useState, useMemo, useEffect } from 'react';

const HRDashboard = () => {
    const [selectedCandidate, setSelectedCandidate] = useState(null);
    const [email, setEmail] = useState('');
    const [role, setRole] = useState('');
    const [file, setFile] = useState(null);
    const [files, setFiles] = useState([]);
    const [bulkEmails, setBulkEmails] = useState([]);
    const [inviteMode, setInviteMode] = useState('single'); // 'single' or 'bulk'
    const [isScreening, setIsScreening] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useState('All');
    const [activeTab, setActiveTab] = useState('report'); // 'report', 'video', 'proctoring', 'judge'
    const [judgeInput, setJudgeInput] = useState({ score: '', notes: '' });
    const [draftedEmail, setDraftedEmail] = useState('');
    const [isDrafting, setIsDrafting] = useState(false);
    const [isSending, setIsSending] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const [candidates, setCandidates] = useState([]);

    // Fetch real candidates from MongoDB on load
    useEffect(() => {
        fetch('http://localhost:5000/api/candidates')
            .then(res => res.json())
            .then(data => {
                if (data.length > 0) setCandidates(data);
            })
            .catch(err => console.error("Failed to load candidates:", err));
    }, []);

    const filteredCandidates = useMemo(() => {
        return candidates.filter(c => {
            const matchesSearch = c.name.toLowerCase().includes(searchTerm.toLowerCase()) || c.email.toLowerCase().includes(searchTerm.toLowerCase()) || c.role.toLowerCase().includes(searchTerm.toLowerCase());
            const matchesStatus = filterStatus === 'All' || c.status === filterStatus;
            return matchesSearch && matchesStatus;
        });
    }, [candidates, searchTerm, filterStatus]);

    const handleUpload = async (e) => {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('email', email);
        formData.append('role', role);
        if (file) formData.append('resume', file);

        // 1. Call your new Backend API
        try {
            const response = await fetch('http://localhost:5000/api/invite', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();

            if (data.success) {
                // 2. If the email sent successfully, update the UI
                const newCandidate = {
                    id: data.id || Date.now(),
                    name: email.split('@')[0].replace('.', ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    email: email,
                    role: role || "Pending Assignment",
                    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    score: '--',
                    subScores: { logic: '--', syntax: '--', communication: '--' },
                    status: "Invite Sent",
                    flags: 0,
                    judgeScore: null,
                    judgeNotes: "",
                    analysis: { technical: "Pending completion...", coding: "Pending completion...", communication: "Pending completion...", proctoring: [] },
                    code: '',
                    language: 'javascript',
                    codeOutput: '',
                    videoUrl: null,
                    transcript: []
                };
                
                setCandidates([newCandidate, ...candidates]);
                setEmail('');
                setRole('');
                setFile(null);
                e.target.reset(); // Visually clears the file input
                
                alert(`Candidate registered successfully!\n\nFor testing, open this link in a new tab to join as the candidate:\n\n${data.link || 'http://localhost:5173/meeting/' + data.id}`);
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (error) {
            console.error("Connection error:", error);
            alert("Failed to connect to the backend server. Is it running on port 5000?");
        }
    };

    const handleBulkUpload = async (e) => {
        e.preventDefault();
        if (files.length === 0) return alert("Please select at least one resume.");
        if (files.length > 5) return alert("You can upload a maximum of 5 resumes at a time for comparative screening.");
        setIsScreening(true);
        
        const formData = new FormData();
        formData.append('role', role);
        files.forEach((f, index) => {
            formData.append('resumes', f);
            formData.append('emails', bulkEmails[index] || '');
        });

        try {
            const response = await fetch('http://localhost:5000/api/bulk-screen', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (data.success) {
                alert(`Successfully evaluated ${data.processed} resumes! The AI has shortlisted the top candidates.`);
                // Refresh Candidates
                const res = await fetch('http://localhost:5000/api/candidates');
                const cands = await res.json();
                if (cands.length > 0) setCandidates(cands);
                
                setFiles([]);
                setBulkEmails([]);
                setRole('');
                e.target.reset();
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (error) {
            console.error("Screening error:", error);
            alert("Failed to connect to the backend server.");
        } finally {
            setIsScreening(false);
        }
    };

    const handleSelectCandidate = async (c) => {
        setSelectedCandidate(c);
        setActiveTab('report');
        setJudgeInput({ score: c.judgeScore || '', notes: c.judgeNotes || '' });

        // Skip fetching the post-interview report if the candidate hasn't completed the interview yet.
        if (['Shortlisted', 'Invite Sent', 'In Progress'].includes(c.status) || (c.status === 'Rejected' && c.score === '--')) {
            return;
        }

        // Fetch the newly generated dynamic report from the backend
        try {
            const response = await fetch(`http://localhost:5000/api/report/${c.id}`);
            if (response.ok) {
                const realData = await response.json();
                
                // If the AI generated the analysis successfully, update the candidate's record
                if (realData.analysis) {
                    const updatedCandidate = {
                        ...c,
                        score: realData.score || c.score,
                        subScores: realData.subScores || c.subScores,
                        analysis: { ...c.analysis, ...realData.analysis },
                        status: ['Hired', 'Rejected', 'Reviewed'].includes(c.status) ? c.status : (realData.status || c.status),
                        videoUrl: realData.videoUrl || c.videoUrl,
                        transcript: realData.transcript || c.transcript
                    };
                    
                    setSelectedCandidate(updatedCandidate);
                    setCandidates(prev => prev.map(cand => cand.id === c.id ? updatedCandidate : cand));
                }
            }
        } catch (err) {
            console.error("Failed to fetch dynamic report:", err);
        }
    };

    const handleRefreshReport = async () => {
        if (!selectedCandidate) return;
        setIsRefreshing(true);
        try {
            const response = await fetch(`http://localhost:5000/api/report/${selectedCandidate.id}?force=true`);
            if (response.ok) {
                const realData = await response.json();
                
                if (realData.analysis) {
                    const updatedCandidate = {
                        ...selectedCandidate,
                        score: realData.score || selectedCandidate.score,
                        subScores: realData.subScores || selectedCandidate.subScores,
                        analysis: { ...selectedCandidate.analysis, ...realData.analysis },
                        status: ['Hired', 'Rejected', 'Reviewed'].includes(selectedCandidate.status) ? selectedCandidate.status : (realData.status || selectedCandidate.status),
                        videoUrl: realData.videoUrl || selectedCandidate.videoUrl,
                        transcript: realData.transcript || selectedCandidate.transcript
                    };
                    setSelectedCandidate(updatedCandidate);
                    setCandidates(prev => prev.map(cand => cand.id === selectedCandidate.id ? updatedCandidate : cand));
                }
            }
        } catch (err) {
            console.error("Failed to refresh dynamic report:", err);
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleApproveScreenedCandidate = async (targetCandidate = selectedCandidate) => {
        if (!targetCandidate) return;
        try {
            const response = await fetch(`http://localhost:5000/api/send-invite/${targetCandidate.id}`, {
                method: 'POST'
            });
            const data = await response.json();
            if (data.success) {
                alert(`Interview invite and meeting link automatically sent to ${data.candidate.email}!`);
                setCandidates(prev => prev.map(c => c.id === targetCandidate.id ? data.candidate : c));
                if (selectedCandidate?.id === targetCandidate.id) {
                    setSelectedCandidate(data.candidate);
                }
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (err) {
            console.error(err);
            alert("Failed to send invite to candidate.");
        }
    };

    const handleRejectScreenedCandidate = async (targetCandidate = selectedCandidate) => {
        if (!targetCandidate) return;
        if (!window.confirm(`Are you sure you want to reject ${targetCandidate.name}?`)) return;
        try {
            const response = await fetch(`http://localhost:5000/api/reject-invite/${targetCandidate.id}`, {
                method: 'POST'
            });
            const data = await response.json();
            if (data.success) {
                setCandidates(prev => prev.map(c => c.id === targetCandidate.id ? data.candidate : c));
                if (selectedCandidate?.id === targetCandidate.id) {
                    setSelectedCandidate(data.candidate);
                }
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (err) {
            console.error(err);
            alert("Failed to reject candidate.");
        }
    };

    const handleBulkApprove = async () => {
        const topCandidates = candidates.filter(c => c.status === 'Shortlisted');
        if (topCandidates.length === 0) return alert("No shortlisted candidates found.");
        if (!window.confirm(`Are you sure you want to automatically send interview invites to all ${topCandidates.length} shortlisted candidates?`)) return;
        
        let successCount = 0;
        for (const c of topCandidates) {
            try {
                const response = await fetch(`http://localhost:5000/api/send-invite/${c.id}`, { method: 'POST' });
                if (response.ok) successCount++;
            } catch (err) {
                console.error(err);
            }
        }
        alert(`Successfully sent ${successCount} interview invites!`);
        const res = await fetch('http://localhost:5000/api/candidates');
        const cands = await res.json();
        if (cands.length > 0) setCandidates(cands);
    };

    const handleJudgeDecision = async (decisionType) => {
        if (!selectedCandidate) return;

        const updatedStatus = decisionType === 'accept' ? 'Hired' : decisionType === 'reject' ? 'Rejected' : 'Reviewed';
        
        // Update the UI immediately
        const updatedCandidate = { 
            ...selectedCandidate, 
            status: updatedStatus,
            judgeScore: judgeInput.score,
            judgeNotes: judgeInput.notes
        };
        
        // Advanced: Use functional state update to prevent stale data issues
        setCandidates(prev => prev.map(c => c.id === selectedCandidate.id ? updatedCandidate : c));
        setSelectedCandidate(updatedCandidate);

        // If it's a final decision, trigger the AI Auto-Drafter
        if (['accept', 'reject'].includes(decisionType)) {
            setIsDrafting(true);
            setDraftedEmail('');
            
            try {
                const response = await fetch('http://localhost:5000/api/draft-email', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: updatedCandidate.name,
                        role: updatedCandidate.role,
                        decision: decisionType === 'accept' ? 'hire' : 'reject',
                        score: updatedCandidate.score,
                        notes: judgeInput.notes
                    })
                });
                
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                
                const data = await response.json();
                if (data.draft) setDraftedEmail(data.draft);
                else if (data.error) setDraftedEmail(`AI Error: ${data.error}`);
            } catch (err) {
                console.error("Drafting failed:", err);
                setDraftedEmail("Error connecting to AI drafter. Check if backend is running on port 5000.");
            } finally {
                setIsDrafting(false);
            }
        } else {
            // If just reviewing, send back to report tab
            setActiveTab('report');
        }
    };

    const handleSendEmail = async () => {
        if (!selectedCandidate || !draftedEmail) return;
        setIsSending(true);
        
        try {
            const response = await fetch('http://localhost:5000/api/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: selectedCandidate.email,
                    subject: selectedCandidate.status === 'Hired' ? `Offer: ${selectedCandidate.role} at Hire-Wire` : `Update on your application for ${selectedCandidate.role}`,
                    message: draftedEmail
                })
            });
            
            const data = await response.json();
            if (data.success) {
                alert(`Decision email successfully sent to ${selectedCandidate.email}!`);
            } else {
                alert(`Error sending email: ${data.error}`);
            }
        } catch (err) {
            console.error("Failed to send email:", err);
            alert("Connection error. Check if the backend is running on port 5000.");
        } finally {
            setIsSending(false);
        }
    };

    const handleDeleteCandidate = async (id) => {
        if (!window.confirm("Are you sure you want to completely delete this candidate's record? This cannot be undone.")) return;
        
        try {
            const response = await fetch(`http://localhost:5000/api/candidates/${id}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                // The WebSocket will automatically remove it from the UI, but we proactively clear the selection here
                if (selectedCandidate?.id === id) setSelectedCandidate(null);
                setCandidates(prev => prev.filter(c => c.id !== id));
            } else {
                // If it's a mock candidate (ID is a number), it will 404 on the backend, but we still want to clear it from the UI
                if (typeof id === 'number') {
                    if (selectedCandidate?.id === id) setSelectedCandidate(null);
                    setCandidates(prev => prev.filter(c => c.id !== id));
                } else {
                    alert("Failed to delete candidate.");
                }
            }
        } catch (err) {
            console.error("Delete error:", err);
            alert("Connection error. Check if the backend is running.");
        }
    };

    const handleCopyDraft = () => {
        navigator.clipboard.writeText(draftedEmail);
        alert("Draft copied to clipboard!");
    };

    return (
        <div className="min-h-screen bg-[#090a0c] text-slate-300 font-sans flex flex-col">
            
            {/* Header */}
            <header className="bg-[#121418] border-b border-white/5 px-8 py-4 flex items-center justify-between sticky top-0 z-50">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><polyline points="16 11 18 13 22 9"></polyline></svg>
                    </div>
                    <h1 className="text-xl font-extrabold text-white tracking-tight">
                        Hire<span className="text-blue-500">Wire</span> <span className="text-slate-600 font-normal ml-2">Command Center</span>
                    </h1>
                </div>
                <div className="flex items-center gap-4">
                    <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold border border-white/10 text-white cursor-pointer hover:bg-slate-700 transition-colors shadow-inner">
                        HR
                    </div>
                </div>
            </header>

            <div className="flex-1 p-8 grid grid-cols-1 xl:grid-cols-12 gap-8 max-w-[1600px] mx-auto w-full">
                
                {/* Left Area: Stats, Form, and Candidate List */}
                <div className="xl:col-span-7 flex flex-col gap-6 xl:h-[calc(100vh-8rem)] xl:sticky xl:top-[6rem]">
                    
                    {/* KPI Stats Row */}
                    <div className="grid grid-cols-3 gap-4 shrink-0">
                        <div className="bg-[#121418] rounded-xl p-5 border border-white/5 flex flex-col gap-1 relative overflow-hidden shadow-sm">
                            <div className="absolute top-0 right-0 w-16 h-16 bg-blue-500/10 rounded-bl-full -mr-4 -mt-4"></div>
                            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Total Candidates</span>
                            <span className="text-3xl font-bold text-white">{candidates.length}</span>
                        </div>
                        <div className="bg-[#121418] rounded-xl p-5 border border-white/5 flex flex-col gap-1 relative overflow-hidden shadow-sm">
                            <div className="absolute top-0 right-0 w-16 h-16 bg-emerald-500/10 rounded-bl-full -mr-4 -mt-4"></div>
                            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Avg. AI Score</span>
                            <span className="text-3xl font-bold text-emerald-400">69<span className="text-lg text-emerald-600/50">%</span></span>
                        </div>
                        <div className="bg-[#121418] rounded-xl p-5 border border-white/5 flex flex-col gap-1 relative overflow-hidden shadow-sm">
                            <div className="absolute top-0 right-0 w-16 h-16 bg-amber-500/10 rounded-bl-full -mr-4 -mt-4"></div>
                            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Security Flags</span>
                            <span className="text-3xl font-bold text-amber-400">{candidates.reduce((acc, c) => acc + c.flags, 0)}</span>
                        </div>
                    </div>

                    {/* Invite Section */}
                    <section className="bg-[#121418] p-5 rounded-xl border border-white/5 shadow-sm shrink-0">
                        <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
                            Sourcing & Screening
                        </h2>
                        
                        <div className="flex items-center gap-4 mb-4">
                            <button onClick={() => setInviteMode('single')} className={`text-xs font-semibold uppercase tracking-wider pb-1 border-b-2 transition-colors ${inviteMode === 'single' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>Direct Invite</button>
                            <button onClick={() => setInviteMode('bulk')} className={`text-xs font-semibold uppercase tracking-wider pb-1 border-b-2 transition-colors ${inviteMode === 'bulk' ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>Rank & Shortlist</button>
                        </div>

                        {inviteMode === 'single' ? (
                            <form onSubmit={handleUpload} className="flex flex-col gap-3">
                                <div className="flex flex-col md:flex-row gap-3">
                                    <div className="flex-1 w-full relative">
                                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500"><rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path></svg>
                                        </div>
                                        <input 
                                            type="email" 
                                            value={email}
                                            placeholder="Candidate Email Address"
                                            className="w-full bg-[#090a0c] border border-white/10 rounded-lg py-2.5 pl-9 pr-3 text-sm text-white focus:border-blue-500 outline-none transition-colors placeholder:text-slate-600"
                                            onChange={(e) => setEmail(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div className="flex-1 w-full relative">
                                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                                        </div>
                                        <input 
                                            type="text" 
                                            value={role}
                                            placeholder="Role (e.g. React Dev)"
                                            className="w-full bg-[#090a0c] border border-white/10 rounded-lg py-2.5 pl-9 pr-3 text-sm text-white focus:border-blue-500 outline-none transition-colors placeholder:text-slate-600"
                                            onChange={(e) => setRole(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div className="flex-1 w-full">
                                        <input 
                                            type="file" 
                                            accept=".pdf,.txt"
                                            className="w-full text-sm text-slate-400 file:mr-3 file:py-2.5 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-white/10 file:text-white hover:file:bg-white/20 cursor-pointer bg-[#090a0c] border border-white/10 rounded-lg outline-none transition-colors"
                                            onChange={(e) => {
                                                const selectedFile = e.target.files[0];
                                            if (selectedFile && selectedFile.size > 5 * 1024 * 1024) {
                                                alert("File size exceeds the 5MB limit. Please choose a smaller resume.");
                                                e.target.value = null;
                                                return;
                                            }
                                                setFile(selectedFile);
                                                if (selectedFile && !email) {
                                                    const formData = new FormData();
                                                    formData.append('resume', selectedFile);
                                                    fetch('http://localhost:5000/api/parse-resume-email', { method: 'POST', body: formData })
                                                        .then(res => res.json())
                                                        .then(data => {
                                                            if (data.email && data.email !== 'unknown@example.com') setEmail(prev => prev || data.email);
                                                        }).catch(console.error);
                                                }
                                            }}
                                            required
                                        />
                                    </div>
                                </div>
                                <button type="submit" className="w-full md:w-auto self-end bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 px-8 rounded-lg transition-colors text-sm shadow-md shadow-blue-500/10 flex items-center justify-center gap-2">
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                    Send Invite
                                </button>
                            </form>
                        ) : (
                            <form onSubmit={handleBulkUpload} className="flex flex-col gap-3">
                                <div className="flex flex-col md:flex-row gap-3">
                                    <div className="flex-1 w-full relative">
                                        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-500"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                                        </div>
                                        <input 
                                            type="text" 
                                            value={role}
                                            placeholder="Target Role (e.g. Full Stack)"
                                            className="w-full bg-[#090a0c] border border-white/10 rounded-lg py-2.5 pl-9 pr-3 text-sm text-white focus:border-blue-500 outline-none transition-colors placeholder:text-slate-600"
                                            onChange={(e) => setRole(e.target.value)}
                                            required
                                        />
                                    </div>
                                    <div className="flex-[2] w-full">
                                        <input 
                                            type="file" 
                                            multiple
                                            max="5"
                                            accept=".pdf,.txt"
                                            className="w-full text-sm text-slate-400 file:mr-3 file:py-2.5 file:px-4 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-white/10 file:text-white hover:file:bg-white/20 cursor-pointer bg-[#090a0c] border border-white/10 rounded-lg outline-none transition-colors"
                                            onChange={(e) => {
                                                const selectedFiles = Array.from(e.target.files);
                                                setFiles(selectedFiles);
                                                setBulkEmails(selectedFiles.map(() => ''));
                                                
                                                selectedFiles.forEach(async (file, index) => {
                                                    const formData = new FormData();
                                                    formData.append('resume', file);
                                                    try {
                                                        const res = await fetch('http://localhost:5000/api/parse-resume-email', {
                                                            method: 'POST',
                                                            body: formData
                                                        });
                                                        const data = await res.json();
                                                        if (data.email && data.email !== 'unknown@example.com') {
                                                            setBulkEmails(prev => {
                                                                const newEmails = [...prev];
                                                                if (!newEmails[index]) newEmails[index] = data.email;
                                                                return newEmails;
                                                            });
                                                        }
                                                    } catch (err) {
                                                        console.error("Auto-extract failed", err);
                                                    }
                                                });
                                            }}
                                            required
                                        />
                                        {files.length > 0 && (
                                            <div className="flex flex-col gap-2 mt-3 bg-[#090a0c] p-3 rounded-lg border border-white/5 max-h-48 overflow-y-auto">
                                                <div className="text-[10px] font-bold text-slate-500 mb-1 uppercase tracking-wider">Candidate Emails (Auto-Extracted)</div>
                                                {files.map((f, i) => (
                                                    <div key={i} className="flex items-center gap-3">
                                                        <span className="text-xs text-slate-400 w-1/3 truncate" title={f.name}>{f.name}</span>
                                                        <input
                                                            type="email"
                                                            placeholder="Extracting via AI..."
                                                            value={bulkEmails[i]}
                                                            onChange={(e) => { const newEmails = [...bulkEmails]; newEmails[i] = e.target.value; setBulkEmails(newEmails); }}
                                                            className="flex-1 bg-[#121418] border border-white/10 rounded py-1.5 px-3 text-xs text-white focus:border-blue-500 outline-none transition-colors"
                                                        />
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <button type="submit" disabled={isScreening} className="w-full md:w-auto self-end bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 px-8 rounded-lg transition-colors text-sm shadow-md shadow-blue-500/10 flex items-center justify-center gap-2 disabled:opacity-50">
                                    {isScreening ? (
                                        <><svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Analyzing Resumes...</>
                                    ) : (
                                        <><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg> AI Bulk Screen</>
                                    )}
                                </button>
                            </form>
                        )}
                    </section>

                    {/* Candidates List Filters */}
                    <div className="flex flex-col md:flex-row md:items-center justify-between mt-2 gap-4 shrink-0">
                        <div className="flex gap-2">
                            {['All', 'Shortlisted', 'Invite Sent', 'Pending Review', 'Reviewed', 'Hired', 'Rejected'].map(status => (
                                <button 
                                    key={status} 
                                    onClick={() => setFilterStatus(status)}
                                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${filterStatus === status ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-[#121418] text-slate-400 border-white/5 hover:bg-white/5'}`}
                                >
                                    {status}
                                </button>
                            ))}
                            <button 
                                onClick={handleBulkApprove}
                                className="px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-colors border border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 flex items-center gap-1.5 ml-2 shadow-sm"
                                title="Auto-Invite all shortlisted candidates"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"></path><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                Auto-Invite Shortlisted
                            </button>
                        </div>
                        <div className="relative">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
                            <input 
                                type="text" 
                                placeholder="Search roster..." 
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="bg-[#121418] border border-white/5 rounded-full pl-9 pr-4 py-2 text-sm text-white focus:border-blue-500 outline-none w-full md:w-64 transition-colors placeholder:text-slate-600"
                            />
                        </div>
                    </div>

                    {/* Candidate List */}
                    <section className="flex flex-col gap-3 flex-1 overflow-y-auto pr-2 pb-4 scrollbar-hide">
                        
                        {/* ACTION REQUIRED: Dedicated Shortlisted Queue */}
                        {candidates.some(c => c.status === 'Shortlisted') && (filterStatus === 'All' || filterStatus === 'Shortlisted') && (
                            <div className="mb-2 bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 shrink-0">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-sm font-bold text-purple-400 flex items-center gap-2">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                                        Shortlisted Queue (Action Required)
                                    </h3>
                                </div>
                                <div className="flex flex-col gap-2">
                                    {filteredCandidates.filter(c => c.status === 'Shortlisted').map(c => (
                                        <div key={`shortlist-${c.id}`} className="bg-[#121418] p-3 rounded-lg border border-purple-500/30 flex items-center justify-between hover:border-purple-500/50 transition-colors shadow-sm">
                                            <div className="flex items-center gap-3 cursor-pointer flex-1" onClick={() => handleSelectCandidate(c)}>
                                                <div className="w-8 h-8 rounded-full bg-purple-600/20 text-purple-400 flex items-center justify-center font-bold text-xs border border-purple-500/20">
                                                    {c.name.charAt(0)}
                                                </div>
                                                <div>
                                                    <div className="text-sm font-semibold text-white">{c.name}</div>
                                                    <div className="text-xs text-slate-400">{c.role} <span className="mx-1">•</span> CV Score: <span className="text-purple-400 font-bold">{c.resumeScore || '--'}</span></div>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 ml-4 shrink-0">
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleRejectScreenedCandidate(c); }}
                                                    className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 text-xs font-bold py-2 px-3 rounded-lg transition-colors shadow-sm flex items-center gap-1.5"
                                                    title="Reject Candidate"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                                    Reject
                                                </button>
                                                <button 
                                                    onClick={(e) => { e.stopPropagation(); handleApproveScreenedCandidate(c); }}
                                                    className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2 px-4 rounded-lg transition-colors shadow-md flex items-center gap-2"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                                    Send Meeting Link
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {filteredCandidates.map(c => {
                            // Avoid duplication with the separated queue above
                            if ((filterStatus === 'All' || filterStatus === 'Shortlisted') && c.status === 'Shortlisted') return null;

                            const isCvPhase = c.score === '--' && c.resumeScore != null;
                            const displayScore = isCvPhase ? c.resumeScore : c.score;
                            const scoreLabel = isCvPhase ? 'CV Score' : 'AI Score';
                            return (
                                <div 
                                key={c.id} 
                                onClick={() => handleSelectCandidate(c)}
                                className={`bg-[#121418] p-4 rounded-xl border cursor-pointer transition-all flex items-center justify-between group hover:shadow-lg ${selectedCandidate?.id === c.id ? 'border-blue-500 shadow-blue-900/10 shadow-lg' : 'border-white/5 hover:border-white/20'}`}
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`w-11 h-11 rounded-full flex items-center justify-center font-bold text-sm shadow-inner ${selectedCandidate?.id === c.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300'}`}>
                                        {c.name.charAt(0)}
                                    </div>
                                    <div>
                                        <div className="font-semibold text-white group-hover:text-blue-400 transition-colors flex items-center gap-2">
                                            {c.name}
                                                {c.status === 'Shortlisted' && <span className="bg-purple-500/20 text-purple-300 text-[10px] px-2 py-0.5 rounded border border-purple-500/30 tracking-wider">SHORTLISTED</span>}
                                            {c.status === 'Hired' && <span className="bg-[#1e8e3e]/20 text-[#81c995] text-[10px] px-2 py-0.5 rounded border border-[#1e8e3e]/30 tracking-wider">HIRED</span>}
                                            {c.status === 'Rejected' && <span className="bg-[#ea4335]/20 text-[#f28b82] text-[10px] px-2 py-0.5 rounded border border-[#ea4335]/30 tracking-wider">REJECTED</span>}
                                        </div>
                                        <div className="text-xs text-slate-500 flex items-center gap-2 mt-1">
                                            {c.role} <span className="w-1 h-1 rounded-full bg-slate-700"></span> {c.date} <span className="w-1 h-1 rounded-full bg-slate-700"></span> {c.status}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-6">
                                    <div className="flex flex-col items-end">
                                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Security</span>
                                        {c.flags === 0 ? (
                                            <span className="text-xs font-medium text-emerald-400 flex items-center gap-1 mt-0.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-400"></div>Clean</span>
                                        ) : (
                                            <span className="text-xs font-medium text-amber-400 flex items-center gap-1 mt-0.5"><div className="w-1.5 h-1.5 rounded-full bg-amber-400"></div>{c.flags} Flags</span>
                                        )}
                                    </div>
                                    <div className="flex flex-col items-end w-16">
                                        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">{scoreLabel}</span>
                                        <span className={`text-lg font-bold mt-0.5 ${displayScore >= 80 ? 'text-emerald-400' : displayScore >= 60 ? 'text-amber-400' : displayScore === '--' ? 'text-slate-500' : 'text-rose-400'}`}>
                                            {displayScore}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            );
                        })}
                        {filteredCandidates.length === 0 && (
                            <div className="text-center py-12 text-slate-500 text-sm bg-[#121418] rounded-xl border border-white/5">
                                No candidates match your current filters.
                            </div>
                        )}
                    </section>
                </div>

                {/* Right Area: Deep Analysis & Judge Panel */}
                <div className="xl:col-span-5 bg-[#121418] rounded-xl border border-white/5 shadow-xl h-[calc(100vh-8rem)] xl:sticky xl:top-[6rem] flex flex-col overflow-hidden">
                    {selectedCandidate ? (
                        (() => {
                            const isCvPhase = selectedCandidate.score === '--' && selectedCandidate.resumeScore != null;
                            const activeScore = isCvPhase ? selectedCandidate.resumeScore : selectedCandidate.score;
                            const activeLabel = isCvPhase ? 'CV Score' : 'AI Score';
                            return (
                        <div className="flex flex-col h-full animate-fade-in">
                            
                            {/* Header */}
                            <div className="p-6 border-b border-white/5 bg-[#17191e] shrink-0">
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <h2 className="text-2xl font-bold text-white tracking-tight mb-1">{selectedCandidate.name}</h2>
                                        <a href={`mailto:${selectedCandidate.email}`} className="text-sm text-blue-400 hover:text-blue-300 transition-colors">{selectedCandidate.email}</a>
                                    </div>
                                    <div className="flex flex-col items-end gap-2">
                                        <div className="flex items-center gap-2">
                                            <button 
                                                onClick={() => handleDeleteCandidate(selectedCandidate.id)}
                                                className="px-2 py-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 text-xs rounded border border-rose-500/20 transition-colors flex items-center gap-1.5 mr-2"
                                                title="Delete Candidate"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                                            </button>
                                            {activeTab === 'report' && (
                                                <button 
                                                    onClick={handleRefreshReport}
                                                    disabled={isRefreshing}
                                                    className="px-3 py-1 bg-[#121418] hover:bg-slate-800 text-slate-400 text-xs rounded-full border border-white/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                                >
                                                    <svg className={isRefreshing ? "animate-spin" : ""} xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                                                    {isRefreshing ? 'Refreshing...' : 'Refresh AI Report'}
                                                </button>
                                            )}
                                            <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border ${activeScore >= 80 ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : activeScore >= 60 ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : activeScore == null || activeScore === '--' ? 'bg-slate-500/10 border-slate-500/20 text-slate-400' : 'bg-rose-500/10 border-rose-500/20 text-rose-400'}`}>
                                                {activeLabel}: {activeScore || '--'}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 mt-1">
                                            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">Meeting Room</span>
                                            <button 
                                                onClick={() => {
                                                    navigator.clipboard.writeText(`http://localhost:5173/meeting/${selectedCandidate.id}`);
                                                    alert("Meeting link copied to clipboard!");
                                                }}
                                                className="flex items-center gap-1.5 px-2 py-1 bg-white/5 hover:bg-white/10 text-slate-300 text-[10px] font-bold uppercase tracking-wider rounded transition-colors border border-white/10"
                                                title="Copy Meeting Link"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                                Copy Link
                                            </button>
                                        </div>
                                        {selectedCandidate.judgeScore && (
                                            <div className="px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest border bg-blue-500/10 border-blue-500/20 text-blue-400">
                                                Judge: {selectedCandidate.judgeScore}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                
                                {/* Navigation Tabs */}
                                <div className="flex gap-6 mt-6">
                                    {[
                                        { id: 'report', label: 'AI Report' },
                                        { id: 'transcript', label: 'Transcript' },
                                        { id: 'code', label: 'Code Snippet' },
                                        { id: 'video', label: 'Video Tape' },
                                        { id: 'proctoring', label: `Logs ${selectedCandidate.flags > 0 ? `(${selectedCandidate.flags})` : ''}` },
                                        ...(['Invite Sent', 'In Progress', 'Shortlisted'].includes(selectedCandidate.status) || isCvPhase
                                            ? [] 
                                            : [{ id: 'judge', label: 'Judge Evaluation' }])
                                    ].map(tab => (
                                        <button 
                                            key={tab.id}
                                            onClick={() => setActiveTab(tab.id)} 
                                            className={`pb-3 text-sm font-medium transition-all relative ${activeTab === tab.id ? 'text-blue-400' : 'text-slate-500 hover:text-slate-300'}`}
                                        >
                                            {tab.label}
                                            {activeTab === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t-full shadow-[0_-2px_8px_rgba(59,130,246,0.5)]"></div>}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            
                            {/* Scrollable Content Area */}
                            <div className="flex-1 overflow-y-auto p-6 scrollbar-hide">
                                
                                {activeTab === 'report' && (
                                    isCvPhase ? (
                                        <div className="space-y-6 animate-fade-in bg-[#121418] p-6 rounded-xl border border-white/5 text-center flex flex-col items-center justify-center min-h-[60%]">
                                            <div className={`w-20 h-20 rounded-full flex items-center justify-center text-3xl font-bold mx-auto mb-2 border ${['Shortlisted', 'Invite Sent', 'In Progress', 'Reviewed', 'Pending Review', 'Hired'].includes(selectedCandidate.status) ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' : 'bg-rose-500/20 text-rose-400 border-rose-500/30'}`}>
                                                {selectedCandidate.resumeScore || '--'}
                                            </div>
                                            <h3 className="text-xl font-bold text-white mb-4">
                                                {selectedCandidate.status === 'Shortlisted' ? 'Candidate Shortlisted by AI' : 
                                                 selectedCandidate.status === 'Rejected' ? 'Candidate Rejected by AI (Low Match)' : 
                                                 'Interview Invite Sent'}
                                            </h3>
                                            <p className="text-sm text-slate-300 leading-relaxed bg-[#090a0c] p-6 rounded-lg text-left shadow-inner border border-white/5 max-w-2xl">
                                                {selectedCandidate.resumeAnalysis || "No preliminary analysis available."}
                                            </p>
                                            {selectedCandidate.status === 'Shortlisted' && (
                                            <div className="mt-8 flex items-center justify-center gap-4">
                                                <button 
                                                    onClick={() => handleRejectScreenedCandidate()}
                                                    className="bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 font-bold py-3.5 px-6 rounded-xl transition-all text-sm flex items-center gap-2"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                                    Reject
                                                </button>
                                                <button 
                                                    onClick={() => handleApproveScreenedCandidate()}
                                                    className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 px-8 rounded-xl transition-all text-sm shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                                                >
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                                    Approve & Send Interview Invite
                                                </button>
                                            </div>
                                            )}
                                            {['Invite Sent', 'In Progress'].includes(selectedCandidate.status) && (
                                            <button 
                                                onClick={() => {
                                                    navigator.clipboard.writeText(`http://localhost:5173/meeting/${selectedCandidate.id}`);
                                                    alert("Meeting link copied to clipboard!");
                                                }}
                                                className="mt-8 bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 border border-emerald-500/30 font-bold py-3.5 px-8 rounded-xl transition-all text-sm shadow-lg shadow-emerald-500/10 flex items-center justify-center gap-2"
                                            >
                                                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                                Copy Meeting Link
                                            </button>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="space-y-8 animate-fade-in">
                                        {/* Sub-scores Visual Bars */}
                                        <div className="space-y-5">
                                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-2">Performance Breakdown</h3>
                                            {Object.entries(selectedCandidate.subScores).map(([key, val]) => (
                                                <div key={key}>
                                                    <div className="flex justify-between text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                                                        <span>{key}</span>
                                                        <span className="text-white">{val}{val !== '--' && '%'}</span>
                                                    </div>
                                                    <div className="w-full bg-[#090a0c] h-2.5 rounded-full overflow-hidden border border-white/5 shadow-inner">
                                                        <div 
                                                            className={`h-full rounded-full transition-all duration-1000 ${val >= 80 ? 'bg-gradient-to-r from-emerald-600 to-emerald-400' : val >= 60 ? 'bg-gradient-to-r from-amber-600 to-amber-400' : val === '--' ? 'bg-slate-700' : 'bg-gradient-to-r from-rose-600 to-rose-400'}`}
                                                            style={{ width: `${val === '--' ? 0 : val}%` }}
                                                        ></div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>

                                        <div className="space-y-6 pt-4 border-t border-white/5">
                                            <div>
                                                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-500"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
                                                    Technical Analysis
                                                </h3>
                                                <p className="text-sm leading-relaxed text-slate-300 bg-[#090a0c] p-4 rounded-lg border border-white/5 shadow-sm">{selectedCandidate.analysis.technical}</p>
                                            </div>
                                            
                                            <div>
                                                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                                                    Coding & Algorithm Execution
                                                </h3>
                                                <p className="text-sm leading-relaxed text-slate-300 bg-[#090a0c] p-4 rounded-lg border border-white/5 shadow-sm">{selectedCandidate.analysis.coding || "No coding analysis provided."}</p>
                                            </div>
                                            
                                            <div>
                                                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3 flex items-center gap-2">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                                    Communication & Soft Skills
                                                </h3>
                                                <p className="text-sm leading-relaxed text-slate-300 bg-[#090a0c] p-4 rounded-lg border border-white/5 shadow-sm">{selectedCandidate.analysis.communication}</p>
                                            </div>
                                        </div>
                                    </div>
                                    )
                                )}

                                {activeTab === 'transcript' && (
                                    <div className="space-y-4 animate-fade-in flex flex-col h-full">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Interview Transcript</h3>
                                        </div>
                                        <div className="flex-1 bg-[#1e1f22] rounded-xl border border-white/10 shadow-md p-4 overflow-y-auto space-y-4 min-h-[400px]">
                                            {selectedCandidate.transcript && selectedCandidate.transcript.length > 0 ? (
                                                selectedCandidate.transcript.map((msg, idx) => (
                                                    <div key={idx} className={`flex flex-col ${msg.sender === 'ai' ? 'items-start' : 'items-end'}`}>
                                                        <div className="text-[11px] text-slate-400 mb-1 ml-1">{msg.sender === 'ai' ? 'AI Proctor' : 'Candidate'}</div>
                                                        <div className={`max-w-[90%] p-3 text-[13px] leading-relaxed shadow-sm rounded-2xl ${msg.sender === 'ai' ? 'bg-[#3c4043] text-slate-200 rounded-tl-sm' : 'bg-[#8ab4f8] text-gray-900 rounded-tr-sm font-medium'}`}>
                                                            {msg.text.replace(/^🗣️\s*/, '')}
                                                        </div>
                                                    </div>
                                                ))
                                            ) : (
                                                <div className="flex flex-col items-center justify-center py-16 text-slate-500">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mb-3 opacity-50"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                                                    <p className="text-sm font-medium">Transcript is not available yet.</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'code' && (
                                    <div className="space-y-4 animate-fade-in flex flex-col h-full">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Candidate Code ({selectedCandidate.language || 'javascript'})</h3>
                                        </div>
                                        <div className="flex-1 bg-[#1e1f22] rounded-xl border border-white/10 shadow-md flex flex-col overflow-hidden min-h-[400px]">
                                            <div className="bg-[#2b2d31] px-4 py-3 border-b border-white/5 flex items-center justify-between">
                                                <div className="text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                                                    {selectedCandidate.language || 'javascript'}
                                                </div>
                                            </div>
                                            <textarea 
                                                className="flex-1 p-5 bg-transparent text-[#a8c7fa] font-mono text-[14px] outline-none resize-none leading-relaxed"
                                                value={selectedCandidate.code || '// No code written yet.'}
                                                readOnly
                                            ></textarea>
                                        </div>
                                        <div className="flex items-center justify-between mt-2">
                                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Last Execution Output</h3>
                                        </div>
                                        <div className="bg-[#121418] rounded-xl border border-white/10 shadow-md p-4 min-h-[120px] font-mono text-sm overflow-y-auto whitespace-pre-wrap">
                                            {selectedCandidate.codeOutput ? (
                                                <span className={selectedCandidate.codeOutput.toLowerCase().includes('error') ? 'text-rose-400' : 'text-[#81c995]'}>
                                                    {selectedCandidate.codeOutput}
                                                </span>
                                            ) : (
                                                <span className="text-slate-600 italic">No output recorded yet.</span>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'video' && (
                                    <div className="space-y-4 animate-fade-in flex flex-col h-full">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500">Session Recording</h3>
                                        </div>
                                        <div className="w-full aspect-video bg-black rounded-xl border border-white/10 flex flex-col items-center justify-center relative overflow-hidden shadow-lg">
                                            {selectedCandidate.videoUrl ? (
                                                <video 
                                                    src={selectedCandidate.videoUrl} 
                                                    controls 
                                                    controlsList="nodownload"
                                                    className="w-full h-full object-contain outline-none"
                                                >
                                                    Your browser does not support the video tag.
                                                </video>
                                            ) : (
                                                <div className="flex flex-col items-center text-slate-500">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4 opacity-50"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>
                                                    <p className="text-sm font-medium">Video recording is processing or unavailable.</p>
                                                    <p className="text-xs mt-2 max-w-sm text-center">Interviews are uploaded in the background. If the candidate just finished, check back in a minute.</p>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {activeTab === 'proctoring' && (
                                    <div className="space-y-4 animate-fade-in">
                                        {Array.isArray(selectedCandidate.analysis?.proctoring) && selectedCandidate.analysis.proctoring.length > 0 ? (
                                            <div className="relative border-l border-slate-700 ml-3 space-y-8 pb-4 mt-2">
                                                {selectedCandidate.analysis.proctoring.map((event, idx) => (
                                                    <div key={idx} className="relative pl-6">
                                                        <div className={`absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full ring-4 ring-[#121418] ${event.severity === 'high' ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]' : 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.8)]'}`}></div>
                                                        <div className="text-xs font-mono text-slate-500 mb-1">{event.time || 'System Event'}</div>
                                                        <div className={`text-sm ${event.severity === 'high' ? 'text-rose-400 font-medium' : 'text-slate-300'}`}>{event.event || event}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : selectedCandidate.flags > 0 ? (
                                            <div className="relative border-l border-slate-700 ml-3 space-y-8 pb-4 mt-2">
                                                <div className="relative pl-6">
                                                    <div className="absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full ring-4 ring-[#121418] bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]"></div>
                                                    <div className="text-xs font-mono text-slate-500 mb-1">System Log</div>
                                                    <div className="text-sm text-rose-400 font-medium">{selectedCandidate.flags} System behavior warning(s) triggered during session.</div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex flex-col items-center justify-center py-16 text-emerald-500 bg-[#090a0c] rounded-xl border border-white/5">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mb-3 opacity-80"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"></path><path d="m9 12 2 2 4-4"></path></svg>
                                                <p className="text-sm font-medium">No proctoring flags detected. Session secure.</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activeTab === 'judge' && (
                                    <div className="space-y-6 animate-fade-in bg-[#090a0c] p-6 rounded-xl border border-white/5">
                                        {['Invite Sent', 'In Progress'].includes(selectedCandidate.status) ? (
                                            <div className="flex flex-col items-center justify-center py-10 text-slate-400 text-center">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mb-4 opacity-50"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                                                <p className="text-sm font-medium text-slate-300">Interview not yet completed</p>
                                                <p className="text-xs mt-2 max-w-sm">The judge panel will unlock automatically once the AI Protor finishes the interview and generates the candidate's analysis report.</p>
                                            </div>
                                        ) : (
                                            <>
                                                <div>
                                                    <label className="text-xs font-bold uppercase tracking-widest text-slate-400 block mb-3">Final Judge Score (0-100)</label>
                                                    <div className="flex items-center gap-4">
                                                <input 
                                                    type="range" min="0" max="100" 
                                                    value={judgeInput.score} 
                                                    onChange={(e) => setJudgeInput({...judgeInput, score: e.target.value})}
                                                    className="flex-1 accent-blue-500"
                                                    disabled={['Hired', 'Rejected'].includes(selectedCandidate.status)}
                                                />
                                                <div className="w-16 bg-[#121418] border border-white/10 rounded-lg p-2 text-center text-lg font-bold text-white shadow-inner">
                                                    {judgeInput.score || '--'}
                                                </div>
                                            </div>
                                        </div>
                                        <div>
                                            <label className="text-xs font-bold uppercase tracking-widest text-slate-400 block mb-3">Manual Verdict Notes</label>
                                            <textarea 
                                                value={judgeInput.notes}
                                                onChange={(e) => setJudgeInput({...judgeInput, notes: e.target.value})}
                                                placeholder="Enter detailed feedback on this candidate's performance..."
                                                className="w-full bg-[#121418] border border-white/10 rounded-lg p-4 text-sm text-slate-300 outline-none focus:border-blue-500 transition-colors min-h-[160px] resize-y shadow-inner disabled:opacity-50"
                                                disabled={['Hired', 'Rejected'].includes(selectedCandidate.status)}
                                            ></textarea>
                                        </div>
                                        {['Hired', 'Rejected'].includes(selectedCandidate.status) ? (
                                            <div className="pt-4 border-t border-white/5">
                                                <div className="bg-[#121418] border border-white/10 rounded-lg p-4 text-center flex flex-col items-center justify-center gap-2">
                                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center ${selectedCandidate.status === 'Hired' ? 'bg-[#1e8e3e]/20 text-[#81c995]' : 'bg-[#d93025]/20 text-[#f28b82]'}`}>
                                                        {selectedCandidate.status === 'Hired' ? (
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                                        ) : (
                                                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                                        )}
                                                    </div>
                                                    <p className="text-sm font-bold text-white uppercase tracking-wider">Candidate {selectedCandidate.status}</p>
                                                    <p className="text-xs text-slate-400">The final verdict has been recorded and locked.</p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="flex gap-3 pt-4 border-t border-white/5">
                                                <button onClick={() => handleJudgeDecision('accept')} className="flex-1 bg-[#1e8e3e] hover:bg-[#188038] text-white py-3 rounded-lg text-sm font-bold transition-all shadow-lg shadow-emerald-900/20 flex justify-center items-center gap-2">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                                                    Save & Hire
                                                </button>
                                                <button onClick={() => handleJudgeDecision('review')} className="flex-1 bg-slate-700 hover:bg-slate-600 text-white py-3 rounded-lg text-sm font-bold transition-all shadow-md flex justify-center items-center gap-2">
                                                    Save Draft
                                                </button>
                                                <button onClick={() => handleJudgeDecision('reject')} className="flex-1 bg-[#d93025] hover:bg-[#c5221f] text-white py-3 rounded-lg text-sm font-bold transition-all shadow-lg shadow-rose-900/20 flex justify-center items-center gap-2">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                                    Save & Reject
                                                </button>
                                            </div>
                                        )}

                                        {/* AI Drafted Email Section */}
                                        {(isDrafting || draftedEmail) && (
                                            <div className="mt-8 pt-6 border-t border-white/10 animate-fade-in">
                                                <div className="flex items-center justify-between mb-3">
                                                    <h3 className="text-xs font-bold uppercase tracking-widest text-blue-400 flex items-center gap-2">
                                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={isDrafting ? "animate-spin" : ""}><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="M4.93 4.93l2.83 2.83"></path><path d="M16.24 16.24l2.83 2.83"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><path d="M4.93 19.07l2.83-2.83"></path><path d="M16.24 7.76l2.83-2.83"></path></svg>
                                                        {isDrafting ? 'AI is drafting response...' : 'AI Drafted Communication'}
                                                    </h3>
                                                    {!isDrafting && draftedEmail && (
                                                        <div className="flex items-center gap-2">
                                                            <button 
                                                                onClick={handleSendEmail}
                                                                disabled={isSending}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[10px] font-bold uppercase tracking-wider rounded transition-colors border border-emerald-500/20 disabled:opacity-50"
                                                                title="Send Email to Candidate"
                                                            >
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                                                {isSending ? 'Sending...' : 'Send to Candidate'}
                                                            </button>
                                                            <button 
                                                                onClick={handleCopyDraft}
                                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 text-[10px] font-bold uppercase tracking-wider rounded transition-colors border border-blue-500/20"
                                                                title="Copy to clipboard"
                                                            >
                                                                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                                                                Copy Draft
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="bg-[#121418] border border-blue-500/20 rounded-lg p-5 relative shadow-inner group">
                                                    {isDrafting ? (
                                                        <div className="flex flex-col gap-3">
                                                            <div className="flex items-center gap-3 text-blue-400/80 text-sm mb-2">
                                                                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                                                                Groq AI is analyzing notes and drafting the official letter...
                                                            </div>
                                                            <div className="h-4 bg-slate-700/50 rounded w-3/4 animate-pulse"></div>
                                                            <div className="h-4 bg-slate-700/50 rounded w-full animate-pulse"></div>
                                                            <div className="h-4 bg-slate-700/50 rounded w-5/6 animate-pulse"></div>
                                                        </div>
                                                    ) : (
                                                        <textarea 
                                                            className="w-full bg-transparent text-slate-300 text-sm leading-relaxed outline-none resize-y min-h-[200px] focus:text-white transition-colors"
                                                            value={draftedEmail}
                                                            onChange={(e) => setDraftedEmail(e.target.value)}
                                                            placeholder="AI drafted email will appear here..."
                                                        />
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                            );
                        })()
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center text-slate-500 text-center p-12">
                            <svg className="w-12 h-12 mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                            <p className="text-sm max-w-sm">Select a candidate from the roster to view their deep analysis, meeting recording, and submit a final verdict.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default HRDashboard;