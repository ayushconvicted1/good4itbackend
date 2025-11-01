const mongoose = require("mongoose");

const disputeSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "MoneyTransaction",
    required: true,
  },
  disputer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  disputeType: {
    type: String,
    enum: [
      "payment_not_received",
      "payment_not_sent",
      "incorrect_amount",
      "fraudulent_proof",
    ],
    required: true,
  },
  status: {
    type: String,
    enum: ["pending", "resolved", "rejected"],
    default: "pending",
  },
  description: {
    type: String,
    required: true,
    maxlength: [1000, "Description cannot exceed 1000 characters"],
  },
  evidence: [
    {
      fileName: String,
      filePath: String,
      fileSize: Number,
      mimeType: String,
      uploadedAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
  resolution: {
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    resolution: {
      type: String,
      enum: ["in_favor_of_disputer", "in_favor_of_other_party", "no_fault"],
      required: false,
    },
    resolutionNotes: String,
    resolvedAt: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
disputeSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes for efficient queries
disputeSchema.index({ transactionId: 1 });
disputeSchema.index({ disputer: 1 });
disputeSchema.index({ status: 1 });
disputeSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Dispute", disputeSchema);

