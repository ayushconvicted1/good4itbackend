const mongoose = require("mongoose");

const taskAssignmentSchema = new mongoose.Schema({
  // Reference to the money transaction
  transaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "MoneyTransaction",
    required: true,
  },

  // Users involved
  lender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  borrower: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  // EMI details
  emiMonth: {
    type: String, // Format: "YYYY-MM"
    required: true,
  },

  // Task assignment status
  status: {
    type: String,
    enum: ["available", "assigned", "completed", "skipped"],
    default: "available",
  },

  // Task details
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Task",
    default: null,
  },

  // Assignment tracking
  assignedAt: Date,
  completedAt: Date,
  skippedAt: Date,

  // Notes
  notes: {
    type: String,
    trim: true,
    maxlength: [500, "Notes cannot exceed 500 characters"],
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
taskAssignmentSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Indexes for efficient queries
taskAssignmentSchema.index({ lender: 1, status: 1 });
taskAssignmentSchema.index({ borrower: 1, status: 1 });
taskAssignmentSchema.index({ emiMonth: 1, status: 1 });

// Ensure unique combination of transaction and EMI month
taskAssignmentSchema.index({ transaction: 1, emiMonth: 1 }, { unique: true });

// Virtual for month display
taskAssignmentSchema.virtual("monthDisplay").get(function () {
  const [year, month] = this.emiMonth.split("-");
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${monthNames[parseInt(month) - 1]} ${year}`;
});

// Instance method to check if assignment is for current month
taskAssignmentSchema.methods.isCurrentMonth = function () {
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, "0")}`;
  return this.emiMonth === currentMonth;
};

// Instance method to check if assignment is overdue
taskAssignmentSchema.methods.isOverdue = function () {
  const now = new Date();
  const assignmentDate = new Date(this.emiMonth + "-01");
  return this.status === "available" && assignmentDate < now;
};

module.exports = mongoose.model("TaskAssignment", taskAssignmentSchema);
