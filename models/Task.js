const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema({
  // Basic task information
  title: {
    type: String,
    required: [true, "Task title is required"],
    trim: true,
    maxlength: [100, "Task title cannot exceed 100 characters"],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Task description cannot exceed 500 characters"],
  },
  category: {
    type: String,
    required: [true, "Task category is required"],
    enum: [
      "household",
      "maintenance",
      "cleaning",
      "cooking",
      "shopping",
      "transportation",
      "personal_care",
      "pet_care",
      "garden",
      "other",
    ],
    default: "other",
  },

  // Financial information
  monetaryValue: {
    type: Number,
    required: [true, "Monetary value is required"],
    min: [0, "Monetary value must be 0 or greater"],
    max: [10000, "Monetary value cannot exceed 10,000"],
    validate: {
      validator: function (value) {
        // For EMI tasks, monetary value can be 0
        if (this.isEmiTask) {
          return value >= 0;
        }
        // For non-EMI tasks, monetary value must be greater than 0
        return value > 0;
      },
      message: "Monetary value must be greater than 0 for non-EMI tasks",
    },
  },

  // Assignment information
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  // Reference to money transaction
  referenceTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "MoneyTransaction",
    required: true,
  },

  // Task status
  status: {
    type: String,
    enum: [
      "pending",
      "accepted",
      "in_progress",
      "completed",
      "confirmed", // New: Lender confirmed completion
      "declined",
      "cancelled",
    ],
    default: "pending",
  },

  // Task scheduling
  dueDate: {
    type: Date,
    required: [true, "Due date is required"],
  },
  completedAt: Date,

  // Task completion details
  completionProof: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "TransactionProof",
  },
  completionNotes: {
    type: String,
    trim: true,
    maxlength: [500, "Completion notes cannot exceed 500 characters"],
  },

  // Confirmation details (when lender confirms completion)
  confirmedAt: Date,
  confirmationNotes: {
    type: String,
    trim: true,
    maxlength: [500, "Confirmation notes cannot exceed 500 characters"],
  },

  // Money repayment integration
  amountRepaid: {
    type: Number,
    default: 0,
    min: [0, "Amount repaid cannot be negative"],
  },

  // Decline information
  declinedAt: Date,
  declineReason: {
    type: String,
    trim: true,
    maxlength: [500, "Decline reason cannot exceed 500 characters"],
  },

  // EMI task information
  isEmiTask: {
    type: Boolean,
    default: false,
  },
  emiForgiveness: {
    forgivenEMIs: {
      type: Number,
      min: [1, "Must forgive at least 1 EMI"],
      max: [24, "Cannot forgive more than 24 EMIs"],
    },
    startMonth: {
      type: String, // Format: "YYYY-MM" - when forgiveness starts
    },
    endMonth: {
      type: String, // Format: "YYYY-MM" - when forgiveness ends
    },
  },

  // Task priority
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium",
  },

  // Location information (optional)
  location: {
    type: String,
    trim: true,
    maxlength: [200, "Location cannot exceed 200 characters"],
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
taskSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes for efficient queries
taskSchema.index({ assignedBy: 1, status: 1 });
taskSchema.index({ assignedTo: 1, status: 1 });
taskSchema.index({ referenceTransaction: 1 });
taskSchema.index({ status: 1, createdAt: -1 });
taskSchema.index({ dueDate: 1 });
taskSchema.index({ isEmiTask: 1, "emiForgiveness.startMonth": 1 });

// Virtual for task age
taskSchema.virtual("ageInDays").get(function () {
  return Math.floor((Date.now() - this.createdAt) / (1000 * 60 * 60 * 24));
});

// Virtual for days until due
taskSchema.virtual("daysUntilDue").get(function () {
  return Math.ceil((this.dueDate - Date.now()) / (1000 * 60 * 60 * 24));
});

// Instance method to check if task is overdue
taskSchema.methods.isOverdue = function () {
  return this.status !== "completed" && this.dueDate < new Date();
};

// Instance method to check if task can be completed
taskSchema.methods.canBeCompleted = function () {
  return ["accepted", "in_progress"].includes(this.status);
};

// Instance method to check if task can be confirmed by lender
taskSchema.methods.canBeConfirmed = function () {
  return this.status === "completed";
};

// Instance method to check if task is fully repaid
taskSchema.methods.isFullyRepaid = function () {
  return this.amountRepaid >= this.monetaryValue;
};

// Instance method to check if task can be declined
taskSchema.methods.canBeDeclined = function () {
  return this.status === "pending";
};

// Instance method to calculate EMI forgiveness months
taskSchema.methods.calculateEMIForgivenessMonths = function () {
  if (!this.isEmiTask || !this.emiForgiveness.forgivenEMIs) {
    return [];
  }

  const startDate = new Date(this.emiForgiveness.startMonth + "-01");
  const months = [];

  for (let i = 0; i < this.emiForgiveness.forgivenEMIs; i++) {
    const monthDate = new Date(startDate);
    monthDate.setMonth(startDate.getMonth() + i);
    months.push(monthDate.toISOString().substring(0, 7)); // Format: "YYYY-MM"
  }

  return months;
};

// Instance method to check if EMI forgiveness is active for current month
taskSchema.methods.isEMIForgivenessActive = function () {
  if (!this.isEmiTask || !this.emiForgiveness.startMonth) {
    return false;
  }

  const currentMonth = new Date().toISOString().substring(0, 7);
  const startMonth = this.emiForgiveness.startMonth;
  const endMonth = this.emiForgiveness.endMonth;

  return currentMonth >= startMonth && currentMonth <= endMonth;
};

module.exports = mongoose.model("Task", taskSchema);
