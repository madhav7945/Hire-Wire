import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.io for real-time features
const io = new Server(server, {
  cors: {
    origin: '*', // Allows all origins during the hackathon
    methods: ['GET', 'POST']
  }
});

// Global Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route: Health Check
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'success', 
    message: 'Hire-Wire API is up and running smoothly!' 
  });
});

// Socket.io Connection Handler
io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);
  
  socket.on('disconnect', () => {
    console.log(`🛑 Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});