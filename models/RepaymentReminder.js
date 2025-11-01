const mongoose = require('mongoose');

const repaymentReminderSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MoneyTransaction',
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  message: {
    type: String,
    trim: true,
    maxlength: [500, 'Message cannot exceed 500 characters'],
    default: 'Friendly reminder about your pending repayment.'
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  isRead: {
    type: Boolean,
    default: false
  }
});

// Index for efficient queries
repaymentReminderSchema.index({ recipient: 1, isRead: 1 });
repaymentReminderSchema.index({ transactionId: 1, sentAt: -1 });
repaymentReminderSchema.index({ sender: 1, sentAt: -1 });

module.exports = mongoose.model('RepaymentReminder', repaymentReminderSchema);