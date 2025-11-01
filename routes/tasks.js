const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Task = require("../models/Task");
const TaskAssignment = require("../models/TaskAssignment");
const MoneyTransaction = require("../models/MoneyTransaction");
const User = require("../models/User");
const Friend = require("../models/Friend");
const TransactionProof = require("../models/TransactionProof");
const { uploadSingle, handleUploadError } = require("../middleware/upload");
const { authenticateToken } = require("../middleware/auth");
const notificationService = require("../services/notificationService");

// Helper function to check if users are friends
const checkFriendship = async (userId1, userId2) => {
  const friendship = await Friend.findOne({
    $or: [
      { user: userId1, friend: userId2 },
      { user: userId2, friend: userId1 },
    ],
  });
  return !!friendship;
};

// GET /api/tasks/assigned-by-me - Get tasks created by the current user (for tracking)
router.get("/assigned-by-me", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status, page = 1, limit = 10 } = req.query;

    const query = { assignedBy: userId };

    // Add status filter if provided
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const tasks = await Task.find(query)
      .populate("assignedBy", "fullName email profilePicture")
      .populate("assignedTo", "fullName email profilePicture")
      .populate("referenceTransaction", "amount status createdAt")
      .populate("completionProof", "filename originalName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalTasks = await Task.countDocuments(query);

    res.json({
      success: true,
      data: tasks,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalTasks / parseInt(limit)),
        totalTasks,
        hasNextPage: skip + tasks.length < totalTasks,
        hasPrevPage: parseInt(page) > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching assigned tasks:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch assigned tasks",
    });
  }
});

// GET /api/tasks/emi-payment-status/:transactionId - Check EMI payment status considering task forgiveness
router.get(
  "/emi-payment-status/:transactionId",
  authenticateToken,
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      const userId = req.user.userId;

      // Find the transaction and populate request details
      const transaction = await MoneyTransaction.findById(
        transactionId
      ).populate("requestId");
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Check if user is the requestor (borrower)
      if (transaction.requestor.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message:
            "You are not authorized to check payment status for this transaction",
        });
      }

      // Check if the associated request is EMI type
      if (transaction.requestId.paymentType !== "emi") {
        return res.json({
          success: true,
          data: {
            isEMI: false,
            message: "This is not an EMI transaction",
          },
        });
      }

      // Get current month and year
      const now = new Date();
      const currentMonth = now.toISOString().substring(0, 7);

      // Check if current month is forgiven by any task
      const forgivenByTask = await Task.findOne({
        referenceTransaction: transactionId,
        status: "confirmed",
        isEmiTask: true,
        "emiForgiveness.startMonth": { $lte: currentMonth },
        "emiForgiveness.endMonth": { $gte: currentMonth },
      });

      if (forgivenByTask) {
        return res.json({
          success: true,
          data: {
            isEMI: true,
            paymentRequired: false,
            message: `EMI payment for ${now.toLocaleDateString("en-US", {
              month: "long",
              year: "numeric",
            })} is forgiven by task completion`,
            forgivenBy: {
              taskId: forgivenByTask._id,
              taskTitle: forgivenByTask.title,
              forgivenEMIs: forgivenByTask.emiForgiveness.forgivenEMIs,
              forgivenessPeriod: `${forgivenByTask.emiForgiveness.startMonth} to ${forgivenByTask.emiForgiveness.endMonth}`,
            },
          },
        });
      }

      // Check if EMI payment was already made this month
      const existingPayment = await MoneyTransaction.findOne({
        _id: { $ne: transactionId },
        requestId: transaction.requestId._id,
        status: { $in: ["repaid"] },
        repaymentReceivedAt: {
          $gte: new Date(now.getFullYear(), now.getMonth(), 1),
          $lt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
        },
      });

      if (existingPayment) {
        return res.json({
          success: true,
          data: {
            isEMI: true,
            paymentRequired: false,
            message: `EMI payment already made for ${now.toLocaleDateString(
              "en-US",
              { month: "long", year: "numeric" }
            )}`,
            lastPaymentDate: existingPayment.repaymentReceivedAt,
          },
        });
      }

      // Check if transaction is completed
      if (transaction.status === "repaid") {
        return res.json({
          success: true,
          data: {
            isEMI: true,
            paymentRequired: false,
            message: "This transaction is already completed",
          },
        });
      }

      return res.json({
        success: true,
        data: {
          isEMI: true,
          paymentRequired: true,
          message: `EMI payment is required for ${now.toLocaleDateString(
            "en-US",
            { month: "long", year: "numeric" }
          )}`,
          emiDetails: {
            installmentAmount:
              transaction.requestId.emiDetails?.installmentAmount,
            frequency: transaction.requestId.emiDetails?.frequency,
            numberOfInstallments:
              transaction.requestId.emiDetails?.numberOfInstallments,
          },
        },
      });
    } catch (error) {
      console.error("Check EMI payment status error:", error);
      res.status(500).json({
        success: false,
        message: "Server error while checking EMI payment status",
      });
    }
  }
);

// GET /api/tasks/available-borrowers - Get users who can be assigned tasks (haven't repaid)
router.get("/available-borrowers", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Find all money transactions where the current user is the lender
    // and the borrower hasn't fully repaid
    const transactions = await MoneyTransaction.find({
      lender: userId,
      status: { $in: ["money_sent", "money_received"] },
    })
      .populate("requestor", "fullName email profilePicture")
      .populate("requestId", "paymentType emiDetails");

    // Return all transactions separately (multiple entries per borrower)
    const availableTransactions = [];

    for (const transaction of transactions) {
      // Check if this transaction has any active tasks (not complete/confirmed/cancelled)
      // Active tasks include: pending, accepted, in_progress, and completed (awaiting confirmation)
      // Only excluded statuses: confirmed, cancelled, declined
      const existingActiveTasks = await Task.countDocuments({
        referenceTransaction: transaction._id,
        status: {
          $in: ["pending", "accepted", "in_progress", "completed"],
        },
      });

      // Only include if no active tasks exist for this transaction
      // A borrower should not be visible if they have an active task for this transaction
      if (existingActiveTasks === 0) {
        // Calculate payment details
        const repaymentAmount = transaction.repaymentAmount || 0;
        const remainingBalance = transaction.amount - repaymentAmount;

        availableTransactions.push({
          _id: transaction.requestor._id,
          fullName: transaction.requestor.fullName,
          email: transaction.requestor.email,
          profilePicture: transaction.requestor.profilePicture,
          transactionId: transaction._id,
          originalAmount: transaction.amount,
          remainingAmount: remainingBalance,
          repaidAmount: repaymentAmount,
          createdAt: transaction.createdAt,
          moneySentAt: transaction.moneySentAt,
          paymentType: transaction.requestId?.paymentType || "full_payment",
          emiDetails: transaction.requestId?.emiDetails,
        });
      }
    }

    res.json({
      success: true,
      data: availableTransactions,
    });
  } catch (error) {
    console.error("Error fetching available borrowers:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch available borrowers",
    });
  }
});

// POST /api/tasks/create - Create a new task
router.post("/create", authenticateToken, async (req, res) => {
  try {
    const {
      assignedToId,
      transactionId,
      title,
      description,
      category,
      monetaryValue,
      dueDate,
      priority,
      location,
      isEmiTask,
      emiForgiveness,
    } = req.body;
    const assignedById = req.user.userId;

    // Validation
    if (!assignedToId || !transactionId || !title || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "Required fields: assignedToId, transactionId, title, dueDate",
      });
    }

    // Additional validation for non-EMI tasks
    if (!isEmiTask && !monetaryValue) {
      return res.status(400).json({
        success: false,
        message: "Monetary value is required for non-EMI tasks",
      });
    }

    // Verify the transaction exists and user is the lender
    const transaction = await MoneyTransaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    if (transaction.lender.toString() !== assignedById.toString()) {
      return res.status(403).json({
        success: false,
        message:
          "You can only create tasks for transactions you lent money for",
      });
    }

    if (transaction.requestor.toString() !== assignedToId.toString()) {
      return res.status(400).json({
        success: false,
        message: "Assigned user must be the borrower of this transaction",
      });
    }

    // Check if users are friends
    const areFriends = await checkFriendship(assignedById, assignedToId);
    if (!areFriends) {
      return res.status(403).json({
        success: false,
        message: "You can only assign tasks to friends",
      });
    }

    // Validate EMI task requirements
    if (isEmiTask && emiForgiveness) {
      if (!emiForgiveness.forgivenEMIs || emiForgiveness.forgivenEMIs < 1) {
        return res.status(400).json({
          success: false,
          message: "Must specify number of EMIs to forgive (minimum 1)",
        });
      }

      // Check if transaction is EMI type
      const transactionWithRequest = await MoneyTransaction.findById(
        transactionId
      ).populate("requestId");
      if (transactionWithRequest.requestId.paymentType !== "emi") {
        return res.status(400).json({
          success: false,
          message: "EMI tasks can only be created for EMI transactions",
        });
      }

      // Calculate maximum EMIs based on loan amount
      const loanAmount = transaction.amount;
      let maxEMIs;

      if (loanAmount <= 500) {
        maxEMIs = 5; // For $500 loan, max 5 EMIs
      } else {
        // For larger loans, calculate based on amount (assuming $100 per EMI minimum)
        maxEMIs = Math.min(Math.floor(loanAmount / 100), 24);
        maxEMIs = Math.max(maxEMIs, 1);
      }

      if (emiForgiveness.forgivenEMIs > maxEMIs) {
        return res.status(400).json({
          success: false,
          message: `Cannot forgive more than ${maxEMIs} EMIs for a $${loanAmount} loan`,
        });
      }

      // Calculate EMI forgiveness months
      const startDate = new Date(transaction.createdAt);
      const startMonth = startDate.toISOString().substring(0, 7);
      const endDate = new Date(startDate);
      endDate.setMonth(startDate.getMonth() + emiForgiveness.forgivenEMIs - 1);
      const endMonth = endDate.toISOString().substring(0, 7);

      emiForgiveness.startMonth = startMonth;
      emiForgiveness.endMonth = endMonth;
    }

    // Check if there's already a pending task for this transaction
    const existingTask = await Task.findOne({
      referenceTransaction: transactionId,
      status: { $in: ["pending", "accepted", "in_progress"] },
    });

    if (existingTask) {
      return res.status(400).json({
        success: false,
        message: "There is already a pending task for this transaction",
      });
    }

    // Create the task
    const task = new Task({
      title,
      description,
      category,
      monetaryValue,
      assignedBy: assignedById,
      assignedTo: assignedToId,
      referenceTransaction: transactionId,
      dueDate: new Date(dueDate),
      priority,
      location,
      isEmiTask: isEmiTask || false,
      emiForgiveness: isEmiTask ? emiForgiveness : undefined,
    });

    await task.save();

    // Populate the task with user details
    await task.populate([
      { path: "assignedBy", select: "fullName email profilePicture" },
      { path: "assignedTo", select: "fullName email profilePicture" },
    ]);

    // Send notification to the assigned user
    try {
      await notificationService.sendTaskAssignmentNotification(
        assignedToId,
        assignedById,
        task._id,
        title
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task assignment notification:",
        notificationError
      );
      // Don't fail the request if notification fails
    }

    res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error creating task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create task",
    });
  }
});

// GET /api/tasks/my-tasks - Get tasks assigned to or by the current user
router.get("/my-tasks", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { type = "all", status, limit = 20, page = 1 } = req.query;

    let query = {};

    // Build query based on type
    switch (type) {
      case "assigned-to-me":
        query.assignedTo = userId;
        break;
      case "assigned-by-me":
        query.assignedBy = userId;
        break;
      case "all":
        query.$or = [{ assignedTo: userId }, { assignedBy: userId }];
        break;
      default:
        return res.status(400).json({
          success: false,
          message: "Invalid type parameter",
        });
    }

    // Add status filter if provided
    if (status) {
      query.status = status;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const tasks = await Task.find(query)
      .populate("assignedBy", "fullName email profilePicture")
      .populate("assignedTo", "fullName email profilePicture")
      .populate("referenceTransaction", "amount status")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const totalTasks = await Task.countDocuments(query);

    const response = {
      success: true,
      data: {
        tasks,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalTasks / parseInt(limit)),
          totalTasks,
          hasNext: skip + tasks.length < totalTasks,
          hasPrev: parseInt(page) > 1,
        },
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching tasks:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch tasks",
    });
  }
});

// PUT /api/tasks/:taskId/accept - Accept a task
router.put("/:taskId/accept", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.assignedTo.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only accept tasks assigned to you",
      });
    }

    if (task.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Task cannot be accepted in its current status",
      });
    }

    task.status = "accepted";
    await task.save();

    // Send notification to the task creator
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedBy,
        userId,
        task._id,
        "accepted"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task acceptance notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task accepted successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error accepting task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to accept task",
    });
  }
});

// PUT /api/tasks/:taskId/decline - Decline a task
router.put("/:taskId/decline", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;
    const { declineReason } = req.body;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.assignedTo.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only decline tasks assigned to you",
      });
    }

    if (task.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Task cannot be declined in its current status",
      });
    }

    task.status = "declined";
    task.declinedAt = new Date();
    task.declineReason = declineReason;
    await task.save();

    // Send notification to the task creator
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedBy,
        userId,
        task._id,
        "declined"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task decline notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task declined successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error declining task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to decline task",
    });
  }
});

// PUT /api/tasks/:taskId/start - Start working on a task
router.put("/:taskId/start", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.assignedTo.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only start tasks assigned to you",
      });
    }

    // Allow starting from pending or accepted status
    if (task.status !== "pending" && task.status !== "accepted") {
      return res.status(400).json({
        success: false,
        message: "Task must be in pending or accepted status before starting",
      });
    }

    task.status = "in_progress";
    await task.save();

    res.json({
      success: true,
      message: "Task started successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error starting task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to start task",
    });
  }
});

// PUT /api/tasks/:taskId/complete - Complete a task
router.put("/:taskId/complete", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;
    const { completionNotes } = req.body;

    const task = await Task.findById(taskId);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.assignedTo.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only complete tasks assigned to you",
      });
    }

    if (!task.canBeCompleted()) {
      return res.status(400).json({
        success: false,
        message: "Task cannot be completed in its current status",
      });
    }

    task.status = "completed";
    task.completedAt = new Date();
    task.completionNotes = completionNotes || "";

    await task.save();

    // Send notification to the task creator
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedBy,
        userId,
        task._id,
        "completed"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task completion notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task completed successfully. Waiting for lender confirmation.",
      data: task,
    });
  } catch (error) {
    console.error("Error completing task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to complete task",
    });
  }
});

// PUT /api/tasks/:taskId/confirm - Confirm task completion (lender only)
router.put("/:taskId/confirm", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;
    const { confirmationNotes } = req.body;

    const task = await Task.findById(taskId).populate(
      "referenceTransaction",
      "amount status repaymentAmount"
    );

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    if (task.assignedBy.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Only the task creator can confirm completion",
      });
    }

    if (task.status !== "completed") {
      return res.status(400).json({
        success: false,
        message: "Task must be completed before it can be confirmed",
      });
    }

    // Update task status and repayment amount
    task.status = "confirmed";
    task.confirmedAt = new Date();
    task.confirmationNotes = confirmationNotes || "";
    task.amountRepaid = task.monetaryValue;

    await task.save();

    // Update the reference transaction
    const MoneyTransaction = require("../models/MoneyTransaction");
    const transaction = await MoneyTransaction.findById(
      task.referenceTransaction._id
    ).populate("requestId");

    if (transaction) {
      let forgivenAmount = 0;

      // Handle EMI forgiveness if this is an EMI task
      if (
        task.isEmiTask &&
        task.emiForgiveness &&
        transaction.requestId?.emiDetails
      ) {
        // Add EMI forgiveness to the transaction
        if (!transaction.emiForgiveness) {
          transaction.emiForgiveness = {
            forgivenEMIs: [],
            totalForgivenEMIs: 0,
          };
        }

        // Get EMI installment amount
        const installmentAmount =
          transaction.requestId.emiDetails.installmentAmount || 0;
        const frequency =
          transaction.requestId.emiDetails.frequency || "monthly";
        const numberOfForgivenEMIs = task.emiForgiveness.forgivenEMIs;

        // Calculate forgiven amount (number of EMIs * installment amount per EMI)
        forgivenAmount = installmentAmount * numberOfForgivenEMIs;

        // Add forgiven EMIs for each period
        const forgivenMonths = task.calculateEMIForgivenessMonths();
        forgivenMonths.forEach((month) => {
          transaction.emiForgiveness.forgivenEMIs.push({
            month,
            amount: installmentAmount,
            forgivenAt: new Date(),
            taskId: task._id,
          });
        });

        transaction.emiForgiveness.totalForgivenEMIs += numberOfForgivenEMIs;

        // Calculate next repayment date based on the last forgiven period
        if (forgivenMonths.length > 0) {
          const lastForgivenMonth = forgivenMonths[forgivenMonths.length - 1];
          const lastForgivenDate = new Date(lastForgivenMonth + "-01");

          let nextRepaymentDate = new Date(lastForgivenDate);

          switch (frequency) {
            case "weekly": {
              // Find next Monday after the last forgiven week
              const dayOfWeek = lastForgivenDate.getDay();
              const daysUntilMonday =
                dayOfWeek === 0 ? 1 : dayOfWeek === 1 ? 7 : 8 - dayOfWeek;
              nextRepaymentDate.setDate(
                lastForgivenDate.getDate() + daysUntilMonday + 7
              );
              nextRepaymentDate.setHours(0, 0, 0, 0);
              break;
            }
            case "monthly": {
              // Next 1st of month after the last forgiven month
              nextRepaymentDate.setMonth(lastForgivenDate.getMonth() + 1);
              nextRepaymentDate.setDate(1);
              nextRepaymentDate.setHours(0, 0, 0, 0);
              break;
            }
            case "quarterly": {
              // Next 1st of quarter month after the last forgiven quarter
              const quarterMonth = lastForgivenDate.getMonth();
              const quarter = Math.floor(quarterMonth / 3);
              const nextQuarterMonth = (quarter + 1) * 3;
              nextRepaymentDate = new Date(
                lastForgivenDate.getFullYear(),
                nextQuarterMonth,
                1
              );
              if (nextQuarterMonth >= 12) {
                nextRepaymentDate = new Date(
                  lastForgivenDate.getFullYear() + 1,
                  0,
                  1
                );
              }
              nextRepaymentDate.setHours(0, 0, 0, 0);
              break;
            }
          }

          // Update repaymentReceivedAt to mark when the last forgiven EMI period ended
          // This will be used by the frontend to calculate when the next payment is due
          // Calculate the end of the last forgiven period based on frequency
          const endOfLastForgivenPeriod = new Date(lastForgivenDate);
          switch (frequency) {
            case "weekly": {
              // For weekly, lastForgivenDate is the start of the week, so add 6 days
              endOfLastForgivenPeriod.setDate(lastForgivenDate.getDate() + 6);
              endOfLastForgivenPeriod.setHours(23, 59, 59, 999);
              break;
            }
            case "monthly": {
              // For monthly, lastForgivenDate is the 1st of the month, so get the last day of that month
              endOfLastForgivenPeriod.setMonth(lastForgivenDate.getMonth() + 1);
              endOfLastForgivenPeriod.setDate(0); // This gives us the last day of the previous month
              endOfLastForgivenPeriod.setHours(23, 59, 59, 999);
              break;
            }
            case "quarterly": {
              // For quarterly, lastForgivenDate is the 1st of a quarter month
              // Get the last day of that quarter (3 months later)
              const quarterStartMonth = lastForgivenDate.getMonth();
              const quarterEndMonth = quarterStartMonth + 2; // Last month of quarter
              endOfLastForgivenPeriod.setMonth(quarterEndMonth + 1);
              endOfLastForgivenPeriod.setDate(0); // Last day of the quarter's last month
              endOfLastForgivenPeriod.setHours(23, 59, 59, 999);
              break;
            }
          }
          transaction.repaymentReceivedAt = endOfLastForgivenPeriod;
        }
      }

      // For EMI tasks with forgiveness, add the forgiven amount to repaymentAmount
      // For non-EMI tasks, add the task's monetary value
      const repaymentToAdd =
        task.isEmiTask && forgivenAmount > 0
          ? forgivenAmount
          : task.monetaryValue;

      // Add the repayment to the transaction
      transaction.repaymentAmount =
        (transaction.repaymentAmount || 0) + repaymentToAdd;

      // Update last repayment date for EMI transactions (needed for next payment calculation)
      if (
        transaction.requestId?.paymentType === "emi" &&
        !transaction.repaymentReceivedAt
      ) {
        transaction.repaymentReceivedAt = new Date();
      }

      // Check if fully repaid
      if (transaction.repaymentAmount >= transaction.amount) {
        transaction.status = "repaid";
        transaction.repaymentReceivedAt = new Date();
      }

      await transaction.save();
    }

    // Send notification to the task assignee
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedTo,
        userId,
        task._id,
        "confirmed"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task confirmation notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task confirmed successfully. Amount repaid.",
      data: task,
    });
  } catch (error) {
    console.error("Error confirming task:", error);
    res.status(500).json({
      success: false,
      message: "Failed to confirm task",
    });
  }
});

// PUT /api/tasks/:taskId/mark-done - Mark task as done (lender only)
router.put("/:taskId/mark-done", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId).populate(
      "referenceTransaction",
      "amount status repaymentAmount"
    );

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check if user is the task creator
    if (task.assignedBy.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the task creator can mark it as done",
      });
    }

    // Check if task is in progress
    if (task.status !== "in_progress") {
      return res.status(400).json({
        success: false,
        message: "Task must be in progress to mark as done",
      });
    }

    // Update task status to completed
    task.status = "completed";
    task.completedAt = new Date();
    await task.save();

    // Send notification to the task assignee
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedTo,
        userId,
        task._id,
        "completed"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task completion notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task marked as done successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error marking task as done:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark task as done",
    });
  }
});

// PUT /api/tasks/:taskId/mark-complete - Mark task as complete (lender only)
router.put("/:taskId/mark-complete", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId)
      .populate("referenceTransaction", "amount status repaymentAmount")
      .populate("assignedBy", "_id email fullName")
      .populate("assignedTo", "_id email fullName");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check if population worked correctly
    if (!task.assignedBy || !task.assignedBy._id) {
      console.log("ERROR: assignedBy not populated correctly");
      return res.status(500).json({
        success: false,
        message: "Task data error - assignedBy not found",
      });
    }

    if (task.assignedBy._id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Only the task creator can mark it as complete",
      });
    }

    // Check if task is in progress
    if (task.status !== "in_progress") {
      return res.status(400).json({
        success: false,
        message: "Task must be in progress to mark as complete",
      });
    }

    // Update task status to completed
    task.status = "completed";
    task.completedAt = new Date();
    await task.save();

    // Send notification to the task assignee
    try {
      await notificationService.sendTaskStatusUpdateNotification(
        task.assignedTo,
        userId,
        task._id,
        "completed"
      );
    } catch (notificationError) {
      console.error(
        "Failed to send task completion notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Task marked as complete successfully",
      data: task,
    });
  } catch (error) {
    console.error("Error marking task as complete:", error);
    res.status(500).json({
      success: false,
      message: "Failed to mark task as complete",
    });
  }
});

// Debug endpoint to check raw task data
router.get("/debug-raw/:taskId", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId)
      .populate("assignedBy", "fullName email _id")
      .populate("assignedTo", "fullName email _id");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    res.json({
      success: true,
      data: {
        task: {
          _id: task._id,
          title: task.title,
          assignedBy: {
            _id: task.assignedBy._id,
            fullName: task.assignedBy.fullName,
            email: task.assignedBy.email,
          },
          assignedTo: {
            _id: task.assignedTo._id,
            fullName: task.assignedTo.fullName,
            email: task.assignedTo.email,
          },
          status: task.status,
        },
        currentUser: {
          _id: req.user._id,
          fullName: req.user.fullName,
          email: req.user.email,
        },
        userId: userId,
        comparisons: {
          assignedToMatch: task.assignedTo._id.toString() === userId.toString(),
          assignedByMatch: task.assignedBy._id.toString() === userId.toString(),
          hasAccess:
            task.assignedTo._id.toString() === userId.toString() ||
            task.assignedBy._id.toString() === userId.toString(),
        },
      },
    });
  } catch (error) {
    console.error("Error in debug raw:", error);
    res.status(500).json({
      success: false,
      message: "Debug raw failed",
      error: error.message,
    });
  }
});

// Debug endpoint to check task authorization
router.get("/debug-auth/:taskId", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId)
      .populate("assignedBy", "fullName email")
      .populate("assignedTo", "fullName email");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    res.json({
      success: true,
      data: {
        taskId: task._id,
        userId: userId,
        userIdType: typeof userId,
        assignedTo: task.assignedTo,
        assignedToType: typeof task.assignedTo,
        assignedBy: task.assignedBy,
        assignedByType: typeof task.assignedBy,
        assignedToStr: task.assignedTo._id.toString(),
        assignedByStr: task.assignedBy._id.toString(),
        userIdStr: userId.toString(),
        isAssignedTo: task.assignedTo._id.toString() === userId.toString(),
        isAssignedBy: task.assignedBy._id.toString() === userId.toString(),
        hasAccess:
          task.assignedTo._id.toString() === userId.toString() ||
          task.assignedBy._id.toString() === userId.toString(),
        user: {
          id: req.user._id,
          name: req.user.fullName,
          email: req.user.email,
        },
        debugInfo: {
          taskAssignedToId: task.assignedTo._id,
          taskAssignedById: task.assignedBy._id,
          currentUserId: userId,
          comparisonResult: {
            assignedToMatch:
              task.assignedTo._id.toString() === userId.toString(),
            assignedByMatch:
              task.assignedBy._id.toString() === userId.toString(),
          },
        },
      },
    });
  } catch (error) {
    console.error("Error in debug auth:", error);
    res.status(500).json({
      success: false,
      message: "Debug auth failed",
      error: error.message,
    });
  }
});

// GET /api/tasks/:taskId - Get task details
router.get("/:taskId", authenticateToken, async (req, res) => {
  try {
    const taskId = req.params.taskId;
    const userId = req.user.userId;

    const task = await Task.findById(taskId)
      .populate("assignedBy", "fullName email profilePicture")
      .populate("assignedTo", "fullName email profilePicture")
      .populate("referenceTransaction", "amount status createdAt")
      .populate("completionProof", "filename originalName");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check if user has access to this task
    if (
      task.assignedTo._id.toString() !== userId.toString() &&
      task.assignedBy._id.toString() !== userId.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have access to this task",
      });
    }

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error("Error fetching task details:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch task details",
    });
  }
});

// GET /api/tasks/emi-assignments/:transactionId - Get EMI task assignments for a transaction
router.get(
  "/emi-assignments/:transactionId",
  authenticateToken,
  async (req, res) => {
    try {
      const transactionId = req.params.transactionId;
      const userId = req.user.userId;

      // Verify the transaction exists and user has access
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      if (
        transaction.lender.toString() !== userId &&
        transaction.requestor.toString() !== userId
      ) {
        return res.status(403).json({
          success: false,
          message: "You do not have access to this transaction",
        });
      }

      // Get EMI task assignments
      const assignments = await TaskAssignment.find({
        transaction: transactionId,
      })
        .populate("task")
        .sort({ emiMonth: 1 });

      res.json({
        success: true,
        data: assignments,
      });
    } catch (error) {
      console.error("Error fetching EMI assignments:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch EMI assignments",
      });
    }
  }
);

// POST /api/tasks/emi-assignments/:transactionId - Create EMI task assignments
router.post(
  "/emi-assignments/:transactionId",
  authenticateToken,
  async (req, res) => {
    try {
      const transactionId = req.params.transactionId;
      const userId = req.user.userId;
      const { emiDetails } = req.body;

      // Verify the transaction exists and user is the lender
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      if (transaction.lender.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Only the lender can create EMI task assignments",
        });
      }

      if (!transaction.emiDetails) {
        return res.status(400).json({
          success: false,
          message: "This transaction does not have EMI details",
        });
      }

      // Generate EMI months
      const assignments = [];
      const startDate = new Date(transaction.createdAt);
      const frequency = transaction.emiDetails.frequency;
      const numberOfInstallments = transaction.emiDetails.numberOfInstallments;

      for (let i = 0; i < numberOfInstallments; i++) {
        let monthDate = new Date(startDate);

        switch (frequency) {
          case "weekly":
            monthDate.setDate(startDate.getDate() + i * 7);
            break;
          case "monthly":
            monthDate.setMonth(startDate.getMonth() + i);
            break;
          case "quarterly":
            monthDate.setMonth(startDate.getMonth() + i * 3);
            break;
        }

        const emiMonth = `${monthDate.getFullYear()}-${String(
          monthDate.getMonth() + 1
        ).padStart(2, "0")}`;

        const assignment = new TaskAssignment({
          transaction: transactionId,
          lender: transaction.lender,
          borrower: transaction.requestor,
          emiMonth,
        });

        assignments.push(assignment);
      }

      await TaskAssignment.insertMany(assignments);

      res.json({
        success: true,
        message: "EMI task assignments created successfully",
        data: assignments,
      });
    } catch (error) {
      console.error("Error creating EMI assignments:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create EMI task assignments",
      });
    }
  }
);

module.exports = router;
