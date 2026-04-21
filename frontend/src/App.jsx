import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HRDashboard from './components/HRDashboard';
import MeetingRoom from './components/MeetingRoom'; 

function App() {
  return (
    <Router>
      {/* This container ensures the background color covers the whole screen */}
      <div className="min-h-screen bg-[#0f172a] text-white selection:bg-blue-500 selection:text-white">
        <Routes>
          {/* World 1: The HR Command Center (Homepage) */}
          <Route path="/" element={<HRDashboard />} />
          
          {/* World 2: The Candidate Meeting Room */}
          {/* The ":id" allows us to have unique links for every candidate */}
          <Route path="/meeting/:id" element={<MeetingRoom />} />
        </Routes>
      </div>
    </Router>
  );
}

export default App;