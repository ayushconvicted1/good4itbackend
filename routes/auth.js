const express = require("express");
const jwt = require("jsonwebtoken");
const passport = require("../config/passport");
const User = require("../models/User");
const { validate, schemas } = require("../middleware/validation");
const { authenticateToken } = require("../middleware/auth");
const Good4ItScoreService = require("../services/good4itScoreService");

const router = express.Router();

// Generate JWT token
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || "30d", // Longer expiry for mobile
  });
};

// @route   POST /api/auth/signup
// @desc    Register a new user
// @access  Public
router.post("/signup", validate(schemas.signup), async (req, res) => {
  try {
    const { fullName, email, phoneNumber, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { phoneNumber }],
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message:
          existingUser.email === email
            ? "User with this email already exists"
            : "User with this phone number already exists",
      });
    }

    // Create new user
    const user = new User({
      fullName,
      email,
      phoneNumber,
      password,
    });

    await user.save();

    // Update good4it score for new account creation
    try {
      await Good4ItScoreService.updateScore(
        user._id,
        "account_created",
        Good4ItScoreService.calculateScoreChange("account_created"),
        "Welcome to Good4It! Your account has been created.",
        { accountType: "regular" },
        null
      );
    } catch (scoreError) {
      console.error("Failed to update score for account creation:", scoreError);
    }

    // Generate token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during registration",
    });
  }
});

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post("/login", validate(schemas.login), async (req, res) => {
  try {
    const { identifier, password } = req.body;

    // Find user by email or phone
    const user = await User.findByEmailOrPhone(identifier);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: "Login successful",
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
});

// @route   POST /api/auth/google
// @desc    Google OAuth for mobile (returns token directly)
// @access  Public
router.post("/google", validate(schemas.google), async (req, res) => {
  try {
    const { googleId, email, fullName, profilePicture } = req.body;

    // Check if user already exists with this Google ID
    let user = await User.findOne({ googleId });

    if (user) {
      // Update last login
      user.lastLogin = new Date();
      await user.save();
    } else {
      // Check if user exists with same email
      const existingUser = await User.findOne({ email });

      if (existingUser) {
        // Link Google account to existing user
        existingUser.googleId = googleId;
        existingUser.isEmailVerified = true;
        existingUser.lastLogin = new Date();
        await existingUser.save();
        user = existingUser;
      } else {
        // Create new user
        user = new User({
          googleId,
          fullName,
          email,
          profilePicture,
          isEmailVerified: true,
          lastLogin: new Date(),
        });
        await user.save();

        // Update good4it score for new Google account creation
        try {
          await Good4ItScoreService.updateScore(
            user._id,
            "account_created",
            Good4ItScoreService.calculateScoreChange("account_created"),
            "Welcome to Good4It! Your Google account has been created.",
            { accountType: "google" },
            null
          );
        } catch (scoreError) {
          console.error(
            "Failed to update score for Google account creation:",
            scoreError
          );
        }
      }
    }

    // Generate token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: "Google login successful",
      data: {
        user: user.toJSON(),
        token,
      },
    });
  } catch (error) {
    console.error("Google login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during Google login",
    });
  }
});

// @route   POST /api/auth/refresh
// @desc    Refresh JWT token
// @access  Private
router.post("/refresh", authenticateToken, async (req, res) => {
  try {
    const token = generateToken(req.user._id);

    res.json({
      success: true,
      message: "Token refreshed successfully",
      data: {
        token,
      },
    });
  } catch (error) {
    console.error("Token refresh error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during token refresh",
    });
  }
});

// @route   POST /api/auth/logout
// @desc    Logout user (client-side token removal)
// @access  Private
router.post("/logout", authenticateToken, (req, res) => {
  res.json({
    success: true,
    message: "Logout successful",
  });
});

// @route   GET /api/auth/me
// @desc    Get current user
// @access  Private
router.get("/me", authenticateToken, (req, res) => {
  res.json({
    success: true,
    data: {
      user: req.user,
    },
  });
});

module.exports = router;
