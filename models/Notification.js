const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "money_request",
        "money_sent",
        "repayment_received",
        "debt_forgiven",
        "repayment_confirmed",
        "repayment_reminder",
        "money_request_rejected",
        "money_receipt_confirmed",
        "repayment_rejected",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    relatedTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MoneyTransaction",
    },
    relatedRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MoneyRequest",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    isDelivered: {
      type: Boolean,
      default: false,
    },
    fcmMessageId: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
