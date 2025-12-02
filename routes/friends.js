const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Friend = require('../models/Friend');
const FriendRequest = require('../models/FriendRequest');

// Search users by name, email or phone number
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ message: 'Search query is required' });
    }

    const users = await User.find({
      $or: [
        { fullName: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } },
        { phoneNumber: { $regex: query, $options: 'i' } }
      ],
      _id: { $ne: req.user.id } // Exclude current user
    }).select('fullName email phoneNumber profilePicture');

    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Send friend request
router.post('/request', authenticateToken, async (req, res) => {
  try {
    const { recipientId } = req.body;
    
    // Check if recipient exists
    const recipient = await User.findById(recipientId);
    if (!recipient) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if request already exists
    const existingRequest = await FriendRequest.findOne({
      $or: [
        { sender: req.user.id, recipient: recipientId },
        { sender: recipientId, recipient: req.user.id }
      ]
    });

    if (existingRequest) {
      return res.status(400).json({ message: 'Friend request already exists' });
    }

    // Check if already friends
    const existingFriendship = await Friend.findOne({
      $or: [
        { user: req.user.id, friend: recipientId },
        { user: recipientId, friend: req.user.id }
      ]
    });

    if (existingFriendship) {
      return res.status(400).json({ message: 'Already friends' });
    }

    const friendRequest = new FriendRequest({
      sender: req.user.id,
      recipient: recipientId
    });

    await friendRequest.save();
    res.json({ message: 'Friend request sent successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Accept/Reject friend request
router.put('/request/:requestId', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const request = await FriendRequest.findOne({
      _id: requestId,
      recipient: req.user.id,
      status: 'pending'
    });

    if (!request) {
      return res.status(404).json({ message: 'Friend request not found' });
    }

    request.status = status;
    await request.save();

    if (status === 'accepted') {
      // Create friendship records for both users
      await Friend.create([
        { user: request.sender, friend: request.recipient },
        { user: request.recipient, friend: request.sender }
      ]);
    }

    res.json({ message: `Friend request ${status} successfully` });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get all friends
router.get('/list', authenticateToken, async (req, res) => {
  try {
    const friends = await Friend.find({ user: req.user.id })
      .populate('friend', 'fullName email phoneNumber profilePicture good4itScore')
      .sort('-createdAt');

    res.json(friends.map(f => f.friend));
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get pending friend requests (received)
router.get('/requests', authenticateToken, async (req, res) => {
  try {
    const requests = await FriendRequest.find({
      recipient: req.user.id,
      status: 'pending'
    })
    .populate('sender', 'fullName email phoneNumber profilePicture')
    .sort('-createdAt');

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get sent friend requests (pending requests sent by user)
router.get('/requests/sent', authenticateToken, async (req, res) => {
  try {
    const requests = await FriendRequest.find({
      sender: req.user.id,
      status: 'pending'
    })
    .populate('recipient', 'fullName email phoneNumber profilePicture')
    .sort('-createdAt');

    res.json(requests);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Get users from contacts who are using the app
router.post('/contacts', authenticateToken, async (req, res) => {
  try {
    const { phoneNumbers } = req.body;
    
    if (!phoneNumbers || !Array.isArray(phoneNumbers)) {
      return res.status(400).json({ message: 'phoneNumbers array is required' });
    }

    // Normalize phone numbers (remove spaces, dashes, etc.)
    const normalizedNumbers = phoneNumbers.map(num => 
      num.replace(/[\s\-\(\)]/g, '').replace(/^\+/, '')
    ).filter(num => num.length > 0);

    if (normalizedNumbers.length === 0) {
      return res.json([]);
    }

    // Build regex patterns for flexible matching
    // Match phone numbers that contain any of the normalized numbers (handles different formats)
    // Create regex strings for MongoDB
    const phoneMatchConditions = normalizedNumbers.map(num => {
      // Escape special regex characters
      const escaped = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match the number anywhere in the phone number field (handles different formats)
      return { phoneNumber: { $regex: escaped, $options: 'i' } };
    });

    const users = await User.find({
      $or: phoneMatchConditions,
      _id: { $ne: req.user.id }, // Exclude current user
      phoneNumber: { $exists: true, $ne: null } // Only users with phone numbers
    }).select('fullName email phoneNumber profilePicture good4itScore');

    // Get existing friends and requests to filter out
    const existingFriends = await Friend.find({ user: req.user.id });
    const friendIds = existingFriends.map(f => f.friend.toString());
    
    const sentRequests = await FriendRequest.find({
      sender: req.user.id,
      status: 'pending'
    });
    const sentRequestIds = sentRequests.map(r => r.recipient.toString());
    
    const receivedRequests = await FriendRequest.find({
      recipient: req.user.id,
      status: 'pending'
    });
    const receivedRequestIds = receivedRequests.map(r => r.sender.toString());

    // Filter out users who are already friends or have pending requests
    const filteredUsers = users.filter(user => {
      const userId = user._id.toString();
      return !friendIds.includes(userId) && 
             !sentRequestIds.includes(userId) && 
             !receivedRequestIds.includes(userId);
    });

    res.json(filteredUsers);
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;