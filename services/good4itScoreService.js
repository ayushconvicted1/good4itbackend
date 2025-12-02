const User = require("../models/User");
const ScoreHistory = require("../models/ScoreHistory");
const MoneyTransaction = require("../models/MoneyTransaction");
const MoneyRequest = require("../models/MoneyRequest");
const Dispute = require("../models/Dispute");

class Good4ItScoreService {
  /**
   * Update user's good4it score and log the change
   */
  static async updateScore(
    userId,
    changeType,
    scoreChange,
    description = "",
    metadata = {},
    transactionId = null
  ) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      const previousScore = user.good4itScore || 50; // Default to 50 (middle of 0-100)
      const newScore = Math.max(0, Math.min(100, previousScore + scoreChange));

      // Update user's score
      user.good4itScore = newScore;
      await user.save();

      // Log the score change
      const scoreHistory = new ScoreHistory({
        userId,
        transactionId,
        changeType,
        scoreChange,
        previousScore,
        newScore,
        description,
        metadata,
      });
      await scoreHistory.save();

      return {
        previousScore,
        newScore,
        scoreChange,
        scoreHistory,
      };
    } catch (error) {
      console.error("Error updating good4it score:", error);
      throw error;
    }
  }

  /**
   * Calculate score change based on transaction event
   */
  static calculateScoreChange(eventType, amount = 0, isLate = false) {
    const scoreChanges = {
      // Positive events (scaled down for 0-100)
      transaction_completed: 5, // Lender completes transaction
      repayment_completed: 3, // Borrower completes repayment
      early_repayment: 2, // Borrower repays early
      forgiveness_given: 2, // Lender forgives debt
      forgiveness_received: 1, // Borrower receives forgiveness
      dispute_resolved: 3, // Dispute resolved in favor

      // Negative events (scaled down for 0-100)
      request_declined: -2, // Lender declines request
      payment_not_received: -3, // Lender doesn't receive payment
      false_dispute: -5, // False dispute claim
      late_repayment: -1, // Late repayment
      fraudulent_proof: -10, // Uploading fraudulent proof

      // Account events
      account_created: 50, // Initial score (middle of 0-100)
      manual_adjustment: 0, // Will be set manually
    };

    let change = scoreChanges[eventType] || 0;

    // Adjust for amount-based scoring (optional, scaled for 0-100)
    if (amount > 0) {
      const amountMultiplier = Math.min(amount / 1000, 1.5); // Cap at 1.5x multiplier
      change = Math.round(change * amountMultiplier);
    }

    // Additional penalty for late payments
    if (isLate && eventType === "repayment_completed") {
      change -= 1;
    }

    return change;
  }

  /**
   * Handle transaction completion score update
   */
  static async handleTransactionCompleted(transactionId) {
    try {
      const transaction = await MoneyTransaction.findById(
        transactionId
      ).populate("lender requestor");

      if (!transaction) {
        throw new Error("Transaction not found");
      }

      // Update lender's score for completing transaction
      const lenderChange = this.calculateScoreChange(
        "transaction_completed",
        transaction.amount
      );
      await this.updateScore(
        transaction.lender._id,
        "transaction_completed",
        lenderChange,
        `Completed transaction of $${transaction.amount} with ${transaction.requestor.fullName}`,
        { amount: transaction.amount, transactionId },
        transactionId
      );

      return { success: true };
    } catch (error) {
      console.error("Error handling transaction completion:", error);
      throw error;
    }
  }

  /**
   * Handle repayment completion score update
   */
  static async handleRepaymentCompleted(transactionId, isLate = false) {
    try {
      const transaction = await MoneyTransaction.findById(
        transactionId
      ).populate("lender requestor");

      if (!transaction) {
        throw new Error("Transaction not found");
      }

      const changeType = isLate ? "late_repayment" : "repayment_completed";
      const scoreChange = this.calculateScoreChange(
        changeType,
        transaction.repaymentAmount,
        isLate
      );

      // Update borrower's score for completing repayment
      await this.updateScore(
        transaction.requestor._id,
        changeType,
        scoreChange,
        `${isLate ? "Late" : "Completed"} repayment of $${
          transaction.repaymentAmount || 0
        } to ${transaction.lender.fullName}`,
        { amount: transaction.repaymentAmount, isLate, transactionId },
        transactionId
      );

      return { success: true };
    } catch (error) {
      console.error("Error handling repayment completion:", error);
      throw error;
    }
  }

  /**
   * Handle request decline score update
   */
  static async handleRequestDeclined(requestId, lenderId) {
    try {
      const request = await MoneyRequest.findById(requestId).populate(
        "requestor"
      );

      if (!request) {
        throw new Error("Request not found");
      }

      const scoreChange = this.calculateScoreChange(
        "request_declined",
        request.amount
      );

      // Update lender's score for declining request
      await this.updateScore(
        lenderId,
        "request_declined",
        scoreChange,
        `Declined money request of $${request.amount} from ${request.requestor.fullName}`,
        { amount: request.amount, requestId },
        null
      );

      return { success: true };
    } catch (error) {
      console.error("Error handling request decline:", error);
      throw error;
    }
  }

  /**
   * Handle dispute creation and resolution
   */
  static async handleDisputeCreated(disputeId) {
    try {
      const dispute = await Dispute.findById(disputeId).populate(
        "disputer transactionId"
      );

      if (!dispute) {
        throw new Error("Dispute not found");
      }

      // No immediate score change for creating dispute
      // Score will be updated when dispute is resolved
      return { success: true };
    } catch (error) {
      console.error("Error handling dispute creation:", error);
      throw error;
    }
  }

  /**
   * Handle dispute resolution
   */
  static async handleDisputeResolved(disputeId, resolution) {
    try {
      const dispute = await Dispute.findById(disputeId).populate(
        "disputer transactionId"
      );

      if (!dispute) {
        throw new Error("Dispute not found");
      }

      const transaction = dispute.transactionId;
      const disputerId = dispute.disputer._id;

      // Determine the other party
      const otherPartyId =
        transaction.requestor.toString() === disputerId.toString()
          ? transaction.lender
          : transaction.requestor;

      if (resolution === "in_favor_of_disputer") {
        // Disputer was right - positive score for disputer, negative for other party
        await this.updateScore(
          disputerId,
          "dispute_resolved",
          this.calculateScoreChange("dispute_resolved"),
          `Dispute resolved in favor - correct claim`,
          { disputeId, resolution },
          transaction._id
        );

        await this.updateScore(
          otherPartyId,
          "false_dispute",
          this.calculateScoreChange("false_dispute"),
          `Dispute resolved against - false claim`,
          { disputeId, resolution },
          transaction._id
        );
      } else if (resolution === "in_favor_of_other_party") {
        // Other party was right - negative score for disputer, positive for other party
        await this.updateScore(
          disputerId,
          "false_dispute",
          this.calculateScoreChange("false_dispute"),
          `Dispute resolved against - false claim`,
          { disputeId, resolution },
          transaction._id
        );

        await this.updateScore(
          otherPartyId,
          "dispute_resolved",
          this.calculateScoreChange("dispute_resolved"),
          `Dispute resolved in favor - correct claim`,
          { disputeId, resolution },
          transaction._id
        );
      }

      return { success: true };
    } catch (error) {
      console.error("Error handling dispute resolution:", error);
      throw error;
    }
  }

  /**
   * Handle forgiveness score updates
   */
  static async handleForgiveness(transactionId, forgivenAmount) {
    try {
      const transaction = await MoneyTransaction.findById(
        transactionId
      ).populate("lender requestor");

      if (!transaction) {
        throw new Error("Transaction not found");
      }

      // Update lender's score for giving forgiveness
      await this.updateScore(
        transaction.lender._id,
        "forgiveness_given",
        this.calculateScoreChange("forgiveness_given", forgivenAmount),
        `Forgave $${forgivenAmount} debt for ${transaction.requestor.fullName}`,
        { amount: forgivenAmount, transactionId },
        transactionId
      );

      // Update borrower's score for receiving forgiveness
      await this.updateScore(
        transaction.requestor._id,
        "forgiveness_received",
        this.calculateScoreChange("forgiveness_received", forgivenAmount),
        `Received $${forgivenAmount} debt forgiveness from ${transaction.lender.fullName}`,
        { amount: forgivenAmount, transactionId },
        transactionId
      );

      return { success: true };
    } catch (error) {
      console.error("Error handling forgiveness:", error);
      throw error;
    }
  }

  /**
   * Get user's score history
   */
  static async getScoreHistory(userId, limit = 20) {
    try {
      const history = await ScoreHistory.find({ userId })
        .populate("transactionId", "amount description")
        .sort({ createdAt: -1 })
        .limit(limit);

      return history;
    } catch (error) {
      console.error("Error getting score history:", error);
      throw error;
    }
  }

  /**
   * Get user's current score with breakdown
   */
  static async getScoreBreakdown(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error("User not found");
      }

      // Get recent score changes
      const recentChanges = await ScoreHistory.find({ userId })
        .sort({ createdAt: -1 })
        .limit(10);

      // Calculate score statistics
      const totalTransactions = await MoneyTransaction.countDocuments({
        $or: [{ lender: userId }, { requestor: userId }],
        status: "repaid",
      });

      const totalLent = await MoneyTransaction.aggregate([
        { $match: { lender: userId, status: "repaid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);

      const totalBorrowed = await MoneyTransaction.aggregate([
        { $match: { requestor: userId, status: "repaid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]);

      const disputesWon = await Dispute.countDocuments({
        disputer: userId,
        "resolution.resolution": "in_favor_of_disputer",
      });

      const disputesLost = await Dispute.countDocuments({
        disputer: userId,
        "resolution.resolution": "in_favor_of_other_party",
      });

      return {
        currentScore: user.good4itScore,
        totalTransactions: totalTransactions || 0,
        totalLent: totalLent[0]?.total || 0,
        totalBorrowed: totalBorrowed[0]?.total || 0,
        disputesWon,
        disputesLost,
        recentChanges,
      };
    } catch (error) {
      console.error("Error getting score breakdown:", error);
      throw error;
    }
  }
}

module.exports = Good4ItScoreService;
