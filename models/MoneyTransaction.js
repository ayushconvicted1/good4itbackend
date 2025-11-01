const mongoose = require("mongoose");

const moneyTransactionSchema = new mongoose.Schema({
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "MoneyRequest",
    required: true,
  },
  requestor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  lender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: [1, "Amount must be greater than 0"],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Description cannot exceed 500 characters"],
  },
  status: {
    type: String,
    enum: [
      "money_sent",
      "money_received",
      "repayment_sent",
      "repaid",
      "forgiven",
      "repayment_rejected",
    ],
    default: "money_sent",
  },

  // Money sending phase
  moneySentAt: {
    type: Date,
    default: Date.now,
  },
  moneySentProof: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TransactionProof",
  },

  // Money receipt phase
  moneyReceivedAt: Date,
  moneyReceivedProof: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TransactionProof",
  },

  // Repayment phase
  repaymentSentAt: Date,
  repaymentSentProof: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TransactionProof",
  },
  repaymentAmount: {
    type: Number,
    min: [0, "Repayment amount cannot be negative"],
  },

  // Repayment confirmation phase
  repaymentReceivedAt: Date,
  repaymentReceivedProof: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TransactionProof",
  },

  // Repayment rejection phase
  repaymentRejectedAt: Date,
  repaymentRejectionReason: {
    type: String,
    trim: true,
    maxlength: [500, "Rejection reason cannot exceed 500 characters"],
  },

  // Forgiveness phase
  forgivenAt: Date,
  forgivenAmount: {
    type: Number,
    min: [0, "Forgiven amount cannot be negative"],
  },

  // EMI forgiveness tracking
  emiForgiveness: {
    forgivenEMIs: [
      {
        month: String, // Format: "YYYY-MM"
        amount: Number,
        forgivenAt: Date,
        taskId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Task",
        },
      },
    ],
    totalForgivenEMIs: {
      type: Number,
      default: 0,
    },
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
moneyTransactionSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Index for efficient queries
moneyTransactionSchema.index({ requestor: 1, status: 1 });
moneyTransactionSchema.index({ lender: 1, status: 1 });
moneyTransactionSchema.index({ status: 1, createdAt: -1 });
moneyTransactionSchema.index({ requestId: 1 });

// Virtual for remaining balance
moneyTransactionSchema.virtual("remainingBalance").get(function () {
  if (this.status === "repaid") return 0;
  return this.amount - (this.repaymentAmount || 0);
});

module.exports = mongoose.model("MoneyTransaction", moneyTransactionSchema);
