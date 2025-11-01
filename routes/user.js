const express = require("express");
const User = require("../models/User");
const { validate, schemas } = require("../middleware/validation");
const {
  authenticateToken,
  requireVerification,
} = require("../middleware/auth");

const router = express.Router();

// @route   GET /api/user/profile
// @desc    Get user profile
// @access  Private
router.get("/profile", authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user,
    },
  });
});

// @route   PUT /api/user/profile
// @desc    Update user profile
// @access  Private
router.put(
  "/profile",
  authenticateToken,
  validate(schemas.updateProfile),
  async (req, res) => {
    try {
      const { fullName, phoneNumber, profilePicture } = req.body;
      const updateData = {};

      if (fullName) updateData.fullName = fullName;
      if (phoneNumber) updateData.phoneNumber = phoneNumber;
      if (profilePicture) updateData.profilePicture = profilePicture;

      // Check if phone number is already taken by another user
      if (phoneNumber && phoneNumber !== req.user.phoneNumber) {
        const existingUser = await User.findOne({
          phoneNumber,
          _id: { $ne: req.user._id },
        });

        if (existingUser) {
          return res.status(400).json({
            success: false,
            message: "Phone number is already in use by another account",
          });
        }
      }

      const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        updateData,
        { new: true, runValidators: true }
      ).select("-password");

      res.json({
        success: true,
        message: "Profile updated successfully",
        data: {
          user: updatedUser,
        },
      });
    } catch (error) {
      console.error("Profile update error:", error);
      res.status(500).json({
        success: false,
        message: "Server error during profile update",
      });
    }
  }
);

// @route   POST /api/user/change-password
// @desc    Change user password
// @access  Private
router.post(
  "/change-password",
  authenticateToken,
  validate(schemas.changePassword),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const user = await User.findById(req.user._id);

      // Verify current password
      const isCurrentPasswordValid = await user.comparePassword(
        currentPassword
      );

      if (!isCurrentPasswordValid) {
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect",
        });
      }

      // Update password
      user.password = newPassword;
      await user.save();

      res.json({
        success: true,
        message: "Password changed successfully",
      });
    } catch (error) {
      console.error("Password change error:", error);
      res.status(500).json({
        success: false,
        message: "Server error during password change",
      });
    }
  }
);

// @route   DELETE /api/user/account
// @desc    Delete user account
// @access  Private
router.delete("/account", authenticateToken, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user._id);

    res.json({
      success: true,
      message: "Account deleted successfully",
    });
  } catch (error) {
    console.error("Account deletion error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during account deletion",
    });
  }
});

// @route   POST /api/user/deactivate
// @desc    Deactivate user account
// @access  Private
router.post("/deactivate", authenticateToken, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { isActive: false });

    res.json({
      success: true,
      message: "Account deactivated successfully",
    });
  } catch (error) {
    console.error("Account deactivation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during account deactivation",
    });
  }
});

// @route   POST /api/user/reactivate
// @desc    Reactivate user account
// @access  Private
router.post("/reactivate", authenticateToken, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { isActive: true });

    res.json({
      success: true,
      message: "Account reactivated successfully",
    });
  } catch (error) {
    console.error("Account reactivation error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during account reactivation",
    });
  }
});

module.exports = router;
