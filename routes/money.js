const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const MoneyRequest = require("../models/MoneyRequest");
const MoneyTransaction = require("../models/MoneyTransaction");
const TransactionProof = require("../models/TransactionProof");
const RepaymentReminder = require("../models/RepaymentReminder");
const Friend = require("../models/Friend");
const User = require("../models/User");
const Dispute = require("../models/Dispute");
const multer = require("multer");
const {
  upload,
  uploadSingle,
  handleUploadError,
} = require("../middleware/upload");
const notificationService = require("../services/notificationService");
const Good4ItScoreService = require("../services/good4itScoreService");

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Access token required",
    });
  }

  jwt.verify(
    token,
    process.env.JWT_SECRET || "your-secret-key",
    (err, user) => {
      if (err) {
        return res.status(403).json({
          success: false,
          message: "Invalid or expired token",
        });
      }
      req.user = user;
      next();
    }
  );
};

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

// POST /api/money/request - Create money request
router.post("/request", authenticateToken, async (req, res) => {
  try {
    const { lenderId, amount, description, paymentType, emiDetails } = req.body;
    const requestorId = req.user.userId;

    // Validation
    if (!lenderId || !amount) {
      return res.status(400).json({
        success: false,
        message: "Lender ID and amount are required",
      });
    }

    if (amount <= 0 || amount > 1000000) {
      return res.status(400).json({
        success: false,
        message: "Amount must be between 1 and 1,000,000",
      });
    }

    if (requestorId === lenderId) {
      return res.status(400).json({
        success: false,
        message: "Cannot request money from yourself",
      });
    }

    // Validate payment type
    const validPaymentTypes = [
      "full_payment",
      "emi",
      "installments",
      "flexible",
    ];
    if (paymentType && !validPaymentTypes.includes(paymentType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment type",
      });
    }

    // Validate EMI details if payment type is EMI
    if (paymentType === "emi" && emiDetails) {
      if (
        !emiDetails.numberOfInstallments ||
        !emiDetails.installmentAmount ||
        !emiDetails.frequency
      ) {
        return res.status(400).json({
          success: false,
          message:
            "EMI details must include number of installments, installment amount, and frequency",
        });
      }

      if (
        emiDetails.numberOfInstallments < 1 ||
        emiDetails.numberOfInstallments > 24
      ) {
        return res.status(400).json({
          success: false,
          message: "Number of installments must be between 1 and 24",
        });
      }

      if (emiDetails.installmentAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Installment amount must be greater than 0",
        });
      }

      const validFrequencies = ["weekly", "monthly", "quarterly"];
      if (!validFrequencies.includes(emiDetails.frequency)) {
        return res.status(400).json({
          success: false,
          message: "Frequency must be weekly, monthly, or quarterly",
        });
      }
    }

    // Check if users are friends
    const areFriends = await checkFriendship(requestorId, lenderId);
    if (!areFriends) {
      return res.status(400).json({
        success: false,
        message: "You can only request money from friends",
      });
    }

    // Check if lender exists
    const lender = await User.findById(lenderId);
    if (!lender) {
      return res.status(404).json({
        success: false,
        message: "Lender not found",
      });
    }

    // Create money request
    const moneyRequest = new MoneyRequest({
      requestor: requestorId,
      lender: lenderId,
      amount,
      description: description || "",
      paymentType: paymentType || "full_payment",
      emiDetails: paymentType === "emi" ? emiDetails : undefined,
    });

    await moneyRequest.save();

    // Populate the request with user details
    await moneyRequest.populate([
      { path: "requestor", select: "fullName email profilePicture" },
      { path: "lender", select: "fullName email profilePicture" },
    ]);

    // Send notification to lender
    try {
      const requestor = await User.findById(requestorId);
      await notificationService.notifyMoneyRequest(
        lenderId,
        requestorId,
        requestor.fullName,
        amount,
        moneyRequest._id
      );
    } catch (notifError) {
      console.error("Failed to send notification:", notifError);
      // Don't fail the request if notification fails
    }

    res.status(201).json({
      success: true,
      message: "Money request created successfully",
      data: { request: moneyRequest },
    });
  } catch (error) {
    console.error("Error creating money request:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create money request",
    });
  }
});

// GET /api/money/requests - Get user's money requests
router.get("/requests", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { type = "all" } = req.query; // 'sent', 'received', or 'all'

    let query = {};
    if (type === "sent") {
      query.requestor = userId;
    } else if (type === "received") {
      query.lender = userId;
    } else if (type === "rejected") {
      query.requestor = userId;
      query.status = "rejected";
    } else {
      query.$or = [{ requestor: userId }, { lender: userId }];
    }

    const requests = await MoneyRequest.find(query)
      .populate("requestor", "fullName email profilePicture")
      .populate("lender", "fullName email profilePicture")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: requests,
    });
  } catch (error) {
    console.error("Error fetching money requests:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch money requests",
    });
  }
});

// PUT /api/money/request/:id - Update request status (approve/reject)
router.put("/request/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    const userId = req.user.userId;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be either approved or rejected",
      });
    }

    // Require rejection reason when rejecting
    if (
      status === "rejected" &&
      (!rejectionReason || rejectionReason.trim().length === 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "Rejection reason is required when rejecting a request",
      });
    }

    const request = await MoneyRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Money request not found",
      });
    }

    // Only the lender can approve/reject
    if (request.lender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can approve or reject this request",
      });
    }

    if (request.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Request has already been processed",
      });
    }

    request.status = status;

    // Set rejection details if rejecting
    if (status === "rejected") {
      request.rejectionReason = rejectionReason.trim();
      request.rejectedAt = new Date();
    }

    await request.save();

    await request.populate([
      { path: "requestor", select: "fullName email profilePicture" },
      { path: "lender", select: "fullName email profilePicture" },
    ]);

    // Send notification for request rejection
    if (status === "rejected") {
      try {
        const lender = await User.findById(userId);
        await notificationService.notifyMoneyRequestRejected(
          request.requestor._id,
          userId,
          lender.fullName,
          request.amount,
          request._id
        );
      } catch (notifError) {
        console.error("Failed to send rejection notification:", notifError);
      }

      // Update good4it score for declining request
      try {
        await Good4ItScoreService.handleRequestDeclined(request._id, userId);
      } catch (scoreError) {
        console.error(
          "Failed to update score for request decline:",
          scoreError
        );
      }
    }

    res.json({
      success: true,
      message: `Request ${status} successfully`,
      data: { request },
    });
  } catch (error) {
    console.error("Error updating money request:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update money request",
    });
  }
});

// POST /api/money/approve-and-pay - Approve request and pay with proof (Correct Flow)
router.post(
  "/approve-and-pay",
  authenticateToken,
  (req, res, next) => {
    console.log("📥 Upload middleware started");
    uploadSingle(req, res, (err) => {
      if (err) {
        console.error("❌ Upload error:", err);
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
              success: false,
              message: "File size too large. Maximum size is 10MB.",
            });
          }
          if (err.code === "LIMIT_FILE_COUNT") {
            return res.status(400).json({
              success: false,
              message: "Too many files. Only one file is allowed.",
            });
          }
        }
        return res.status(400).json({
          success: false,
          message: err.message || "File upload error",
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      console.log("🔄 Approve-and-pay API called");
      console.log("📋 Request body:", req.body);
      console.log("📎 File uploaded:", !!req.file);
      console.log("👤 User ID:", req.user?.userId);

      const { requestId } = req.body;
      const userId = req.user.userId;

      if (!requestId) {
        return res.status(400).json({
          success: false,
          message: "Request ID is required",
        });
      }

      // Find the money request
      const request = await MoneyRequest.findById(requestId);
      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Money request not found",
        });
      }

      // Only the lender can approve and pay
      if (request.lender.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Only the lender can approve and pay this request",
        });
      }

      if (request.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: "Request must be pending to approve and pay",
        });
      }

      // Proof is required for payment
      if (!req.file) {
        console.log("❌ No file uploaded");
        return res.status(400).json({
          success: false,
          message: "Payment proof is required",
        });
      }

      console.log("✅ File upload successful:", {
        filename: req.file.filename,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });

      // Create transaction record
      const transaction = new MoneyTransaction({
        requestId: request._id,
        requestor: request.requestor,
        lender: request.lender,
        amount: request.amount,
        description: request.description,
        status: "money_sent",
        moneySentAt: new Date(),
      });

      // Handle proof upload
      const proof = new TransactionProof({
        transactionId: transaction._id,
        uploadedBy: userId,
        proofType: "money_sent",
        fileName: req.file.filename,
        filePath: req.file.path,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
      });

      await proof.save();
      transaction.moneySentProof = proof._id;
      await transaction.save();

      // Update request status to approved (but money already sent)
      request.status = "approved";
      await request.save();

      // Send notification to requestor
      try {
        const lender = await User.findById(userId);
        await notificationService.notifyMoneySent(
          request.requestor,
          userId,
          lender.fullName,
          request.amount,
          transaction._id
        );
      } catch (notifError) {
        console.error("Failed to send notification:", notifError);
      }

      // Update good4it score for completing transaction
      try {
        await Good4ItScoreService.handleTransactionCompleted(transaction._id);
      } catch (scoreError) {
        console.error(
          "Failed to update score for transaction completion:",
          scoreError
        );
      }

      console.log("✅ Transaction created and saved successfully");

      res.json({
        success: true,
        message:
          "Request approved and money sent successfully. Waiting for recipient confirmation.",
        data: { transaction },
      });
    } catch (error) {
      console.error("❌ Error approving and paying:", error);
      console.error("Error stack:", error.stack);
      res.status(500).json({
        success: false,
        message: "Failed to approve and pay request",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }
);

// GET /api/money/summary - Get financial summary
router.get("/summary", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Calculate totals using aggregation
    const [
      requestedResult,
      givenResult,
      receivedResult,
      returnedResult,
      pendingResult,
      forgivenResult,
      requestedCountResult,
      givenCountResult,
      receivedCountResult,
      returnedCountResult,
      pendingCountResult,
      rejectedCountResult,
      forgivenCountResult,
    ] = await Promise.all([
      // Total requested by user
      MoneyRequest.aggregate([
        { $match: { requestor: userId, status: "approved" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Total given by user (include all money lent, including forgiven)
      MoneyTransaction.aggregate([
        {
          $match: {
            lender: userId,
            status: {
              $in: ["money_received", "repayment_sent", "repaid", "forgiven"],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Total received (money actually received - include forgiven amounts)
      MoneyTransaction.aggregate([
        {
          $match: {
            requestor: userId,
            status: {
              $in: ["money_received", "repayment_sent", "repaid", "forgiven"],
            },
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Total returned (repayments made)
      MoneyTransaction.aggregate([
        { $match: { requestor: userId, status: "repaid" } },
        { $group: { _id: null, total: { $sum: "$repaymentAmount" } } },
      ]),

      // Total pending requests
      MoneyRequest.aggregate([
        {
          $match: {
            $or: [{ requestor: userId }, { lender: userId }],
            status: "pending",
          },
        },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Total forgiven (lender perspective)
      MoneyTransaction.aggregate([
        { $match: { lender: userId, status: "forgiven" } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $ifNull: [
                  "$forgivenAmount",
                  {
                    $subtract: [
                      "$amount",
                      { $ifNull: ["$repaymentAmount", 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]),

      // Transaction counts
      MoneyRequest.countDocuments({ requestor: userId, status: "approved" }),
      MoneyRequest.countDocuments({ lender: userId, status: "approved" }),
      MoneyTransaction.countDocuments({
        requestor: userId,
        status: {
          $in: ["money_received", "repayment_sent", "repaid", "forgiven"],
        },
      }),
      MoneyTransaction.countDocuments({ requestor: userId, status: "repaid" }),
      MoneyRequest.countDocuments({
        $or: [{ requestor: userId }, { lender: userId }],
        status: "pending",
      }),
      MoneyRequest.countDocuments({
        $or: [
          { requestor: userId, status: "rejected" },
          { lender: userId, status: "rejected" },
        ],
      }),
      MoneyTransaction.countDocuments({
        lender: userId,
        status: "forgiven",
      }),
    ]);

    // Get upcoming payments
    const upcomingToReturn = await MoneyTransaction.find({
      requestor: userId,
      status: { $in: ["money_received", "repayment_sent"] },
    })
      .populate("lender", "fullName email")
      .select("amount repaymentAmount lender createdAt")
      .sort({ createdAt: 1 });

    const upcomingToReceive = await MoneyTransaction.find({
      lender: userId,
      status: { $in: ["money_received", "repayment_sent"] },
    })
      .populate("requestor", "fullName email")
      .select("amount repaymentAmount requestor createdAt")
      .sort({ createdAt: 1 });

    const summary = {
      totalRequested: requestedResult[0]?.total || 0,
      totalGiven: givenResult[0]?.total || 0,
      totalReceived: receivedResult[0]?.total || 0,
      totalReturned: returnedResult[0]?.total || 0,
      totalPending: pendingResult[0]?.total || 0,
      totalForgiven: forgivenResult[0]?.total || 0,

      // Transaction counts for each category
      counts: {
        requested: requestedCountResult || 0,
        given: givenCountResult || 0,
        received: receivedCountResult || 0,
        returned: returnedCountResult || 0,
        pending: pendingCountResult || 0,
        rejected: rejectedCountResult || 0,
        forgiven: forgivenCountResult || 0,
      },

      upcomingToReturn: upcomingToReturn.map((t) => ({
        transactionId: t._id,
        amount: t.amount - (t.repaymentAmount || 0),
        lenderName: t.lender.fullName,
        dueDate: t.createdAt,
      })),
      upcomingToReceive: upcomingToReceive.map((t) => ({
        transactionId: t._id,
        amount: t.amount - (t.repaymentAmount || 0),
        borrowerName: t.requestor.fullName,
        expectedDate: t.createdAt,
      })),
    };

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Error fetching financial summary:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch financial summary",
    });
  }
});

// GET /api/money/summary/hero - Get financial summary optimized for HeroTabNavigator
router.get("/summary/hero", authenticateToken, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.userId);

    // Calculate totals and counts in parallel
    const [
      requestedData,
      givenData,
      receivedData,
      returnedData,
      pendingData,
      forgivenData,
      rejectedData,
      upcomingToReturnData,
      upcomingToReceiveData,
    ] = await Promise.all([
      // Total requested (only active requests and money_sent transactions - exclude completed)
      (async () => {
        const [pendingRequests, activeTransactions, completedTransactions] =
          await Promise.all([
            MoneyRequest.aggregate([
              {
                $match: {
                  requestor: userId,
                  status: { $in: ["pending", "approved"] },
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
            ]),
            MoneyTransaction.aggregate([
              { $match: { requestor: userId, status: "money_sent" } },
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
            ]),
            MoneyTransaction.find({
              requestor: userId,
              status: {
                $in: ["money_received", "repayment_sent", "repaid", "forgiven"],
              },
            }).select("requestId"),
          ]);

        // Get completed request IDs to exclude
        const completedRequestIds = completedTransactions
          .filter((t) => t.requestId) // Filter out null requestIds
          .map((t) => t.requestId.toString());

        // Get active transaction request IDs to avoid double counting
        const activeTransactionRequestIds = await MoneyTransaction.find({
          requestor: userId,
          status: "money_sent",
        }).select("requestId");
        const activeTransactionIds = activeTransactionRequestIds.map((t) =>
          t.requestId.toString()
        );

        // Count only pending/approved requests that haven't been completed AND don't have active transactions
        const activeRequests = await MoneyRequest.find({
          requestor: userId,
          status: { $in: ["pending", "approved"] },
          _id: {
            $nin: [
              ...completedRequestIds.map(
                (id) => new mongoose.Types.ObjectId(id)
              ),
              ...activeTransactionIds.map(
                (id) => new mongoose.Types.ObjectId(id)
              ),
            ],
          },
        });

        const activeRequestTotal = activeRequests.reduce(
          (sum, req) => sum + req.amount,
          0
        );
        const activeRequestCount = activeRequests.length;

        const transactionTotal = activeTransactions[0]?.total || 0;
        const transactionCount = activeTransactions[0]?.count || 0;

        return [
          {
            total: activeRequestTotal + transactionTotal,
            count: activeRequestCount + transactionCount,
          },
        ];
      })(),

      // Total given (money user has actually given to others - exclude forgiven)
      MoneyTransaction.aggregate([
        {
          $match: {
            lender: userId,
            status: {
              $in: ["money_received", "repayment_sent", "repaid"],
            },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
        },
      ]),

      // Total received (money user has actually received and confirmed - include forgiven)
      MoneyTransaction.aggregate([
        {
          $match: {
            requestor: userId,
            status: {
              $in: ["money_received", "repayment_sent", "repaid", "forgiven"],
            },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
        },
      ]),

      // Total returned - include all repayment transactions (awaiting confirmation and confirmed)
      MoneyTransaction.aggregate([
        {
          $match: {
            requestor: userId,
            $or: [
              { status: "repayment_sent" }, // Awaiting confirmation
              { status: "repaid" }, // Fully confirmed
              {
                // Partial repayments that were confirmed but not fully repaid
                status: "money_received",
                repaymentAmount: { $gt: 0 },
              },
            ],
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ["$repaymentAmount", 0] } },
            count: { $sum: 1 },
          },
        },
      ]),

      // Total pending
      MoneyRequest.aggregate([
        {
          $match: {
            $or: [{ requestor: userId }, { lender: userId }],
            status: "pending",
          },
        },
        {
          $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } },
        },
      ]),

      // Total forgiven (lender perspective)
      MoneyTransaction.aggregate([
        { $match: { lender: userId, status: "forgiven" } },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $ifNull: [
                  "$forgivenAmount",
                  {
                    $subtract: [
                      "$amount",
                      { $ifNull: ["$repaymentAmount", 0] },
                    ],
                  },
                ],
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),

      // Total rejected (both requestor and lender can see rejected requests)
      MoneyRequest.aggregate([
        {
          $match: {
            $or: [
              { requestor: userId, status: "rejected" },
              { lender: userId, status: "rejected" },
            ],
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),

      // Upcoming to return - all transactions where user owes money (has remaining balance)
      MoneyTransaction.aggregate([
        {
          $match: {
            requestor: userId,
            status: { $in: ["money_received", "repayment_sent"] },
            $expr: {
              $gt: [
                {
                  $subtract: ["$amount", { $ifNull: ["$repaymentAmount", 0] }],
                },
                0,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $subtract: ["$amount", { $ifNull: ["$repaymentAmount", 0] }],
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),

      // Upcoming to receive - all money owed to user (remaining balances from loans)
      MoneyTransaction.aggregate([
        {
          $match: {
            $or: [
              // Money sent to user (user is requestor, awaiting confirmation)
              { requestor: userId, status: "money_sent" },
              // Money owed to user (user is lender, has remaining balance)
              {
                lender: userId,
                status: { $in: ["money_received", "repayment_sent"] },
                $expr: {
                  $gt: [
                    {
                      $subtract: [
                        "$amount",
                        { $ifNull: ["$repaymentAmount", 0] },
                      ],
                    },
                    0,
                  ],
                },
              },
            ],
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: {
                  if: { $eq: ["$status", "money_sent"] },
                  then: "$amount", // Full amount for money_sent (awaiting confirmation)
                  else: {
                    $subtract: [
                      "$amount",
                      { $ifNull: ["$repaymentAmount", 0] },
                    ],
                  }, // Remaining amount for loans
                },
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const heroSummary = {
      totalRequested: requestedData[0]?.total || 0,
      totalGiven: givenData[0]?.total || 0,
      totalReceived: receivedData[0]?.total || 0,
      totalReturned: returnedData[0]?.total || 0,
      totalPending: pendingData[0]?.total || 0,
      totalForgiven: forgivenData[0]?.total || 0,

      upcomingToReturn: {
        amount: upcomingToReturnData[0]?.total || 0,
        count: upcomingToReturnData[0]?.count || 0,
      },
      upcomingToReceive: {
        amount: upcomingToReceiveData[0]?.total || 0,
        count: upcomingToReceiveData[0]?.count || 0,
      },

      counts: {
        requested: requestedData[0]?.count || 0,
        given: givenData[0]?.count || 0,
        received: receivedData[0]?.count || 0,
        returned: returnedData[0]?.count || 0,
        pending: pendingData[0]?.count || 0,
        rejected: rejectedData[0]?.count || 0,
        forgiven: forgivenData[0]?.count || 0,
      },
    };

    res.json({
      success: true,
      data: heroSummary,
    });
  } catch (error) {
    console.error("Error fetching hero financial summary:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch financial summary",
    });
  }
});

// GET /api/money/activity/:type - Get activity data for activity screens
router.get("/activity/:type", authenticateToken, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.userId);
    const { type } = req.params; // 'given', 'received', 'requested', 'returned'
    const { limit = 10 } = req.query;

    let activityData = [];

    if (type === "given") {
      // Money the user has given (lent) - only show transactions where user is lender
      // In the correct flow, money is sent when approving, so no separate "send money" step
      const transactions = await MoneyTransaction.find({
        lender: userId,
        status: {
          $in: ["money_sent", "money_received", "repayment_sent", "repaid"],
        },
      })
        .populate("requestor", "fullName email profilePicture")
        .populate("moneySentProof")
        .populate("repaymentSentProof")
        .populate("repaymentReceivedProof")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      activityData = transactions.map((transaction) => {
        const repaymentAmount = transaction.repaymentAmount || 0;
        const remainingAmount =
          transaction.status === "repaid" || transaction.status === "forgiven"
            ? 0
            : transaction.amount - repaymentAmount;
        const hasPartialRepayment = repaymentAmount > 0 && remainingAmount > 0;

        let status;
        if (transaction.status === "money_sent") {
          status = "Awaiting Confirmation";
        } else if (transaction.status === "money_received") {
          status = hasPartialRepayment
            ? `Money Received (${repaymentAmount} repaid)`
            : "Money Received";
        } else if (transaction.status === "repayment_sent") {
          status = "Repayment Pending";
        } else if (transaction.status === "forgiven") {
          status = "Debt Forgiven";
        } else {
          status = "Completed";
        }

        return {
          id: transaction._id,
          friend: {
            name: transaction.requestor.fullName,
            profilePicture: transaction.requestor.profilePicture,
          },
          amount: transaction.amount,
          status: status,
          progress:
            transaction.status === "money_sent"
              ? 40
              : transaction.status === "money_received"
              ? 60
              : transaction.status === "repayment_sent"
              ? 80
              : 100,
          paidAmount: repaymentAmount,
          remainingAmount: remainingAmount,
          hasPartialRepayment: hasPartialRepayment,
          createdAt: transaction.createdAt,
          hasProof: !!(
            transaction.moneySentProof ||
            transaction.moneyReceivedProof ||
            transaction.repaymentSentProof ||
            transaction.repaymentReceivedProof
          ),
          proofUrl: transaction.repaymentSentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.repaymentSentProof.fileName}`
            : transaction.moneySentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
            : null,
          repaymentProofUrl: transaction.repaymentSentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.repaymentSentProof.fileName}`
            : null,
          type: "transaction",
          actionRequired:
            transaction.status === "repayment_sent"
              ? "confirm_repayment"
              : null,
        };
      });
    } else if (type === "received") {
      // Money the user has received (transactions where user is requestor/borrower)
      // Show transactions that are not fully repaid (including partial repayments and forgiven)
      const transactions = await MoneyTransaction.find({
        requestor: userId,
        status: {
          $in: ["money_received", "repayment_sent", "forgiven", "repaid"],
        },
      })
        .populate("lender", "fullName email profilePicture")
        .populate("requestId", "paymentType emiDetails")
        .populate("moneySentProof")
        .populate("moneyReceivedProof")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      // Include context about task-based repayments/forgiveness
      const txIds = transactions.map((t) => t._id);
      const Task = require("../models/Task");
      const tasks = await Task.find({
        referenceTransaction: { $in: txIds },
        status: "confirmed",
      })
        .select(
          "referenceTransaction title isEmiTask emiForgiveness monetaryValue"
        )
        .lean();
      const txIdToTask = new Map();
      tasks.forEach((t) => {
        // If multiple tasks exist, prefer the latest confirmed by default
        txIdToTask.set(String(t.referenceTransaction), t);
      });

      activityData = transactions
        .map((transaction) => {
          const task = txIdToTask.get(String(transaction._id));

          // If fully repaid and no task involvement, hide from received list
          if (
            transaction.status === "repaid" &&
            !task &&
            (transaction.repaymentAmount || 0) >= transaction.amount
          ) {
            return null;
          }

          const wasSettledByTask = !!task;
          const status = (() => {
            if (transaction.status === "money_received")
              return "Money Received";
            if (transaction.status === "repayment_sent")
              return "Repayment Pending";
            if (transaction.status === "forgiven") return "Debt Forgiven";
            if (transaction.status === "repaid") {
              return wasSettledByTask ? "Settled via Task" : "Completed";
            }
            return "Completed";
          })();

          const progress = (() => {
            if (transaction.status === "money_received") return 60;
            if (transaction.status === "repayment_sent") return 80;
            return 100;
          })();

          const remainingAmount =
            transaction.status === "forgiven"
              ? 0
              : Math.max(
                  0,
                  transaction.amount - (transaction.repaymentAmount || 0)
                );

          return {
            id: transaction._id,
            friend: {
              name: transaction.lender.fullName,
              profilePicture: transaction.lender.profilePicture,
            },
            amount: transaction.amount,
            status,
            progress,
            paidAmount: transaction.repaymentAmount || 0,
            remainingAmount,
            createdAt: transaction.createdAt,
            hasProof: !!(
              transaction.moneySentProof || transaction.moneyReceivedProof
            ),
            proofUrl: transaction.moneySentProof?.fileName
              ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
              : null,
            type: "transaction",
            actionRequired: null,
            paymentType: transaction.requestId?.paymentType || "full_payment",
            emiDetails: transaction.requestId?.emiDetails,
            requestId: transaction.requestId?._id,
            // Extra context for frontend to display task note
            settledByTask: wasSettledByTask,
            taskTitle: task?.title,
            taskIsEmi: task?.isEmiTask || false,
            taskForgiveness: task?.emiForgiveness || undefined,
          };
        })
        .filter(Boolean);
    } else if (type === "pending") {
      // Pending requests the user received (where user is lender)
      const requests = await MoneyRequest.find({
        lender: userId,
        status: "pending",
      })
        .populate("requestor", "fullName email profilePicture")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit));

      activityData = requests.map((request) => ({
        id: request._id,
        friend: {
          name: request.requestor.fullName,
          profilePicture: request.requestor.profilePicture,
        },
        amount: request.amount,
        status: "Pending Response",
        progress: 0,
        paidAmount: 0,
        remainingAmount: request.amount,
        createdAt: request.createdAt,
        hasProof: false,
        type: "pending_request",
        actionRequired: "approve_and_pay",
      }));
    } else if (type === "requested") {
      // Money the user requested - look at requests and transactions where user is requestor
      const [pendingRequests, transactions] = await Promise.all([
        // Pending requests (rejected excluded by status filter)
        MoneyRequest.find({
          requestor: userId,
          status: { $in: ["pending", "approved"] },
        })
          .populate("lender", "fullName email profilePicture")
          .sort({ createdAt: -1 }),

        // Active transactions where user is requestor (only money_sent, not money_received)
        MoneyTransaction.find({
          requestor: userId,
          status: "money_sent",
        })
          .populate("lender", "fullName email profilePicture")
          .populate("moneySentProof")
          .populate("moneyReceivedProof")
          .sort({ createdAt: -1 }),
      ]);

      // Also get ALL transactions to exclude requests that have any transaction (including completed ones)
      const allTransactions = await MoneyTransaction.find({
        requestor: userId,
      }).select("requestId");

      const allRequestedData = [];

      // Get request IDs that already have ANY transactions (active or completed)
      const allTransactionRequestIds = allTransactions
        .filter((t) => t.requestId)
        .map((t) => t.requestId.toString());

      // Add pending/approved requests
      // Only include requests that don't already have ANY transactions (active or completed)
      // (rejected already excluded by status filter)
      pendingRequests.forEach((request) => {
        if (!allTransactionRequestIds.includes(request._id.toString())) {
          allRequestedData.push({
            id: request._id,
            friend: {
              name: request.lender.fullName,
              profilePicture: request.lender.profilePicture,
            },
            amount: request.amount,
            status:
              request.status === "pending"
                ? "Waiting for Approval"
                : "Approved - Awaiting Payment",
            progress: request.status === "pending" ? 10 : 30,
            paidAmount: 0,
            remainingAmount: request.amount,
            createdAt: request.createdAt,
            hasProof: false,
            type:
              request.status === "pending"
                ? "pending_request"
                : "approved_request",
            actionRequired: null,
          });
        }
      });

      // Add transactions
      transactions.forEach((transaction) => {
        allRequestedData.push({
          id: transaction._id,
          friend: {
            name: transaction.lender.fullName,
            profilePicture: transaction.lender.profilePicture,
          },
          amount: transaction.amount,
          status:
            transaction.status === "money_sent"
              ? "Confirm Receipt"
              : transaction.status === "money_received"
              ? "Money Received"
              : transaction.status === "repayment_sent"
              ? "Repayment Sent"
              : "Completed",
          progress:
            transaction.status === "money_sent"
              ? 50
              : transaction.status === "money_received"
              ? 70
              : transaction.status === "repayment_sent"
              ? 90
              : 100,
          paidAmount: transaction.status === "repaid" ? transaction.amount : 0,
          remainingAmount:
            transaction.status === "repaid" ? 0 : transaction.amount,
          createdAt: transaction.createdAt,
          hasProof: !!(
            transaction.moneySentProof || transaction.moneyReceivedProof
          ),
          proofUrl: transaction.moneySentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
            : null,
          type: "transaction",
          actionRequired:
            transaction.status === "money_sent" ? "confirm_receipt" : null,
        });
      });

      // Sort by creation date and limit
      allRequestedData.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      activityData = allRequestedData.slice(0, parseInt(limit));
    } else if (type === "rejected") {
      // Money requests that were rejected - show rejected requests where user is either requestor OR lender
      const requests = await MoneyRequest.find({
        $or: [
          { requestor: userId, status: "rejected" },
          { lender: userId, status: "rejected" },
        ],
      })
        .populate("lender", "fullName email profilePicture")
        .populate("requestor", "fullName email profilePicture")
        .sort({ rejectedAt: -1, createdAt: -1 })
        .limit(parseInt(limit));

      activityData = requests.map((request) => {
        // Determine the user's role and the other party
        const isRequestor =
          request.requestor._id.toString() === userId.toString();
        const isLender = request.lender._id.toString() === userId.toString();

        // The other party is the one who is NOT the current user
        const otherParty = isRequestor ? request.lender : request.requestor;
        const requestorName = request.requestor.fullName;
        const lenderName = request.lender.fullName;

        return {
          id: request._id,
          friend: {
            name: otherParty.fullName,
            profilePicture: otherParty.profilePicture,
          },
          amount: request.amount,
          status: "Rejected",
          progress: 0,
          paidAmount: 0,
          remainingAmount: request.amount,
          createdAt: request.createdAt,
          hasProof: false,
          proofUrl: null,
          type: "rejected",
          rejectionReason: request.rejectionReason,
          rejectedAt: request.rejectedAt,
          paymentType: request.paymentType,
          emiDetails: request.emiDetails,
          // Context about who asked whom
          isRequestor: isRequestor, // Current user is the requestor
          isLender: isLender, // Current user is the lender
          requestorName: requestorName,
          lenderName: lenderName,
        };
      });
    } else if (type === "returned") {
      // Money the user has returned (repaid) - show ALL repayment transactions
      // Include repayment_sent (awaiting confirmation) and repaid (confirmed)
      const transactions = await MoneyTransaction.find({
        requestor: userId,
        $or: [
          { status: "repayment_sent" }, // Awaiting confirmation
          { status: "repaid" }, // Fully confirmed
          {
            // Partial repayments that were confirmed but not fully repaid
            status: "money_received",
            repaymentAmount: { $gt: 0 },
          },
        ],
      })
        .populate("lender", "fullName email profilePicture")
        .populate("repaymentSentProof")
        .populate("repaymentReceivedProof")
        .sort({
          // Sort by repayment sent date first, then repayment received date, then created date
          repaymentSentAt: -1,
          repaymentReceivedAt: -1,
          createdAt: -1,
        })
        .limit(parseInt(limit));

      activityData = transactions.map((transaction) => {
        const repaymentAmount = transaction.repaymentAmount || 0;
        const isFullyRepaid = transaction.status === "repaid";
        const isAwaitingConfirmation = transaction.status === "repayment_sent";
        const isPartiallyRepaid =
          transaction.status === "money_received" && repaymentAmount > 0;

        let status, progress;
        if (isAwaitingConfirmation) {
          status = "Awaiting Confirmation";
          progress = 80;
        } else if (isFullyRepaid) {
          status = "Confirmed";
          progress = 100;
        } else if (isPartiallyRepaid) {
          status = "Partially Confirmed";
          progress = 90;
        } else {
          status = "Repaid";
          progress = 100;
        }

        return {
          id: transaction._id,
          friend: {
            name: transaction.lender.fullName,
            profilePicture: transaction.lender.profilePicture,
          },
          amount: repaymentAmount || transaction.amount,
          originalAmount: transaction.amount,
          status: status,
          progress: progress,
          paidAmount: repaymentAmount,
          remainingAmount: transaction.amount - repaymentAmount,
          createdAt:
            transaction.repaymentSentAt ||
            transaction.repaymentReceivedAt ||
            transaction.createdAt,
          hasProof: !!(
            transaction.repaymentSentProof || transaction.repaymentReceivedProof
          ),
          proofUrl: transaction.repaymentSentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.repaymentSentProof.fileName}`
            : null,
          type: "repaid_transaction",
          actionRequired: isAwaitingConfirmation
            ? "awaiting_confirmation"
            : null,
        };
      });
    } else if (type === "forgiven") {
      // Money the user has forgiven (lender perspective)
      const transactions = await MoneyTransaction.find({
        lender: userId,
        status: "forgiven",
      })
        .populate("requestor", "fullName email profilePicture")
        .populate("moneySentProof")
        .populate("repaymentSentProof")
        .populate("repaymentReceivedProof")
        .sort({ forgivenAt: -1 })
        .limit(parseInt(limit));

      activityData = transactions.map((transaction) => ({
        id: transaction._id,
        friend: {
          name: transaction.requestor.fullName,
          profilePicture: transaction.requestor.profilePicture,
        },
        amount:
          transaction.forgivenAmount ||
          transaction.amount - (transaction.repaymentAmount || 0),
        originalAmount: transaction.amount,
        status: "Forgiven",
        progress: 100,
        paidAmount: transaction.repaymentAmount || 0,
        remainingAmount: 0,
        createdAt: transaction.forgivenAt || transaction.createdAt,
        hasProof: !!(
          transaction.moneySentProof ||
          transaction.repaymentSentProof ||
          transaction.repaymentReceivedProof
        ),
        proofUrl: transaction.moneySentProof?.fileName
          ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
          : null,
        type: "forgiven_transaction",
        actionRequired: null,
      }));
    } else if (type === "upcoming") {
      // Upcoming transactions - money to receive and money to return
      const [upcomingToReceive, upcomingToReturn] = await Promise.all([
        // Money to receive - includes confirmations and outstanding loans
        MoneyTransaction.find({
          $or: [
            // Money sent to user (user is requestor, awaiting confirmation)
            { requestor: userId, status: "money_sent" },
            // Money owed to user (user is lender, has remaining balance)
            {
              lender: userId,
              status: { $in: ["money_received", "repayment_sent"] },
              $expr: {
                $gt: [
                  {
                    $subtract: [
                      "$amount",
                      { $ifNull: ["$repaymentAmount", 0] },
                    ],
                  },
                  0,
                ],
              },
            },
          ],
        })
          .populate("lender", "fullName email profilePicture")
          .populate("requestor", "fullName email profilePicture")
          .populate("moneySentProof")
          .populate("repaymentSentProof")
          .sort({ createdAt: -1 })
          .limit(parseInt(limit)),

        // Money user received and needs to return (user is requestor) - include partial repayments
        MoneyTransaction.find({
          requestor: userId,
          status: { $in: ["money_received", "repayment_sent"] },
          $expr: {
            $gt: [
              { $subtract: ["$amount", { $ifNull: ["$repaymentAmount", 0] }] },
              0,
            ],
          },
        })
          .populate("lender", "fullName email profilePicture")
          .sort({ moneyReceivedAt: -1 })
          .limit(parseInt(limit)),
      ]);

      const allUpcomingData = [];

      // Add upcoming to receive (money owed to user)
      upcomingToReceive.forEach((transaction) => {
        if (transaction.status === "money_sent") {
          // Money sent to user (user is requestor, awaiting confirmation)
          allUpcomingData.push({
            id: transaction._id,
            friend: {
              name: transaction.lender.fullName,
              profilePicture: transaction.lender.profilePicture,
            },
            amount: transaction.amount,
            status: "Confirm Receipt",
            progress: 50,
            paidAmount: 0,
            remainingAmount: transaction.amount,
            createdAt: transaction.moneySentAt,
            hasProof: !!transaction.moneySentProof,
            proofUrl: transaction.moneySentProof?.fileName
              ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
              : null,
            type: "upcoming_receive",
            actionRequired: "confirm_receipt",
          });
        } else if (
          transaction.status === "money_received" ||
          transaction.status === "repayment_sent"
        ) {
          // Money owed to user (user is lender, remaining balance)
          const repaymentAmount = transaction.repaymentAmount || 0;
          const remainingAmount = transaction.amount - repaymentAmount;

          allUpcomingData.push({
            id: transaction._id,
            friend: {
              name: transaction.requestor.fullName,
              profilePicture: transaction.requestor.profilePicture,
            },
            amount: remainingAmount, // Show remaining amount owed
            originalAmount: transaction.amount,
            status:
              transaction.status === "repayment_sent"
                ? "Repayment Pending"
                : "Outstanding Loan",
            progress: transaction.status === "repayment_sent" ? 80 : 60,
            paidAmount: repaymentAmount,
            remainingAmount: remainingAmount,
            createdAt: transaction.moneyReceivedAt || transaction.createdAt,
            hasProof: !!(
              transaction.moneySentProof || transaction.repaymentSentProof
            ),
            proofUrl: transaction.repaymentSentProof?.fileName
              ? `/uploads/transaction-proofs/${transaction.repaymentSentProof.fileName}`
              : transaction.moneySentProof?.fileName
              ? `/uploads/transaction-proofs/${transaction.moneySentProof.fileName}`
              : null,
            type: "upcoming_receive",
            actionRequired:
              transaction.status === "repayment_sent"
                ? "confirm_repayment"
                : null,
          });
        }
      });

      // Add upcoming to return (money user needs to repay)
      upcomingToReturn.forEach((transaction) => {
        const repaymentAmount = transaction.repaymentAmount || 0;
        const remainingAmount = transaction.amount - repaymentAmount;

        allUpcomingData.push({
          id: transaction._id,
          friend: {
            name: transaction.lender.fullName,
            profilePicture: transaction.lender.profilePicture,
          },
          amount: remainingAmount, // Show remaining amount, not original amount
          originalAmount: transaction.amount,
          status:
            transaction.status === "repayment_sent"
              ? "Repayment Pending"
              : "Repay Money",
          progress: transaction.status === "repayment_sent" ? 80 : 70,
          paidAmount: repaymentAmount,
          remainingAmount: remainingAmount,
          createdAt: transaction.moneyReceivedAt || transaction.createdAt,
          hasProof: !!transaction.repaymentSentProof,
          proofUrl: transaction.repaymentSentProof?.fileName
            ? `/uploads/transaction-proofs/${transaction.repaymentSentProof.fileName}`
            : null,
          type: "upcoming_return",
          actionRequired:
            transaction.status === "repayment_sent" ? null : "repay_money",
        });
      });

      // Sort by creation date
      allUpcomingData.sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
      );
      activityData = allUpcomingData.slice(0, parseInt(limit));
    }

    res.json({
      success: true,
      data: activityData,
    });
  } catch (error) {
    console.error("Error fetching activity data:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch activity data",
    });
  }
});

// GET /api/money/recent-transactions - Get recent transactions for HeroTabNavigator
router.get("/recent-transactions", authenticateToken, async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.user.userId);
    const { type = "all", limit = 4 } = req.query;

    let recentTransactions = [];

    if (type === "given" || type === "all") {
      // Get recent money given (actual transactions where user is lender and money was received)
      const givenTransactions = await MoneyTransaction.find({
        lender: userId,
        status: { $in: ["money_received", "repayment_sent", "repaid"] },
      })
        .populate("requestor", "fullName email profilePicture")
        .sort({ moneyReceivedAt: -1 })
        .limit(type === "given" ? parseInt(limit) : 4);

      const givenData = givenTransactions.map((txn) => ({
        id: txn._id,
        type: "given",
        friend: {
          name: txn.requestor.fullName,
          profilePicture: txn.requestor.profilePicture,
        },
        amount: txn.amount,
        date: txn.moneyReceivedAt || txn.createdAt,
        status: txn.status === "repaid" ? "Repaid" : "Active",
        description: txn.description,
      }));

      if (type === "given") {
        recentTransactions = givenData;
      } else {
        recentTransactions.push(...givenData);
      }
    }

    if (type === "received" || type === "all") {
      // Get recent money received (actual transactions where user is requestor and confirmed receipt)
      const receivedTransactions = await MoneyTransaction.find({
        requestor: userId,
        status: { $in: ["money_received", "repayment_sent", "repaid"] },
      })
        .populate("lender", "fullName email profilePicture")
        .sort({ moneyReceivedAt: -1 })
        .limit(type === "received" ? parseInt(limit) : 4);

      const receivedData = receivedTransactions.map((txn) => ({
        id: txn._id,
        type: "received",
        friend: {
          name: txn.lender.fullName,
          profilePicture: txn.lender.profilePicture,
        },
        amount: txn.amount,
        date: txn.moneyReceivedAt || txn.createdAt,
        status: txn.status === "repaid" ? "Repaid" : "Active",
        description: txn.description,
      }));

      if (type === "received") {
        recentTransactions = receivedData;
      } else {
        recentTransactions.push(...receivedTransactions);
      }
    }

    if (type === "requested" || type === "all") {
      // Get recent money requested (only active/pending requests and transactions)
      const [requestedRequests, activeTransactions, allTransactions] =
        await Promise.all([
          // Pending/approved requests (rejected excluded by status filter)
          MoneyRequest.find({
            requestor: userId,
            status: { $in: ["pending", "approved"] },
          })
            .populate("lender", "fullName email profilePicture")
            .sort({ createdAt: -1 }),

          // Active transactions (money sent, awaiting confirmation)
          MoneyTransaction.find({
            requestor: userId,
            status: "money_sent",
          })
            .populate("lender", "fullName email profilePicture")
            .sort({ moneySentAt: -1 }),

          // Get all transactions to exclude completed requests
          MoneyTransaction.find({
            requestor: userId,
            status: { $in: ["money_received", "repayment_sent", "repaid"] },
          }).select("requestId"),
        ]);

      const allRequestedData = [];
      const completedRequestIds = allTransactions
        .filter((t) => t.requestId)
        .map((t) => t.requestId.toString());
      const activeTransactionIds = activeTransactions
        .filter((t) => t.requestId)
        .map((t) => t.requestId.toString());

      // Add requests (only those that haven't been completed AND don't have active transactions)
      // (rejected already excluded by status filter)
      requestedRequests.forEach((req) => {
        if (
          !completedRequestIds.includes(req._id.toString()) &&
          !activeTransactionIds.includes(req._id.toString())
        ) {
          allRequestedData.push({
            id: req._id,
            type: "requested",
            friend: {
              name: req.lender.fullName,
              profilePicture: req.lender.profilePicture,
            },
            amount: req.amount,
            date: req.createdAt,
            status: req.status === "pending" ? "Pending" : "Approved",
            description: req.description,
          });
        }
      });

      // Add active transactions
      activeTransactions.forEach((txn) => {
        allRequestedData.push({
          id: txn._id,
          type: "requested",
          friend: {
            name: txn.lender.fullName,
            profilePicture: txn.lender.profilePicture,
          },
          amount: txn.amount,
          date: txn.moneySentAt || txn.createdAt,
          status: "Confirm Receipt",
          description: txn.description,
        });
      });

      // Sort by date and limit
      allRequestedData.sort((a, b) => new Date(b.date) - new Date(a.date));
      const requestedData = allRequestedData.slice(
        0,
        type === "requested" ? parseInt(limit) : 4
      );

      if (type === "requested") {
        recentTransactions = requestedData;
      } else {
        recentTransactions.push(...requestedData);
      }
    }

    if (type === "returned" || type === "all") {
      // Get recent repayments - include all repayment transactions (awaiting confirmation and confirmed)
      const returnedTransactions = await MoneyTransaction.find({
        requestor: userId,
        $or: [
          { status: "repayment_sent" }, // Awaiting confirmation
          { status: "repaid" }, // Fully confirmed
          {
            // Partial repayments that were confirmed but not fully repaid
            status: "money_received",
            repaymentAmount: { $gt: 0 },
          },
        ],
      })
        .populate("lender", "fullName email profilePicture")
        .sort({
          repaymentSentAt: -1,
          repaymentReceivedAt: -1,
          createdAt: -1,
        })
        .limit(type === "returned" ? parseInt(limit) : 4);

      const returnedData = returnedTransactions.map((transaction) => {
        const isAwaitingConfirmation = transaction.status === "repayment_sent";
        const isConfirmed = transaction.status === "repaid";
        const isPartiallyConfirmed =
          transaction.status === "money_received" &&
          transaction.repaymentAmount > 0;

        let status;
        if (isAwaitingConfirmation) {
          status = "Awaiting Confirmation";
        } else if (isConfirmed) {
          status = "Confirmed";
        } else if (isPartiallyConfirmed) {
          status = "Partially Confirmed";
        } else {
          status = "Completed";
        }

        return {
          id: transaction._id,
          type: "returned",
          friend: {
            name: transaction.lender.fullName,
            profilePicture: transaction.lender.profilePicture,
          },
          amount: transaction.repaymentAmount || 0,
          originalAmount: transaction.amount,
          date:
            transaction.repaymentSentAt ||
            transaction.repaymentReceivedAt ||
            transaction.createdAt,
          status: status,
          description: transaction.description,
        };
      });

      if (type === "returned") {
        recentTransactions = returnedData;
      } else {
        recentTransactions.push(...returnedData);
      }
    }

    if (type === "forgiven" || type === "all") {
      // Get recent forgiven transactions (lender perspective)
      const forgivenTransactions = await MoneyTransaction.find({
        lender: userId,
        status: "forgiven",
      })
        .populate("requestor", "fullName email profilePicture")
        .sort({ forgivenAt: -1 })
        .limit(type === "forgiven" ? parseInt(limit) : 4);

      const forgivenData = forgivenTransactions.map((transaction) => ({
        id: transaction._id,
        type: "forgiven",
        friend: {
          name: transaction.requestor.fullName,
          profilePicture: transaction.requestor.profilePicture,
        },
        amount:
          transaction.forgivenAmount ||
          transaction.amount - (transaction.repaymentAmount || 0),
        date: transaction.forgivenAt,
        status: "Forgiven",
        description: transaction.description,
      }));

      if (type === "forgiven") {
        recentTransactions = forgivenData;
      } else {
        recentTransactions.push(...forgivenData);
      }
    }

    // Sort all transactions by date if getting all types
    if (type === "all") {
      recentTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      recentTransactions = recentTransactions.slice(0, parseInt(limit));
    }

    res.json({
      success: true,
      data: recentTransactions,
    });
  } catch (error) {
    console.error("Error fetching recent transactions:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch recent transactions",
    });
  }
});

// GET /api/money/friend-details/:friendId - Get friend details with recent transactions
router.get("/friend-details/:friendId", authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.params;
    const currentUserId = req.user.userId;

    // Check if users are friends
    const areFriends = await checkFriendship(currentUserId, friendId);
    if (!areFriends) {
      return res.status(403).json({
        success: false,
        message: "You can only view details of your friends",
      });
    }

    // Get friend details
    const friend = await User.findById(friendId).select(
      "fullName email phoneNumber profilePicture good4itScore"
    );
    if (!friend) {
      return res.status(404).json({
        success: false,
        message: "Friend not found",
      });
    }

    // Get recent transactions between current user and friend (last 10)
    const [
      sentRequests,
      receivedRequests,
      sentTransactions,
      receivedTransactions,
    ] = await Promise.all([
      // Money requests sent to this friend
      MoneyRequest.find({
        requestor: currentUserId,
        lender: friendId,
        status: { $in: ["approved", "rejected"] },
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("amount status createdAt description"),

      // Money requests received from this friend
      MoneyRequest.find({
        requestor: friendId,
        lender: currentUserId,
        status: { $in: ["approved", "rejected"] },
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("amount status createdAt description"),

      // Transactions where current user sent money to friend
      MoneyTransaction.find({
        lender: currentUserId,
        requestor: friendId,
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("amount status createdAt description repaymentAmount"),

      // Transactions where friend sent money to current user
      MoneyTransaction.find({
        lender: friendId,
        requestor: currentUserId,
      })
        .sort({ createdAt: -1 })
        .limit(5)
        .select("amount status createdAt description repaymentAmount"),
    ]);

    // Format transactions for frontend
    const recentTransactions = [];

    // Add sent requests
    sentRequests.forEach((req) => {
      recentTransactions.push({
        _id: req._id,
        amount: req.amount,
        status: req.status,
        createdAt: req.createdAt,
        description: req.description || "Money request",
        type: "request_sent",
        displayType: "Requested",
      });
    });

    // Add received requests
    receivedRequests.forEach((req) => {
      recentTransactions.push({
        _id: req._id,
        amount: req.amount,
        status: req.status,
        createdAt: req.createdAt,
        description: req.description || "Money request",
        type: "request_received",
        displayType: "Request from friend",
      });
    });

    // Add sent transactions
    sentTransactions.forEach((transaction) => {
      recentTransactions.push({
        _id: transaction._id,
        amount: transaction.amount,
        status: transaction.status,
        createdAt: transaction.createdAt,
        description: transaction.description || "Money transfer",
        type: "money_sent",
        displayType: "Sent",
        repaymentAmount: transaction.repaymentAmount,
      });
    });

    // Add received transactions
    receivedTransactions.forEach((transaction) => {
      recentTransactions.push({
        _id: transaction._id,
        amount: transaction.amount,
        status: transaction.status,
        createdAt: transaction.createdAt,
        description: transaction.description || "Money transfer",
        type: "money_received",
        displayType: "Received",
        repaymentAmount: transaction.repaymentAmount,
      });
    });

    // Sort by date and limit to 10 most recent
    recentTransactions.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    const limitedTransactions = recentTransactions.slice(0, 10);

    // Calculate summary statistics
    const totalSent = sentTransactions.reduce((sum, t) => sum + t.amount, 0);
    const totalReceived = receivedTransactions.reduce(
      (sum, t) => sum + t.amount,
      0
    );
    const totalRepaid = receivedTransactions.reduce(
      (sum, t) => sum + (t.repaymentAmount || 0),
      0
    );
    const totalOwed = sentTransactions.reduce(
      (sum, t) => sum + (t.amount - (t.repaymentAmount || 0)),
      0
    );

    res.json({
      success: true,
      data: {
        friend: {
          _id: friend._id,
          fullName: friend.fullName,
          email: friend.email,
          phoneNumber: friend.phoneNumber,
          profilePicture: friend.profilePicture,
          good4itScore: friend.good4itScore,
        },
        recentTransactions: limitedTransactions,
        summary: {
          totalSent,
          totalReceived,
          totalRepaid,
          totalOwed,
          transactionCount: limitedTransactions.length,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching friend details:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch friend details",
    });
  }
});

// POST /api/money/send - Mark money as sent with proof upload (Lender pays and uploads proof)
router.post("/send", authenticateToken, uploadSingle, async (req, res) => {
  try {
    const { requestId } = req.body;
    const userId = req.user.userId;

    if (!requestId) {
      return res.status(400).json({
        success: false,
        message: "Request ID is required",
      });
    }

    // Find the money request
    const request = await MoneyRequest.findById(requestId);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Money request not found",
      });
    }

    // Only the lender can mark money as sent
    if (request.lender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can mark money as sent",
      });
    }

    if (request.status !== "approved") {
      return res.status(400).json({
        success: false,
        message: "Request must be approved to send money",
      });
    }

    // Create transaction record
    const transaction = new MoneyTransaction({
      requestId: request._id,
      requestor: request.requestor,
      lender: request.lender,
      amount: request.amount,
      description: request.description,
      status: "money_sent",
      moneySentAt: new Date(),
    });

    // Handle proof upload if provided
    if (req.file) {
      const proof = new TransactionProof({
        transactionId: transaction._id,
        uploadedBy: userId,
        proofType: "money_sent",
        fileName: req.file.filename,
        filePath: req.file.path,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
      });

      await proof.save();
      transaction.moneySentProof = proof._id;
    }

    await transaction.save();

    // Send notification to requestor
    try {
      const lender = await User.findById(userId);
      await notificationService.notifyMoneySent(
        transaction.requestor,
        userId,
        lender.fullName,
        transaction.amount,
        transaction._id
      );
    } catch (notifError) {
      console.error("Failed to send notification:", notifError);
    }

    // Keep request as approved - the transaction tracks the actual money flow
    // request.status remains 'approved'

    res.json({
      success: true,
      message: "Money sent successfully, waiting for recipient confirmation",
      data: { transaction },
    });
  } catch (error) {
    console.error("Error sending money:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send money",
    });
  }
});

// POST /api/money/confirm-receipt - Confirm money receipt (Requestor confirms they received money)
router.post(
  "/confirm-receipt",
  authenticateToken,
  (req, res, next) => {
    console.log("📥 Confirm receipt - upload middleware started");
    uploadSingle(req, res, (err) => {
      if (err) {
        console.error("❌ Upload error:", err);
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
              success: false,
              message: "File size too large. Maximum size is 10MB.",
            });
          }
          if (err.code === "LIMIT_FILE_COUNT") {
            return res.status(400).json({
              success: false,
              message: "Too many files. Only one file is allowed.",
            });
          }
        }
        return res.status(400).json({
          success: false,
          message: err.message || "File upload error",
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      console.log("🔄 Confirm receipt request received");
      console.log("Request body:", req.body);
      console.log("User ID:", req.user?.userId);
      console.log("File uploaded:", !!req.file);

      const { transactionId } = req.body;
      const userId = req.user.userId;

      if (!transactionId) {
        return res.status(400).json({
          success: false,
          message: "Transaction ID is required",
        });
      }

      // Find the transaction
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Only the requestor can confirm receipt
      if (transaction.requestor.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Only the requestor can confirm receipt",
        });
      }

      if (transaction.status !== "money_sent") {
        return res.status(400).json({
          success: false,
          message: "Money must be sent first before confirming receipt",
        });
      }

      // Handle proof upload if provided
      if (req.file) {
        const proof = new TransactionProof({
          transactionId: transaction._id,
          uploadedBy: userId,
          proofType: "money_received",
          fileName: req.file.filename,
          filePath: req.file.path,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
        });

        await proof.save();
        transaction.moneyReceivedProof = proof._id;
      }

      // Update transaction status
      transaction.status = "money_received";
      transaction.moneyReceivedAt = new Date();
      await transaction.save();

      // Send notification to lender about receipt confirmation
      try {
        const recipient = await User.findById(userId);
        await notificationService.notifyMoneyReceiptConfirmed(
          transaction.lender,
          userId,
          recipient.fullName,
          transaction.amount,
          transaction._id
        );
      } catch (notifError) {
        console.error(
          "Failed to send receipt confirmation notification:",
          notifError
        );
      }

      // Update good4it score for confirming receipt
      try {
        await Good4ItScoreService.updateScore(
          userId,
          "transaction_completed",
          Good4ItScoreService.calculateScoreChange(
            "transaction_completed",
            transaction.amount
          ),
          `Confirmed receipt of $${transaction.amount} from ${transaction.lender}`,
          { transactionId: transaction._id },
          transaction._id
        );
      } catch (scoreError) {
        console.error(
          "Failed to update score for receipt confirmation:",
          scoreError
        );
      }

      // Keep the original request as approved - the transaction tracks the actual status

      res.json({
        success: true,
        message: "Money receipt confirmed successfully",
        data: { transaction },
      });
    } catch (error) {
      console.error("Error confirming receipt:", error);
      console.error("Error stack:", error.stack);
      console.error("Request body:", req.body);
      console.error("User ID:", req.user?.userId);

      res.status(500).json({
        success: false,
        message: "Failed to confirm receipt: " + error.message,
        error:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }
);

// POST /api/money/send-reminder - Send repayment reminder
router.post("/send-reminder", authenticateToken, async (req, res) => {
  try {
    const { transactionId, message } = req.body;
    const userId = req.user.userId;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required",
      });
    }

    // Find the transaction
    const transaction = await MoneyTransaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // Only the lender can send reminders
    if (transaction.lender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can send repayment reminders",
      });
    }

    if (transaction.status !== "money_received") {
      return res.status(400).json({
        success: false,
        message: "Can only send reminders for received money",
      });
    }

    // Create reminder record
    const reminder = new RepaymentReminder({
      transactionId: transaction._id,
      sender: userId,
      recipient: transaction.requestor,
      message: message || "Please repay the money you borrowed.",
    });

    await reminder.save();

    // Send notification to borrower about reminder
    try {
      const lender = await User.findById(userId);
      await notificationService.notifyRepaymentReminder(
        transaction.requestor,
        userId,
        lender.fullName,
        transaction.amount,
        transaction._id
      );
    } catch (notifError) {
      console.error("Failed to send reminder notification:", notifError);
    }

    res.json({
      success: true,
      message: "Reminder sent successfully",
      data: { reminder },
    });
  } catch (error) {
    console.error("Error sending reminder:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send reminder",
    });
  }
});

// POST /api/money/repay - Send repayment with proof
router.post(
  "/repay",
  (req, res, next) => {
    console.log("🚀 REPAY API - Raw request received");
    console.log("📋 Headers:", req.headers);
    console.log("📋 Content-Type:", req.get("Content-Type"));
    console.log(
      "📋 Authorization:",
      req.get("Authorization") ? "Present" : "Missing"
    );
    next();
  },
  authenticateToken,
  (req, res, next) => {
    console.log("🔐 REPAY API - Auth middleware passed");
    console.log("👤 User:", req.user);
    next();
  },
  uploadSingle,
  async (req, res) => {
    console.log("🔄 REPAY API - Upload middleware passed");
    console.log("📋 Request body:", req.body);
    console.log(
      "📎 File info:",
      req.file
        ? {
            filename: req.file.filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
          }
        : "No file uploaded"
    );

    try {
      const { transactionId, amount } = req.body;
      const userId = req.user.userId;

      console.log("✅ REPAY API - Parsed data:", {
        transactionId,
        amount,
        userId,
      });

      if (!transactionId || !amount) {
        console.log("❌ REPAY API - Missing required fields:", {
          transactionId,
          amount,
        });
        return res.status(400).json({
          success: false,
          message: "Transaction ID and amount are required",
        });
      }

      // Find the transaction
      console.log("🔍 REPAY API - Looking for transaction:", transactionId);
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        console.log("❌ REPAY API - Transaction not found:", transactionId);
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }
      console.log("✅ REPAY API - Transaction found:", {
        id: transaction._id,
        amount: transaction.amount,
        status: transaction.status,
        requestor: transaction.requestor,
        lender: transaction.lender,
      });

      // Only the requestor (borrower) can repay
      if (transaction.requestor.toString() !== userId) {
        console.log(
          "❌ REPAY API - Permission denied. Transaction requestor:",
          transaction.requestor,
          "User ID:",
          userId
        );
        return res.status(403).json({
          success: false,
          message: "Only the borrower can send repayment",
        });
      }
      console.log("✅ REPAY API - Permission check passed");

      if (transaction.status !== "money_received") {
        console.log(
          "❌ REPAY API - Invalid status. Current status:",
          transaction.status,
          "Required: money_received"
        );
        return res.status(400).json({
          success: false,
          message: "Can only repay after money has been received",
        });
      }
      console.log("✅ REPAY API - Status check passed");

      // Handle proof upload if provided
      if (req.file) {
        console.log("📎 REPAY API - Processing proof upload");
        try {
          const proof = new TransactionProof({
            transactionId: transaction._id,
            uploadedBy: userId,
            proofType: "repayment_sent",
            fileName: req.file.filename,
            filePath: req.file.path,
            fileSize: req.file.size,
            mimeType: req.file.mimetype,
          });

          await proof.save();
          transaction.repaymentSentProof = proof._id;
          console.log("✅ REPAY API - Proof saved successfully:", proof._id);
        } catch (proofError) {
          console.error("❌ REPAY API - Proof save failed:", proofError);
          throw proofError;
        }
      } else {
        console.log("⚠️ REPAY API - No proof file provided");
      }

      // Update transaction - accumulate repayment amount for partial repayments
      console.log("💾 REPAY API - Updating transaction");

      // Check previous status before updating
      const previousStatus = transaction.status;
      const previousRepaymentAmount = transaction.repaymentAmount || 0;

      // Accumulate repayment amount (for partial repayments over time)
      // If status was money_received (previous repayment confirmed), add to existing amount
      // If status was repayment_sent (previous repayment not yet confirmed), replace it
      if (previousStatus === "money_received" && previousRepaymentAmount > 0) {
        transaction.repaymentAmount =
          previousRepaymentAmount + parseFloat(amount);
      } else {
        // For new repayments or replacing unconfirmed repayments
        transaction.repaymentAmount = parseFloat(amount);
      }

      transaction.status = "repayment_sent";
      transaction.repaymentSentAt = new Date();

      await transaction.save();
      console.log("✅ REPAY API - Transaction updated successfully");

      // Send notification to lender
      try {
        const borrower = await User.findById(userId);
        await notificationService.notifyRepaymentReceived(
          transaction.lender,
          userId,
          borrower.fullName,
          parseFloat(amount),
          transaction._id
        );
      } catch (notifError) {
        console.error("Failed to send notification:", notifError);
      }

      // Update good4it score for sending repayment
      try {
        await Good4ItScoreService.updateScore(
          userId,
          "repayment_completed",
          Good4ItScoreService.calculateScoreChange(
            "repayment_completed",
            parseFloat(amount)
          ),
          `Sent repayment of $${amount} to ${transaction.lender}`,
          { transactionId: transaction._id },
          transaction._id
        );
      } catch (scoreError) {
        console.error("Failed to update score for repayment sent:", scoreError);
      }

      console.log("🎉 REPAY API - Success! Sending response");
      res.json({
        success: true,
        message: "Repayment sent successfully, waiting for confirmation",
        data: { transaction },
      });
    } catch (error) {
      console.error("❌ REPAY API - Error occurred:", error);
      console.error("❌ REPAY API - Error stack:", error.stack);
      res.status(500).json({
        success: false,
        message: "Failed to send repayment",
      });
    }
  }
);

// Add error handler specifically for repay endpoint
router.use("/repay", (error, req, res, next) => {
  console.error("❌ REPAY API - Middleware error:", error);
  console.error("❌ REPAY API - Error type:", error.constructor.name);

  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File size too large. Maximum size is 10MB.",
    });
  }

  if (error.message === "Only image files (JPEG, PNG, HEIC) are allowed") {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error in repay endpoint",
  });
});

// POST /api/money/confirm-repayment - Confirm repayment received
router.post(
  "/confirm-repayment",
  authenticateToken,
  uploadSingle,
  async (req, res) => {
    try {
      console.log("🔄 Confirm repayment request received");
      console.log("Request body:", req.body);
      console.log("User ID:", req.user?.userId);
      console.log("File uploaded:", !!req.file);

      const { transactionId } = req.body;
      const userId = req.user.userId;

      if (!transactionId) {
        return res.status(400).json({
          success: false,
          message: "Transaction ID is required",
        });
      }

      // Find the transaction
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Only the lender can confirm repayment
      if (transaction.lender.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Only the lender can confirm repayment",
        });
      }

      if (transaction.status !== "repayment_sent") {
        return res.status(400).json({
          success: false,
          message: "Repayment must be sent first before confirming",
        });
      }

      // Handle proof upload if provided
      if (req.file) {
        const proof = new TransactionProof({
          transactionId: transaction._id,
          uploadedBy: userId,
          proofType: "repayment_received",
          fileName: req.file.filename,
          filePath: req.file.path,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
        });

        await proof.save();
        transaction.repaymentReceivedProof = proof._id;
      }

      // Update transaction status based on repayment amount
      transaction.repaymentReceivedAt = new Date();

      // Check if this is a full repayment
      const totalRepaid = transaction.repaymentAmount || 0;
      const isFullyRepaid = totalRepaid >= transaction.amount;

      if (isFullyRepaid) {
        transaction.status = "repaid";
      } else {
        // Partial repayment - keep as money_received so it stays in received tab
        transaction.status = "money_received";
      }

      await transaction.save();

      // Send notification to borrower
      try {
        const lender = await User.findById(userId);
        await notificationService.notifyRepaymentConfirmed(
          transaction.requestor,
          userId,
          lender.fullName,
          transaction.repaymentAmount || transaction.amount,
          transaction._id
        );
      } catch (notifError) {
        console.error("Failed to send notification:", notifError);
      }

      // Update good4it score for confirming repayment
      try {
        // Check if repayment is early (within 24 hours of money received)
        const moneyReceivedAt = transaction.moneyReceivedAt;
        const repaymentReceivedAt = transaction.repaymentReceivedAt;
        const isEarlyRepayment =
          moneyReceivedAt &&
          repaymentReceivedAt &&
          repaymentReceivedAt - moneyReceivedAt < 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        // Check if repayment is late (more than 7 days after money received)
        const isLateRepayment =
          moneyReceivedAt &&
          repaymentReceivedAt &&
          repaymentReceivedAt - moneyReceivedAt > 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

        const changeType = isEarlyRepayment
          ? "early_repayment"
          : isLateRepayment
          ? "late_repayment"
          : "repayment_completed";

        await Good4ItScoreService.updateScore(
          userId,
          changeType,
          Good4ItScoreService.calculateScoreChange(
            changeType,
            transaction.repaymentAmount || transaction.amount,
            isLateRepayment
          ),
          `${
            isEarlyRepayment ? "Early" : isLateRepayment ? "Late" : "Confirmed"
          } repayment of $${amount} to ${transaction.requestor}`,
          {
            transactionId: transaction._id,
            isEarlyRepayment,
            isLateRepayment,
            daysDiff: moneyReceivedAt
              ? Math.floor(
                  (repaymentReceivedAt - moneyReceivedAt) /
                    (24 * 60 * 60 * 1000)
                )
              : 0,
          },
          transaction._id
        );
      } catch (scoreError) {
        console.error(
          "Failed to update score for repayment confirmation:",
          scoreError
        );
      }

      res.json({
        success: true,
        message: "Repayment confirmed successfully",
        data: { transaction },
      });
    } catch (error) {
      console.error("Error confirming repayment:", error);
      console.error("Error stack:", error.stack);
      console.error("Request body:", req.body);
      console.error("User ID:", req.user?.userId);

      res.status(500).json({
        success: false,
        message: "Failed to confirm repayment: " + error.message,
        error:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }
);

// GET /api/money/good4it-score/:userId - Get Good4It score for a user
router.get("/good4it-score/:userId", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user.userId;

    // Check if users are friends
    const areFriends = await checkFriendship(currentUserId, userId);
    if (!areFriends) {
      return res.status(403).json({
        success: false,
        message: "You can only view Good4It scores of your friends",
      });
    }

    // Get user with score
    const user = await User.findById(userId).select(
      "fullName email good4itScore"
    );
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Calculate score based on transaction history
    const [lendingHistory, borrowingHistory, overdueCount] = await Promise.all([
      // Count successful lending transactions
      MoneyTransaction.countDocuments({
        lender: userId,
        status: "repaid",
      }),

      // Count successful borrowing and repayment
      MoneyTransaction.countDocuments({
        requestor: userId,
        status: "repaid",
      }),

      // Count overdue transactions (simplified - would need date logic)
      MoneyTransaction.countDocuments({
        requestor: userId,
        status: { $in: ["money_received", "repayment_sent"] },
      }),
    ]);

    // Simple scoring algorithm (0-100 scale)
    let calculatedScore = 50; // Base score (middle of 0-100)
    calculatedScore += lendingHistory * 2; // +2 for each successful lending
    calculatedScore += borrowingHistory * 3; // +3 for each successful repayment
    calculatedScore -= overdueCount * 1; // -1 for each overdue payment

    // Ensure score is within bounds (0-100)
    calculatedScore = Math.max(0, Math.min(100, calculatedScore));

    // Update user's score if it's different
    if (user.good4itScore !== calculatedScore) {
      await User.findByIdAndUpdate(userId, { good4itScore: calculatedScore });
    }

    res.json({
      success: true,
      data: {
        userId: user._id,
        fullName: user.fullName,
        email: user.email,
        good4itScore: calculatedScore,
      },
    });
  } catch (error) {
    console.error("Error fetching Good4It score:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch Good4It score",
    });
  }
});

// Error handling middleware
// POST /api/money/forgive - Forgive a debt (lender only)
router.post("/forgive", authenticateToken, async (req, res) => {
  try {
    console.log("🔄 Forgive debt request received");
    console.log("Request body:", req.body);
    console.log("User ID:", req.user?.userId);

    const { transactionId } = req.body;
    const userId = req.user.userId;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required",
      });
    }

    // Find the transaction
    const transaction = await MoneyTransaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // Only the lender can forgive debt
    if (transaction.lender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can forgive debt",
      });
    }

    // Can only forgive if there's remaining debt
    const remainingAmount =
      transaction.amount - (transaction.repaymentAmount || 0);
    if (remainingAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "No remaining debt to forgive",
      });
    }

    // Update transaction status to forgiven
    transaction.status = "forgiven";
    transaction.forgivenAt = new Date();
    transaction.forgivenAmount = remainingAmount;

    await transaction.save();

    // Send notification to borrower
    try {
      const lender = await User.findById(userId);
      await notificationService.notifyDebtForgiven(
        transaction.requestor,
        userId,
        lender.fullName,
        remainingAmount,
        transaction._id
      );
    } catch (notifError) {
      console.error("Failed to send debt forgiven notification:", notifError);
    }

    // Update good4it score for forgiveness
    try {
      await Good4ItScoreService.handleForgiveness(
        transaction._id,
        remainingAmount
      );
    } catch (scoreError) {
      console.error("Failed to update score for forgiveness:", scoreError);
    }

    res.json({
      success: true,
      message: "Debt forgiven successfully",
      data: {
        transaction,
        forgivenAmount: remainingAmount,
      },
    });
  } catch (error) {
    console.error("Error forgiving debt:", error);
    console.error("Error stack:", error.stack);
    console.error("Request body:", req.body);
    console.error("User ID:", req.user?.userId);

    res.status(500).json({
      success: false,
      message: "Failed to forgive debt: " + error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});

// POST /api/money/update-fcm-token - Update user's FCM token
router.post("/update-fcm-token", authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    const userId = req.user.userId;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: "FCM token is required",
      });
    }

    // Update user's FCM token
    const User = require("../models/User");
    await User.findByIdAndUpdate(userId, { fcmToken });

    res.json({
      success: true,
      message: "FCM token updated successfully",
    });
  } catch (error) {
    console.error("Error updating FCM token:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update FCM token",
    });
  }
});

router.use(handleUploadError);

// POST /api/money/test-all-notifications - Test all notification types (for APK testing)
router.post("/test-all-notifications", authenticateToken, async (req, res) => {
  try {
    const { recipientId } = req.body;
    const userId = req.user.userId;

    if (!recipientId) {
      return res.status(400).json({
        success: false,
        message: "recipientId is required",
      });
    }

    const sender = await User.findById(userId);
    const recipient = await User.findById(recipientId);

    if (!sender || !recipient) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const testAmount = 100;
    const notifications = [];

    // Test all notification types
    try {
      // 1. Money Request
      const result1 = await notificationService.notifyMoneyRequest(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({ type: "money_request", success: !!result1 });

      // 2. Money Request Rejected
      const result2 = await notificationService.notifyMoneyRequestRejected(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({
        type: "money_request_rejected",
        success: !!result2,
      });

      // 3. Money Sent
      const result3 = await notificationService.notifyMoneySent(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({ type: "money_sent", success: !!result3 });

      // 4. Money Receipt Confirmed
      const result4 = await notificationService.notifyMoneyReceiptConfirmed(
        userId,
        recipientId,
        recipient.fullName,
        testAmount
      );
      notifications.push({
        type: "money_receipt_confirmed",
        success: !!result4,
      });

      // 5. Repayment Received
      const result5 = await notificationService.notifyRepaymentReceived(
        userId,
        recipientId,
        recipient.fullName,
        testAmount
      );
      notifications.push({ type: "repayment_received", success: !!result5 });

      // 6. Repayment Confirmed
      const result6 = await notificationService.notifyRepaymentConfirmed(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({ type: "repayment_confirmed", success: !!result6 });

      // 7. Debt Forgiven
      const result7 = await notificationService.notifyDebtForgiven(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({ type: "debt_forgiven", success: !!result7 });

      // 8. Repayment Reminder
      const result8 = await notificationService.notifyRepaymentReminder(
        recipientId,
        userId,
        sender.fullName,
        testAmount
      );
      notifications.push({ type: "repayment_reminder", success: !!result8 });
    } catch (notifError) {
      console.error("Error in notification testing:", notifError);
    }

    res.json({
      success: true,
      message: "All notification types tested",
      data: {
        sender: sender.fullName,
        recipient: recipient.fullName,
        testAmount,
        notifications,
        totalTypes: notifications.length,
        successfulTypes: notifications.filter((n) => n.success).length,
      },
    });
  } catch (error) {
    console.error("Error in test-all-notifications:", error);
    res.status(500).json({
      success: false,
      message: "Failed to test notifications",
      error: error.message,
    });
  }
});

// POST /api/money/remind-repayment - Send repayment reminder
router.post("/remind-repayment", authenticateToken, async (req, res) => {
  try {
    const { transactionId } = req.body;
    const userId = req.user.userId;

    console.log("💬 REMIND API - Request received:", { transactionId, userId });

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required",
      });
    }

    // Find the transaction
    const transaction = await MoneyTransaction.findById(transactionId)
      .populate("requestor", "fullName email")
      .populate("lender", "fullName email");

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // Verify the user is the lender
    if (transaction.lender._id.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can send repayment reminders",
      });
    }

    // Check if transaction is in a state where reminder makes sense
    const validStatuses = ["money_received", "repayment_sent"];
    if (!validStatuses.includes(transaction.status)) {
      return res.status(400).json({
        success: false,
        message: "Cannot send reminder for this transaction status",
      });
    }

    // Calculate remaining amount
    const totalAmount = transaction.amount;
    const paidAmount = transaction.repaymentAmount || 0;
    const remainingAmount = totalAmount - paidAmount;

    if (remainingAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "This transaction has been fully repaid",
      });
    }

    // Send reminder notification
    try {
      const lender = await User.findById(userId);
      await notificationService.notifyRepaymentReminder(
        transaction.requestor._id,
        userId,
        lender.fullName,
        remainingAmount,
        transaction._id
      );
    } catch (notifError) {
      console.error("Failed to send reminder notification:", notifError);
    }

    console.log("✅ REMIND API - Reminder sent successfully");
    res.json({
      success: true,
      message: "Repayment reminder sent successfully",
      data: {
        transaction: {
          id: transaction._id,
          borrower: transaction.requestor.fullName,
          amount: totalAmount,
          remainingAmount,
          status: transaction.status,
        },
      },
    });
  } catch (error) {
    console.error("❌ REMIND API - Error occurred:", error);
    res.status(500).json({
      success: false,
      message: "Failed to send repayment reminder",
      error: error.message,
    });
  }
});

// POST /api/money/dispute - Create a dispute
router.post(
  "/dispute",
  authenticateToken,
  upload.array("evidence", 5),
  async (req, res) => {
    try {
      const { transactionId, disputeType, description } = req.body;
      const userId = req.user.userId;

      if (!transactionId || !disputeType || !description) {
        return res.status(400).json({
          success: false,
          message: "Transaction ID, dispute type, and description are required",
        });
      }

      // Find the transaction
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Verify the user is involved in the transaction
      if (
        transaction.requestor.toString() !== userId &&
        transaction.lender.toString() !== userId
      ) {
        return res.status(403).json({
          success: false,
          message: "You can only dispute transactions you are involved in",
        });
      }

      // Check if dispute already exists
      const existingDispute = await Dispute.findOne({
        transactionId,
        disputer: userId,
        status: "pending",
      });

      if (existingDispute) {
        return res.status(400).json({
          success: false,
          message: "A pending dispute already exists for this transaction",
        });
      }

      // Handle evidence uploads
      const evidence = [];
      if (req.files && req.files.length > 0) {
        req.files.forEach((file) => {
          evidence.push({
            fileName: file.filename,
            filePath: file.path,
            fileSize: file.size,
            mimeType: file.mimetype,
          });
        });
      }

      // Create dispute
      const dispute = new Dispute({
        transactionId,
        disputer: userId,
        disputeType,
        description,
        evidence,
      });

      await dispute.save();

      // Handle score update for dispute creation
      try {
        await Good4ItScoreService.handleDisputeCreated(dispute._id);
      } catch (scoreError) {
        console.error(
          "Failed to update score for dispute creation:",
          scoreError
        );
      }

      res.json({
        success: true,
        message: "Dispute created successfully",
        data: { dispute },
      });
    } catch (error) {
      console.error("Error creating dispute:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create dispute",
      });
    }
  }
);

// GET /api/money/disputes - Get user's disputes
router.get("/disputes", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status = "all" } = req.query;

    let query = { disputer: userId };
    if (status !== "all") {
      query.status = status;
    }

    const disputes = await Dispute.find(query)
      .populate("transactionId", "amount description status")
      .populate("disputer", "fullName email")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: disputes,
    });
  } catch (error) {
    console.error("Error fetching disputes:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch disputes",
    });
  }
});

// PUT /api/money/dispute/:id/resolve - Resolve a dispute (admin only for now)
router.put("/dispute/:id/resolve", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution, resolutionNotes } = req.body;
    const userId = req.user.userId;

    if (!resolution) {
      return res.status(400).json({
        success: false,
        message: "Resolution is required",
      });
    }

    // Find the dispute
    const dispute = await Dispute.findById(id);
    if (!dispute) {
      return res.status(404).json({
        success: false,
        message: "Dispute not found",
      });
    }

    if (dispute.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Dispute has already been resolved",
      });
    }

    // Update dispute resolution
    dispute.status = "resolved";
    dispute.resolution = {
      resolvedBy: userId,
      resolution,
      resolutionNotes,
      resolvedAt: new Date(),
    };

    await dispute.save();

    // Handle score updates for dispute resolution
    try {
      await Good4ItScoreService.handleDisputeResolved(dispute._id, resolution);
    } catch (scoreError) {
      console.error(
        "Failed to update score for dispute resolution:",
        scoreError
      );
    }

    res.json({
      success: true,
      message: "Dispute resolved successfully",
      data: { dispute },
    });
  } catch (error) {
    console.error("Error resolving dispute:", error);
    res.status(500).json({
      success: false,
      message: "Failed to resolve dispute",
    });
  }
});

// GET /api/money/good4it-score - Get current user's good4it score breakdown
router.get("/good4it-score", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const scoreBreakdown = await Good4ItScoreService.getScoreBreakdown(userId);

    res.json({
      success: true,
      data: scoreBreakdown,
    });
  } catch (error) {
    console.error("Error fetching good4it score:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch good4it score",
    });
  }
});

// GET /api/money/good4it-score/history - Get user's score history
router.get("/good4it-score/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { limit = 20 } = req.query;

    const scoreHistory = await Good4ItScoreService.getScoreHistory(
      userId,
      parseInt(limit)
    );

    res.json({
      success: true,
      data: scoreHistory,
    });
  } catch (error) {
    console.error("Error fetching score history:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch score history",
    });
  }
});

// GET /api/money/score-analytics - Get detailed score analytics
router.get("/score-analytics", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { period = "30d" } = req.query; // 7d, 30d, 90d, 1y, all

    // Calculate date range
    let startDate;
    const now = new Date();
    switch (period) {
      case "7d":
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case "30d":
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case "90d":
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      case "1y":
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = null; // All time
    }

    // Get score history for the period
    const scoreHistoryQuery = { userId };
    if (startDate) {
      scoreHistoryQuery.createdAt = { $gte: startDate };
    }

    const scoreHistory = await ScoreHistory.find(scoreHistoryQuery)
      .populate("transactionId", "amount description status")
      .sort({ createdAt: -1 });

    // Calculate analytics
    const analytics = {
      currentScore: (await User.findById(userId)).good4itScore,
      period,
      totalChanges: scoreHistory.length,
      positiveChanges: scoreHistory.filter((h) => h.scoreChange > 0).length,
      negativeChanges: scoreHistory.filter((h) => h.scoreChange < 0).length,
      totalScoreChange: scoreHistory.reduce((sum, h) => sum + h.scoreChange, 0),
      changeTypes: {},
      monthlyTrend: [],
      topPositiveEvents: [],
      topNegativeEvents: [],
    };

    // Group by change type
    scoreHistory.forEach((change) => {
      if (!analytics.changeTypes[change.changeType]) {
        analytics.changeTypes[change.changeType] = {
          count: 0,
          totalChange: 0,
          avgChange: 0,
        };
      }
      analytics.changeTypes[change.changeType].count++;
      analytics.changeTypes[change.changeType].totalChange +=
        change.scoreChange;
    });

    // Calculate averages
    Object.keys(analytics.changeTypes).forEach((type) => {
      const data = analytics.changeTypes[type];
      data.avgChange = data.totalChange / data.count;
    });

    // Get top positive and negative events
    const sortedByChange = [...scoreHistory].sort(
      (a, b) => b.scoreChange - a.scoreChange
    );
    analytics.topPositiveEvents = sortedByChange
      .filter((h) => h.scoreChange > 0)
      .slice(0, 5)
      .map((h) => ({
        changeType: h.changeType,
        scoreChange: h.scoreChange,
        description: h.description,
        date: h.createdAt,
        amount: h.transactionId?.amount || 0,
      }));

    analytics.topNegativeEvents = sortedByChange
      .filter((h) => h.scoreChange < 0)
      .slice(0, 5)
      .map((h) => ({
        changeType: h.changeType,
        scoreChange: h.scoreChange,
        description: h.description,
        date: h.createdAt,
        amount: h.transactionId?.amount || 0,
      }));

    // Calculate monthly trend (last 12 months)
    const monthlyData = {};
    scoreHistory.forEach((change) => {
      const monthKey = change.createdAt.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { scoreChange: 0, count: 0 };
      }
      monthlyData[monthKey].scoreChange += change.scoreChange;
      monthlyData[monthKey].count++;
    });

    analytics.monthlyTrend = Object.keys(monthlyData)
      .sort()
      .slice(-12) // Last 12 months
      .map((month) => ({
        month,
        scoreChange: monthlyData[month].scoreChange,
        transactionCount: monthlyData[month].count,
      }));

    res.json({
      success: true,
      data: analytics,
    });
  } catch (error) {
    console.error("Error fetching score analytics:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch score analytics",
    });
  }
});

// POST /api/money/flag-payment-not-received - Flag payment as not received
router.post(
  "/flag-payment-not-received",
  authenticateToken,
  async (req, res) => {
    try {
      const { transactionId } = req.body;
      const userId = req.user.userId;

      if (!transactionId) {
        return res.status(400).json({
          success: false,
          message: "Transaction ID is required",
        });
      }

      // Find the transaction
      const transaction = await MoneyTransaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Only the requestor (borrower) can flag payment as not received
      if (transaction.requestor.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "Only the borrower can flag payment as not received",
        });
      }

      if (transaction.status !== "money_sent") {
        return res.status(400).json({
          success: false,
          message: "Can only flag payment as not received for sent money",
        });
      }

      // Update transaction status
      transaction.status = "disputed";
      await transaction.save();

      // Update lender's score for payment not received
      try {
        await Good4ItScoreService.updateScore(
          transaction.lender,
          "payment_not_received",
          Good4ItScoreService.calculateScoreChange(
            "payment_not_received",
            transaction.amount
          ),
          `Payment of $${transaction.amount} flagged as not received`,
          { transactionId },
          transactionId
        );
      } catch (scoreError) {
        console.error(
          "Failed to update score for payment not received:",
          scoreError
        );
      }

      res.json({
        success: true,
        message: "Payment flagged as not received",
        data: { transaction },
      });
    } catch (error) {
      console.error("Error flagging payment as not received:", error);
      res.status(500).json({
        success: false,
        message: "Failed to flag payment as not received",
      });
    }
  }
);

// GET /api/money/check-emi-payment/:transactionId - Check if EMI payment is allowed for current month
router.get(
  "/check-emi-payment/:transactionId",
  authenticateToken,
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      const userId = req.user.userId;

      // Find the transaction and populate the request details
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
            "You are not authorized to make payments for this transaction",
        });
      }

      // Check if the associated request is EMI type
      if (transaction.requestId.paymentType !== "emi") {
        return res.json({
          success: true,
          data: {
            allowed: true,
            message: "This is not an EMI transaction",
          },
        });
      }

      // Get EMI frequency
      const frequency =
        transaction.requestId.emiDetails?.frequency || "monthly";
      const now = new Date();

      // Calculate the time window based on frequency
      let startDate, endDate, periodName;

      switch (frequency) {
        case "weekly":
          // Get the start and end of current week (Monday to Sunday)
          const dayOfWeek = now.getDay();
          const monday = new Date(now);
          monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
          monday.setHours(0, 0, 0, 0);
          startDate = monday;

          endDate = new Date(monday);
          endDate.setDate(monday.getDate() + 7);
          endDate.setHours(23, 59, 59, 999);

          periodName = "week";
          break;

        case "monthly":
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          periodName = now.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          });
          break;

        case "quarterly":
          // Quarters: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec
          const quarter = Math.floor(now.getMonth() / 3);
          startDate = new Date(now.getFullYear(), quarter * 3, 1);
          endDate = new Date(now.getFullYear(), (quarter + 1) * 3, 1);
          const quarterNames = ["Q1", "Q2", "Q3", "Q4"];
          periodName = `${quarterNames[quarter]} ${now.getFullYear()}`;
          break;

        default:
          // Default to monthly
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          periodName = now.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          });
      }

      // Check if EMI payment was already made in this period
      // For EMI, check if this transaction has a repaymentReceivedAt within current period
      if (transaction.repaymentReceivedAt) {
        const lastPaymentDate = new Date(transaction.repaymentReceivedAt);
        if (lastPaymentDate >= startDate && lastPaymentDate < endDate) {
          return res.json({
            success: true,
            data: {
              allowed: false,
              message: `EMI payment already made for this ${periodName}. Next payment can be made from the next period.`,
              lastPaymentDate: transaction.repaymentReceivedAt,
              frequency: frequency,
              period: periodName,
            },
          });
        }
      }

      // Check if transaction is completed
      if (transaction.status === "repaid") {
        return res.json({
          success: true,
          data: {
            allowed: false,
            message: "This transaction is already completed",
          },
        });
      }

      return res.json({
        success: true,
        data: {
          allowed: true,
          message: `EMI payment is allowed for this ${periodName}`,
          frequency: frequency,
          period: periodName,
        },
      });
    } catch (error) {
      console.error("Check EMI payment error:", error);
      res.status(500).json({
        success: false,
        message: "Server error while checking EMI payment status",
      });
    }
  }
);

// GET /api/money/emi-history/:transactionId - Get EMI payment history for a transaction
router.get(
  "/emi-history/:transactionId",
  authenticateToken,
  async (req, res) => {
    try {
      const { transactionId } = req.params;
      const userId = req.user.userId;

      // Find the transaction and populate the request details
      const transaction = await MoneyTransaction.findById(
        transactionId
      ).populate("requestId");
      if (!transaction) {
        return res.status(404).json({
          success: false,
          message: "Transaction not found",
        });
      }

      // Check if user is involved in this transaction
      if (
        transaction.requestor.toString() !== userId &&
        transaction.lender.toString() !== userId
      ) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to view this transaction",
        });
      }

      // Get EMI payment history
      const emiPayments = await MoneyTransaction.find({
        requestId: transaction.requestId._id,
        status: { $in: ["repaid"] },
      }).sort({ repaymentReceivedAt: 1 });

      // Format the response
      const paymentHistory = emiPayments.map((payment) => ({
        _id: payment._id,
        amount: payment.repaymentAmount || payment.amount,
        status: payment.status,
        paymentDate: payment.repaymentReceivedAt,
        month: payment.repaymentReceivedAt.toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        }),
        proofUrl: payment.repaymentReceivedProof,
      }));

      // Calculate EMI details
      const emiDetails = {
        totalAmount: transaction.amount,
        installmentAmount:
          transaction.requestId.emiDetails?.installmentAmount || 0,
        numberOfInstallments:
          transaction.requestId.emiDetails?.numberOfInstallments || 0,
        frequency: transaction.requestId.emiDetails?.frequency || "monthly",
        totalPaid: emiPayments.reduce(
          (sum, payment) => sum + (payment.repaymentAmount || payment.amount),
          0
        ),
        remainingAmount:
          transaction.amount -
          emiPayments.reduce(
            (sum, payment) => sum + (payment.repaymentAmount || payment.amount),
            0
          ),
        paymentsMade: emiPayments.length,
        paymentsRemaining: Math.max(
          0,
          (transaction.requestId.emiDetails?.numberOfInstallments || 0) -
            emiPayments.length
        ),
      };

      res.json({
        success: true,
        data: {
          transactionId,
          emiDetails,
          paymentHistory,
        },
      });
    } catch (error) {
      console.error("Get EMI history error:", error);
      res.status(500).json({
        success: false,
        message: "Server error while getting EMI payment history",
      });
    }
  }
);

// POST /api/money/reject-repayment - Reject repayment confirmation (lender only)
router.post("/reject-repayment", authenticateToken, async (req, res) => {
  try {
    console.log("🔄 Reject repayment request received");
    console.log("Request body:", req.body);
    console.log("User ID:", req.user?.userId);

    const { transactionId, reason } = req.body;
    const userId = req.user.userId;

    if (!transactionId) {
      return res.status(400).json({
        success: false,
        message: "Transaction ID is required",
      });
    }

    // Find the transaction
    const transaction = await MoneyTransaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaction not found",
      });
    }

    // Only the lender can reject repayment
    if (transaction.lender.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: "Only the lender can reject repayment",
      });
    }

    if (transaction.status !== "repayment_sent") {
      return res.status(400).json({
        success: false,
        message: "Repayment must be sent first before rejecting",
      });
    }

    // Update transaction status to indicate repayment was rejected
    transaction.status = "repayment_rejected";
    transaction.repaymentRejectedAt = new Date();
    transaction.repaymentRejectionReason =
      reason || "Repayment confirmation rejected";

    await transaction.save();

    // Deduct good4it score from the borrower for fraudulent repayment claim
    try {
      await Good4ItScoreService.updateScore(
        transaction.requestor,
        "fraudulent_proof",
        Good4ItScoreService.calculateScoreChange(
          "fraudulent_proof",
          transaction.repaymentAmount || transaction.amount
        ),
        `Fraudulent repayment proof rejected for transaction with ${transaction.lender}`,
        {
          transactionId: transaction._id,
          rejectionReason: reason,
          rejectedBy: userId,
        },
        transaction._id
      );
    } catch (scoreError) {
      console.error(
        "Failed to update score for repayment rejection:",
        scoreError
      );
    }

    // Send notification to the borrower about rejection
    try {
      await notificationService.sendRepaymentRejectedNotification(
        transaction.requestor,
        userId,
        transaction._id,
        reason
      );
    } catch (notificationError) {
      console.error(
        "Failed to send repayment rejection notification:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: "Repayment rejected successfully",
      data: { transaction },
    });
  } catch (error) {
    console.error("Error rejecting repayment:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reject repayment",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
});

module.exports = router;
