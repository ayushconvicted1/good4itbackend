const mongoose = require("mongoose");

const moneyRequestSchema = new mongoose.Schema({
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
    max: [1000000, "Amount cannot exceed 1,000,000"],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Description cannot exceed 500 characters"],
  },
  paymentType: {
    type: String,
    enum: ["full_payment", "emi", "installments", "flexible"],
    default: "full_payment",
  },
  emiDetails: {
    numberOfInstallments: {
      type: Number,
      min: [1, "Number of installments must be at least 1"],
      max: [24, "Number of installments cannot exceed 24"],
    },
    installmentAmount: {
      type: Number,
      min: [1, "Installment amount must be greater than 0"],
    },
    frequency: {
      type: String,
      enum: ["weekly", "monthly", "quarterly"],
      default: "monthly",
    },
  },
  rejectionReason: {
    type: String,
    trim: true,
    maxlength: [500, "Rejection reason cannot exceed 500 characters"],
  },
  rejectedAt: {
    type: Date,
  },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
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
moneyRequestSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Ensure a user can't request money from themselves
moneyRequestSchema.pre("save", function (next) {
  if (this.requestor.toString() === this.lender.toString()) {
    next(new Error("Cannot request money from yourself"));
  }
  next();
});

// Index for efficient queries
moneyRequestSchema.index({ requestor: 1, status: 1 });
moneyRequestSchema.index({ lender: 1, status: 1 });
moneyRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("MoneyRequest", moneyRequestSchema);
