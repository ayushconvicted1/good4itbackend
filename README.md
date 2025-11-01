# Good4It Backend API

A comprehensive Express.js backend API for the Good4It mobile application with authentication, user management, and Google OAuth integration.

## Features

- **User Authentication**: Sign up, login, and logout functionality
- **Google OAuth**: Social login with Google
- **JWT Authentication**: Secure token-based authentication
- **User Management**: Profile management and account operations
- **Security**: Rate limiting, helmet security, input validation
- **Database**: MongoDB with Mongoose ODM
- **Password Security**: Bcrypt hashing with salt rounds
- **Account Security**: Login attempt limiting and account locking

## API Endpoints

### Authentication Routes (`/api/auth`)

- `POST /signup` - Register a new user
- `POST /login` - Login user
- `GET /google` - Google OAuth login
- `GET /google/callback` - Google OAuth callback
- `POST /refresh` - Refresh JWT token
- `POST /logout` - Logout user
- `GET /me` - Get current user info

### User Routes (`/api/user`)

- `GET /profile` - Get user profile
- `PUT /profile` - Update user profile
- `POST /change-password` - Change user password
- `DELETE /account` - Delete user account
- `POST /deactivate` - Deactivate account
- `POST /reactivate` - Reactivate account

### Health Check

- `GET /api/health` - API health status

## Setup Instructions

### Prerequisites

- Node.js (v16 or higher)
- MongoDB (local or cloud instance)
- Google OAuth credentials

### Installation

1. **Install dependencies**:

   ```bash
   cd backend
   npm install
   ```

2. **Environment Configuration**:

   ```bash
   cp env.example .env
   ```

   Update the `.env` file with your configuration:

   ```env
   NODE_ENV=development
   PORT=5000
   MONGODB_URI=mongodb://localhost:27017/good4it
   JWT_SECRET=your-super-secret-jwt-key
   JWT_EXPIRE=7d
   FRONTEND_URL=http://localhost:3000
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   GOOGLE_CALLBACK_URL=http://localhost:5000/api/auth/google/callback
   ```

3. **Start the server**:

   ```bash
   # Development mode
   npm run dev

   # Production mode
   npm start
   ```

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Enable Google+ API
4. Create OAuth 2.0 credentials
5. Add authorized redirect URIs:
   - `http://localhost:5000/api/auth/google/callback` (development)
   - Your production callback URL
6. Copy Client ID and Client Secret to `.env` file

## API Usage Examples

### User Registration

```javascript
POST /api/auth/signup
Content-Type: application/json

{
  "fullName": "John Doe",
  "email": "john@example.com",
  "phoneNumber": "+1234567890",
  "password": "password123",
  "confirmPassword": "password123"
}
```

### User Login

```javascript
POST /api/auth/login
Content-Type: application/json

{
  "identifier": "john@example.com", // or phone number
  "password": "password123"
}
```

### Authenticated Request

```javascript
GET /api/user/profile
Authorization: Bearer YOUR_JWT_TOKEN
```

## Database Schema

### User Model

```javascript
{
  fullName: String (required, max 50 chars)
  email: String (required, unique, validated)
  phoneNumber: String (optional, unique, validated)
  password: String (required, min 6 chars, hashed)
  googleId: String (optional, unique)
  appleId: String (optional, unique)
  profilePicture: String (optional)
  isEmailVerified: Boolean (default: false)
  isPhoneVerified: Boolean (default: false)
  role: String (enum: ['user', 'admin'], default: 'user')
  isActive: Boolean (default: true)
  lastLogin: Date
  loginAttempts: Number (default: 0)
  lockUntil: Date (optional)
  createdAt: Date
  updatedAt: Date
}
```

## Security Features

- **Password Hashing**: Bcrypt with 12 salt rounds
- **JWT Tokens**: Secure token-based authentication
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Input Validation**: Joi schema validation
- **Account Locking**: 5 failed attempts locks account for 2 hours
- **CORS Protection**: Configurable CORS settings
- **Helmet Security**: Security headers

## Error Handling

The API returns consistent error responses:

```javascript
{
  "success": false,
  "message": "Error description",
  "errors": [ // Optional validation errors
    {
      "field": "email",
      "message": "Please enter a valid email address"
    }
  ]
}
```

## Development

### Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm test` - Run tests

### Project Structure

```
backend/
├── config/
│   └── passport.js      # Passport configuration
├── middleware/
│   ├── auth.js          # Authentication middleware
│   └── validation.js    # Input validation middleware
├── models/
│   └── User.js          # User model
├── routes/
│   ├── auth.js          # Authentication routes
│   └── user.js          # User management routes
├── server.js            # Main server file
├── package.json         # Dependencies and scripts
└── env.example          # Environment variables template
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details
