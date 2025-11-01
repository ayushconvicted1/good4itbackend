const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const MoneyTransaction = require('../models/MoneyTransaction');
const MoneyRequest = require('../models/MoneyRequest');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

// Get all notifications for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, unreadOnly = false } = req.query;
        const userId = req.user.userId;

        const query = { recipient: userId };
        if (unreadOnly === 'true') {
            query.isRead = false;
        }

        const notifications = await Notification.find(query)
            .populate('sender', 'fullName profilePicture')
            .populate('relatedTransaction', 'amount status')
            .populate('relatedRequest', 'amount status')
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit);

        const totalNotifications = await Notification.countDocuments(query);
        const unreadCount = await Notification.countDocuments({
            recipient: userId,
            isRead: false
        });

        res.json({
            success: true,
            data: {
                notifications,
                pagination: {
                    currentPage: parseInt(page),
                    totalPages: Math.ceil(totalNotifications / limit),
                    totalNotifications,
                    hasNextPage: page * limit < totalNotifications,
                    hasPrevPage: page > 1
                },
                unreadCount
            }
        });
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch notifications',
            error: error.message
        });
    }
});

// Mark notification as read
router.patch('/:notificationId/read', authenticateToken, async (req, res) => {
    try {
        const { notificationId } = req.params;
        const userId = req.user.userId;

        const notification = await Notification.findOneAndUpdate(
            { _id: notificationId, recipient: userId },
            { isRead: true },
            { new: true }
        ).populate('sender', 'fullName profilePicture');

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found'
            });
        }

        res.json({
            success: true,
            message: 'Notification marked as read',
            data: { notification }
        });
    } catch (error) {
        console.error('Error marking notification as read:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark notification as read',
            error: error.message
        });
    }
});

// Mark all notifications as read
router.patch('/mark-all-read', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const result = await Notification.updateMany(
            { recipient: userId, isRead: false },
            { isRead: true }
        );

        res.json({
            success: true,
            message: 'All notifications marked as read',
            data: { modifiedCount: result.modifiedCount }
        });
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to mark all notifications as read',
            error: error.message
        });
    }
});

// Delete notification
router.delete('/:notificationId', authenticateToken, async (req, res) => {
    try {
        const { notificationId } = req.params;
        const userId = req.user.userId;

        const notification = await Notification.findOneAndDelete({
            _id: notificationId,
            recipient: userId
        });

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found'
            });
        }

        res.json({
            success: true,
            message: 'Notification deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting notification:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete notification',
            error: error.message
        });
    }
});

// Get unread count
router.get('/unread-count', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const unreadCount = await Notification.countDocuments({
            recipient: userId,
            isRead: false
        });

        res.json({
            success: true,
            data: { unreadCount }
        });
    } catch (error) {
        console.error('Error getting unread count:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get unread count',
            error: error.message
        });
    }
});

// Debug endpoint to check authentication
router.get('/debug-auth', authenticateToken, async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                user: req.user,
                userId: req.user.userId,
                userObject: req.user._id
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get test users for notification testing
router.get('/test-users', authenticateToken, async (req, res) => {
    try {
        const users = await User.find({}, 'fullName email fcmToken')
            .limit(10)
            .sort({ createdAt: -1 });

        const testUsers = users.map(user => ({
            id: user._id,
            name: user.fullName,
            email: user.email,
            hasFcmToken: !!user.fcmToken
        }));

        res.json({
            success: true,
            message: 'Test users retrieved successfully',
            data: {
                users: testUsers,
                count: testUsers.length
            }
        });

    } catch (error) {
        console.error('Error getting test users:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get test users',
            error: error.message
        });
    }
});

// Test endpoint for sending notifications via Postman
router.post('/test', authenticateToken, async (req, res) => {
    try {
        const {
            recipientId,
            title = 'Test Notification',
            message = 'This is a test notification from Postman',
            type = 'general',
            amount = 100
        } = req.body;
        const senderId = req.user.userId;

        // Debug logging
        console.log('Test notification request:', { recipientId, senderId, user: req.user });

        // Validate sender
        if (!senderId) {
            return res.status(400).json({
                success: false,
                message: 'Sender ID not found in token'
            });
        }

        // Validate recipient
        if (!recipientId) {
            return res.status(400).json({
                success: false,
                message: 'recipientId is required'
            });
        }

        // Check if recipient exists
        const recipient = await User.findById(recipientId);
        if (!recipient) {
            return res.status(404).json({
                success: false,
                message: 'Recipient not found'
            });
        }

        // Get sender info
        const sender = await User.findById(senderId);
        if (!sender) {
            return res.status(404).json({
                success: false,
                message: 'Sender not found'
            });
        }

        // Send notification using the notification service
        const notificationService = require('../services/notificationService');
        const result = await notificationService.sendToUser(
            recipientId,
            title,
            message,
            type,
            { amount: amount.toString() },
            senderId,
            null, // no related transaction
            null  // no related request
        );

        res.json({
            success: true,
            message: 'Test notification sent successfully',
            data: {
                notification: result.notification,
                fcmDelivered: !!result.fcmResponse,
                sender: {
                    id: sender._id,
                    name: sender.fullName
                },
                recipient: {
                    id: recipient._id,
                    name: recipient.fullName,
                    hasFcmToken: !!recipient.fcmToken
                }
            }
        });

    } catch (error) {
        console.error('Error sending test notification:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send test notification',
            error: error.message
        });
    }
});

module.exports = router;