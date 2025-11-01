const admin = require("firebase-admin");
const Notification = require("../models/Notification");

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
    // Clean and format the private key properly
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey) {
      // Remove quotes if present
      privateKey = privateKey.replace(/^["']|["']$/g, "");
      // Replace escaped newlines with actual newlines
      privateKey = privateKey.replace(/\\n/g, "\n");
      // Ensure proper formatting
      if (!privateKey.startsWith("-----BEGIN PRIVATE KEY-----")) {
        throw new Error("Invalid private key format - missing BEGIN marker");
      }
      if (!privateKey.endsWith("-----END PRIVATE KEY-----")) {
        throw new Error("Invalid private key format - missing END marker");
      }
    }

    const serviceAccount = {
      type: "service_account",
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: privateKey,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    };

    console.log(
      "🔧 Initializing Firebase with project:",
      process.env.FIREBASE_PROJECT_ID
    );
    console.log("🔧 Client email:", process.env.FIREBASE_CLIENT_EMAIL);
    console.log("🔧 Private key length:", privateKey?.length || 0);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseInitialized = true;
    console.log("✅ Firebase Admin SDK initialized successfully");
  } else if (!process.env.FIREBASE_PROJECT_ID) {
    console.log(
      "⚠️ Firebase credentials not configured. Push notifications will be disabled."
    );
  }
} catch (error) {
  console.error("❌ Failed to initialize Firebase Admin SDK:", error.message);
  console.log(
    "⚠️ Push notifications will be disabled. Please check your Firebase configuration."
  );

  // Log more details for debugging
  if (error.message.includes("DECODER routines")) {
    console.log(
      "🔍 Private key format issue detected. Please check your FIREBASE_PRIVATE_KEY in .env file."
    );
    console.log(
      "🔍 Make sure the private key is properly formatted with \\n for newlines."
    );
  }
}

class NotificationService {
  async sendNotification(fcmToken, title, body, data = {}) {
    if (!firebaseInitialized) {
      console.log("⚠️ Firebase not initialized. Skipping push notification.");
      return null;
    }

    try {
      const message = {
        notification: {
          title,
          body,
        },
        data: {
          ...data,
          timestamp: Date.now().toString(),
        },
        token: fcmToken,
        android: {
          priority: "high",
          notification: {
            channelId: "good4it_notifications",
            priority: "high",
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title,
                body,
              },
              sound: "default",
              badge: 1,
            },
          },
        },
      };

      const response = await admin.messaging().send(message);
      console.log("✅ Notification sent successfully:", response);
      return response;
    } catch (error) {
      console.error("❌ Error sending notification:", error);
      throw error;
    }
  }

  async sendToUser(
    userId,
    title,
    body,
    type = "general",
    data = {},
    senderId = null,
    relatedTransaction = null,
    relatedRequest = null
  ) {
    try {
      const User = require("../models/User");
      const user = await User.findById(userId);

      if (!user) {
        console.log("User not found");
        return;
      }

      // Validate required fields
      if (!senderId) {
        throw new Error("Sender ID is required for notifications");
      }

      // Save notification to database
      const notification = new Notification({
        recipient: userId,
        sender: senderId,
        type,
        title,
        message: body,
        amount: data.amount ? parseFloat(data.amount) : 0,
        relatedTransaction,
        relatedRequest,
        isRead: false,
        isDelivered: false,
      });

      const savedNotification = await notification.save();

      // Send push notification if user has FCM token and Firebase is initialized
      let fcmResponse = null;
      if (user.fcmToken && firebaseInitialized) {
        try {
          fcmResponse = await this.sendNotification(
            user.fcmToken,
            title,
            body,
            {
              type,
              notificationId: savedNotification._id.toString(),
              ...data,
            }
          );

          // Update notification as delivered if FCM was successful
          if (fcmResponse) {
            savedNotification.isDelivered = true;
            savedNotification.fcmMessageId = fcmResponse;
            await savedNotification.save();
          }
        } catch (fcmError) {
          console.error("FCM notification failed:", fcmError);
          // Don't throw error, notification is still saved in DB
        }
      } else if (!firebaseInitialized) {
        console.log(
          "⚠️ Firebase not initialized. Notification saved to DB only."
        );
      } else if (!user.fcmToken) {
        console.log("⚠️ User has no FCM token. Notification saved to DB only.");
      }

      return {
        notification: savedNotification,
        fcmResponse,
      };
    } catch (error) {
      console.error("Error sending notification to user:", error);
      throw error;
    }
  }

  // Notification templates for money transactions
  async notifyMoneyRequest(
    lenderId,
    requestorId,
    requestorName,
    amount,
    requestId = null
  ) {
    return await this.sendToUser(
      lenderId,
      "New Money Request",
      `${requestorName} wants to borrow ${amount.toLocaleString()} from you`,
      "money_request",
      { amount: amount.toString() },
      requestorId,
      null,
      requestId
    );
  }

  async notifyMoneySent(
    requestorId,
    lenderId,
    lenderName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      requestorId,
      "Payment Claimed",
      `${lenderName} has claimed to send you ${amount.toLocaleString()}. Confirm when received.`,
      "money_sent",
      { amount: amount.toString() },
      lenderId,
      transactionId,
      null
    );
  }

  async notifyRepaymentReceived(
    lenderId,
    borrowerId,
    borrowerName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      lenderId,
      "Repayment Received",
      `${borrowerName} sent a repayment of ${amount.toLocaleString()}. Confirm to complete.`,
      "repayment_received",
      { amount: amount.toString() },
      borrowerId,
      transactionId,
      null
    );
  }

  async notifyDebtForgiven(
    borrowerId,
    lenderId,
    lenderName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      borrowerId,
      "Debt Forgiven",
      `${lenderName} has forgiven your debt of ${amount.toLocaleString()}. No repayment needed!`,
      "debt_forgiven",
      { amount: amount.toString() },
      lenderId,
      transactionId,
      null
    );
  }

  async notifyRepaymentConfirmed(
    borrowerId,
    lenderId,
    lenderName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      borrowerId,
      "Repayment Confirmed",
      `${lenderName} confirmed your repayment of ${amount.toLocaleString()}. Transaction complete!`,
      "repayment_confirmed",
      { amount: amount.toString() },
      lenderId,
      transactionId,
      null
    );
  }

  async sendRepaymentRejectedNotification(
    borrowerId,
    lenderId,
    transactionId,
    reason
  ) {
    try {
      const User = require("../models/User");
      const lender = await User.findById(lenderId);
      const lenderName = lender ? lender.fullName : "Your lender";

      return await this.sendToUser(
        borrowerId,
        "Repayment Rejected",
        `${lenderName} rejected your repayment confirmation${
          reason ? `: ${reason}` : ""
        }. Please verify your payment proof.`,
        "repayment_rejected",
        { reason: reason || "" },
        lenderId,
        transactionId,
        null
      );
    } catch (error) {
      console.error("Error sending repayment rejection notification:", error);
      throw error;
    }
  }

  async notifyRepaymentReminder(
    borrowerId,
    lenderId,
    lenderName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      borrowerId,
      "Repayment Reminder",
      `${lenderName} is reminding you to repay ${amount.toLocaleString()}. Please make your payment when convenient.`,
      "repayment_reminder",
      { amount: amount.toString() },
      lenderId,
      transactionId,
      null
    );
  }

  async notifyMoneyRequestRejected(
    requestorId,
    lenderId,
    lenderName,
    amount,
    requestId = null
  ) {
    return await this.sendToUser(
      requestorId,
      "Request Declined",
      `${lenderName} declined your money request for ${amount.toLocaleString()}. You can try asking someone else.`,
      "money_request_rejected",
      { amount: amount.toString() },
      lenderId,
      null,
      requestId
    );
  }

  async notifyMoneyReceiptConfirmed(
    lenderId,
    recipientId,
    recipientName,
    amount,
    transactionId = null
  ) {
    return await this.sendToUser(
      lenderId,
      "Receipt Confirmed",
      `${recipientName} confirmed receiving ${amount.toLocaleString()}. Transaction completed successfully.`,
      "money_receipt_confirmed",
      { amount: amount.toString() },
      recipientId,
      transactionId,
      null
    );
  }

  // Task-related notifications
  async sendTaskAssignmentNotification(
    assignedToUserId,
    assignedByUserId,
    taskId,
    taskTitle
  ) {
    try {
      const assignedToUser = await require("../models/User").findById(
        assignedToUserId
      );
      const assignedByUser = await require("../models/User").findById(
        assignedByUserId
      );

      if (!assignedToUser || !assignedByUser) {
        console.log("⚠️ User not found for task assignment notification");
        return null;
      }

      const title = "New Task Assigned";
      const body = `${assignedByUser.fullName} assigned you a task: "${taskTitle}"`;

      return await this.sendToUser(
        assignedToUserId,
        title,
        body,
        "task_assignment",
        {
          taskId,
          assignedBy: assignedByUserId,
        },
        assignedByUserId
      );
    } catch (error) {
      console.error("Error sending task assignment notification:", error);
      return null;
    }
  }

  async sendTaskStatusUpdateNotification(
    assignedByUserId,
    assignedToUserId,
    taskId,
    status
  ) {
    try {
      const assignedByUser = await require("../models/User").findById(
        assignedByUserId
      );
      const assignedToUser = await require("../models/User").findById(
        assignedToUserId
      );

      if (!assignedByUser || !assignedToUser) {
        console.log("⚠️ User not found for task status notification");
        return null;
      }

      let title, body;
      switch (status) {
        case "accepted":
          title = "Task Accepted";
          body = `${assignedToUser.fullName} accepted your task`;
          break;
        case "declined":
          title = "Task Declined";
          body = `${assignedToUser.fullName} declined your task`;
          break;
        case "completed":
          title = "Task Completed";
          body = `${assignedToUser.fullName} completed your task`;
          break;
        default:
          title = "Task Status Update";
          body = `Task status updated to ${status}`;
      }

      return await this.sendToUser(
        assignedByUserId,
        title,
        body,
        "task_status_update",
        {
          taskId,
          assignedTo: assignedToUserId,
          status,
        },
        assignedToUserId
      );
    } catch (error) {
      console.error("Error sending task status notification:", error);
      return null;
    }
  }
}

module.exports = new NotificationService();
