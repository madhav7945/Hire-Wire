import express from 'express';

const app = express();

// This is a test route. If you visit http://localhost:5000, you will see this message.
app.get('/', (req, res) => {
    res.send("Hire-Wire Backend is Running!");
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server is alive at http://localhost:${PORT}`);
});