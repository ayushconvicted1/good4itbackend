const mongoose = require("mongoose");

const scoreHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "MoneyTransaction",
    required: false, // Not all score changes are transaction-related
  },
  changeType: {
    type: String,
    enum: [
      "transaction_completed", // +50 for completing a transaction (lender)
      "repayment_completed", // +30 for completing repayment (borrower)
      "request_declined", // -20 for declining a request (lender)
      "payment_not_received", // -30 for not receiving payment (lender)
      "false_dispute", // -50 for false dispute claim
      "dispute_resolved", // +25 for resolving dispute in favor
      "late_repayment", // -10 for late repayment
      "early_repayment", // +15 for early repayment
      "forgiveness_given", // +20 for forgiving debt
      "forgiveness_received", // +10 for receiving forgiveness
      "account_created", // +100 initial score
      "manual_adjustment", // Admin adjustment
    ],
    required: true,
  },
  scoreChange: {
    type: Number,
    required: true,
  },
  previousScore: {
    type: Number,
    required: true,
  },
  newScore: {
    type: Number,
    required: true,
  },
  description: {
    type: String,
    maxlength: [500, "Description cannot exceed 500 characters"],
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for efficient queries
scoreHistorySchema.index({ userId: 1, createdAt: -1 });
scoreHistorySchema.index({ transactionId: 1 });
scoreHistorySchema.index({ changeType: 1 });

module.exports = mongoose.model("ScoreHistory", scoreHistorySchema);

