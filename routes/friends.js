const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const User = require('../models/User');
const Friend = require('../models/Friend');
const FriendRequest = require('../models/FriendRequest');

// Search users by email or phone number
router.get('/search', authenticateToken, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ message: 'Search query is required' });
    }

    const users = await User.find({
      $or: [
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

// Get pending friend requests
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

module.exports = router;