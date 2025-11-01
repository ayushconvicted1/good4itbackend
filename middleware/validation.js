const Joi = require("joi");

// Validation middleware factory
const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: error.details.map((detail) => ({
          field: detail.path.join("."),
          message: detail.message,
        })),
      });
    }
    next();
  };
};

// Validation schemas
const schemas = {
  // Sign up validation
  signup: Joi.object({
    fullName: Joi.string().trim().min(2).max(50).required().messages({
      "string.empty": "Full name is required",
      "string.min": "Full name must be at least 2 characters",
      "string.max": "Full name cannot exceed 50 characters",
    }),
    email: Joi.string().email().lowercase().required().messages({
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
    }),
    phoneNumber: Joi.string()
      .pattern(/^\+?[\d\s-()]+$/)
      .optional()
      .messages({
        "string.pattern.base": "Please enter a valid phone number",
      }),
    password: Joi.string().min(6).required().messages({
      "string.empty": "Password is required",
      "string.min": "Password must be at least 6 characters",
    }),
    confirmPassword: Joi.string()
      .valid(Joi.ref("password"))
      .required()
      .messages({
        "any.only": "Passwords do not match",
      }),
  }),

  // Login validation
  login: Joi.object({
    identifier: Joi.string().required().messages({
      "string.empty": "Email or phone number is required",
    }),
    password: Joi.string().required().messages({
      "string.empty": "Password is required",
    }),
  }),

  // Google OAuth validation
  google: Joi.object({
    googleId: Joi.string().required().messages({
      "string.empty": "Google ID is required",
    }),
    email: Joi.string().email().required().messages({
      "string.empty": "Email is required",
      "string.email": "Please enter a valid email address",
    }),
    fullName: Joi.string().required().messages({
      "string.empty": "Full name is required",
    }),
    profilePicture: Joi.string().uri().optional().messages({
      "string.uri": "Please enter a valid URL for profile picture",
    }),
  }),

  // Profile update validation
  updateProfile: Joi.object({
    fullName: Joi.string().trim().min(2).max(50).optional(),
    phoneNumber: Joi.string()
      .pattern(/^\+?[\d\s-()]+$/)
      .optional()
      .messages({
        "string.pattern.base": "Please enter a valid phone number",
      }),
    profilePicture: Joi.string().uri().optional().messages({
      "string.uri": "Please enter a valid URL for profile picture",
    }),
  })
    .min(1)
    .messages({
      "object.min": "At least one field must be provided for update",
    }),

  // Change password validation
  changePassword: Joi.object({
    currentPassword: Joi.string().required().messages({
      "string.empty": "Current password is required",
    }),
    newPassword: Joi.string().min(6).required().messages({
      "string.empty": "New password is required",
      "string.min": "New password must be at least 6 characters",
    }),
    confirmNewPassword: Joi.string()
      .valid(Joi.ref("newPassword"))
      .required()
      .messages({
        "any.only": "New passwords do not match",
      }),
  }),
};

module.exports = {
  validate,
  schemas,
};
