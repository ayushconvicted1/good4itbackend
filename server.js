const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/user");
const friendRoutes = require("./routes/friends");
const moneyRoutes = require("./routes/money");
const notificationRoutes = require("./routes/notifications");
const taskRoutes = require("./routes/tasks");

const app = express();
const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
});
app.use(limiter);

// CORS configuration
app.use(
  cors({
    origin: [
      process.env.FRONTEND_URL || "http://localhost:3000",
      "http://localhost:8081",
      "exp://192.168.1.6:8081",
      "exp://localhost:8081",
      /^exp:\/\/192\.168\.\d+\.\d+:8081$/,
      /^exp:\/\/localhost:8081$/,
    ],
    credentials: true,
  })
);

// Body parsing middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Static file serving for uploaded proofs
app.use("/uploads", express.static("uploads"));

// Database connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/good4it")
  .then(() => console.log("MongoDB connected successfully"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/money", moneyRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/tasks", taskRoutes);

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    message: "Good4It Backend API is running",
    timestamp: new Date().toISOString(),
    cors: "CORS configured for React Native",
  });
});

// Debug endpoint to test CORS and basic connectivity
app.get("/api/debug", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Debug endpoint working",
    headers: req.headers,
    origin: req.get("origin"),
    userAgent: req.get("user-agent"),
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "development" ? err.message : {},
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `Server accessible on: http://localhost:${PORT} and https://good4itbackend.onrender.com`
  );
});

module.exports = app;
