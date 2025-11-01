const mongoose = require("mongoose");
const Task = require("../models/Task");
require("dotenv").config();

const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://ayushpfullstack:Ayush%40123@cluster0.8qjqj.mongodb.net/good4it?retryWrites=true&w=majority";

async function cleanupTasks() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB connected successfully");

    console.log("Starting task cleanup...");

    // Delete all tasks
    const deletedTasks = await Task.deleteMany({});
    console.log(`Deleted ${deletedTasks.deletedCount} tasks`);

    console.log("Task cleanup completed successfully!");
    console.log("All existing tasks have been cleared.");
  } catch (error) {
    console.error("Error during task cleanup:", error);
  } finally {
    await mongoose.connection.close();
    console.log("Database connection closed");
  }
}

cleanupTasks();
