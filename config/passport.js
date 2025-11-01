const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const JwtStrategy = require("passport-jwt").Strategy;
const ExtractJwt = require("passport-jwt").ExtractJwt;
const User = require("../models/User");

// JWT Strategy
passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET,
    },
    async (payload, done) => {
      try {
        const user = await User.findById(payload.userId).select("-password");
        if (user) {
          return done(null, user);
        }
        return done(null, false);
      } catch (error) {
        return done(error, false);
      }
    }
  )
);

// Google OAuth Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user already exists with this Google ID
        let existingUser = await User.findOne({ googleId: profile.id });

        if (existingUser) {
          // Update last login
          existingUser.lastLogin = new Date();
          await existingUser.save();
          return done(null, existingUser);
        }

        // Check if user exists with same email
        const userWithEmail = await User.findOne({
          email: profile.emails[0].value,
        });

        if (userWithEmail) {
          // Link Google account to existing user
          userWithEmail.googleId = profile.id;
          userWithEmail.isEmailVerified = true;
          userWithEmail.lastLogin = new Date();
          await userWithEmail.save();
          return done(null, userWithEmail);
        }

        // Create new user
        const newUser = new User({
          googleId: profile.id,
          fullName: profile.displayName,
          email: profile.emails[0].value,
          profilePicture: profile.photos[0]?.value,
          isEmailVerified: true,
          lastLogin: new Date(),
        });

        await newUser.save();
        return done(null, newUser);
      } catch (error) {
        return done(error, null);
      }
    }
  )
);

// Serialize user for session
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).select("-password");
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

module.exports = passport;
