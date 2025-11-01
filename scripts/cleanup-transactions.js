const mongoose = require("mongoose");
const MoneyRequest = require("../models/MoneyRequest");
const MoneyTransaction = require("../models/MoneyTransaction");

// Load environment variables
require("dotenv").config();

// Connect to MongoDB using the same connection string as the server
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://ayushpfullstack:Ayush%40123@personal.oetquyc.mongodb.net/good4it";

async function cleanupTransactions() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("MongoDB connected successfully");

    console.log("Starting transaction cleanup...");

    // Delete all existing money requests
    const deletedRequests = await MoneyRequest.deleteMany({});
    console.log(`Deleted ${deletedRequests.deletedCount} money requests`);

    // Delete all existing money transactions
    const deletedTransactions = await MoneyTransaction.deleteMany({});
    console.log(
      `Deleted ${deletedTransactions.deletedCount} money transactions`
    );

    console.log("Transaction cleanup completed successfully!");
    console.log(
      "All existing transactions have been cleared to use the new schema."
    );
  } catch (error) {
    console.error("Error during cleanup:", error);
  } finally {
    await mongoose.connection.close();
    console.log("Database connection closed");
  }
}

cleanupTransactions();
