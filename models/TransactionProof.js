const mongoose = require('mongoose');

const transactionProofSchema = new mongoose.Schema({
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MoneyTransaction',
    required: true
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  proofType: {
    type: String,
    enum: ['money_sent', 'money_received', 'repayment_sent', 'repayment_received'],
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  filePath: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: true,
    max: [10 * 1024 * 1024, 'File size cannot exceed 10MB'] // 10MB limit
  },
  mimeType: {
    type: String,
    required: true,
    enum: ['image/jpeg', 'image/jpg', 'image/png', 'image/heic']
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
});

// Index for efficient queries
transactionProofSchema.index({ transactionId: 1, proofType: 1 });
transactionProofSchema.index({ uploadedBy: 1 });

module.exports = mongoose.model('TransactionProof', transactionProofSchema);