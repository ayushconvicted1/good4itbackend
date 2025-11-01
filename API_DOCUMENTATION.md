# Good4It Backend API Documentation

## Base URL

```
http://localhost:5000/api
```

## Authentication

All protected routes require a JWT token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## API Endpoints

### Authentication

#### Register User

```http
POST /auth/signup
Content-Type: application/json

{
  "fullName": "John Doe",
  "email": "john@example.com",
  "phoneNumber": "+1234567890",
  "password": "password123",
  "confirmPassword": "password123"
}
```

**Response:**

```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "_id": "user_id",
      "fullName": "John Doe",
      "email": "john@example.com",
      "phoneNumber": "+1234567890",
      "isEmailVerified": false,
      "role": "user",
      "isActive": true,
      "createdAt": "2023-...",
      "updatedAt": "2023-..."
    },
    "token": "jwt_token_here"
  }
}
```

#### Login User

```http
POST /auth/login
Content-Type: application/json

{
  "identifier": "john@example.com",
  "password": "password123"
}
```

**Response:**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      /* user object */
    },
    "token": "jwt_token_here"
  }
}
```

#### Google OAuth Login

```http
GET /auth/google
```

Redirects to Google OAuth consent screen.

#### Google OAuth Callback

```http
GET /auth/google/callback
```

Handled automatically by Google OAuth flow.

#### Get Current User

```http
GET /auth/me
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "data": {
    "user": {
      /* current user object */
    }
  }
}
```

#### Refresh Token

```http
POST /auth/refresh
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Token refreshed successfully",
  "data": {
    "token": "new_jwt_token"
  }
}
```

#### Logout

```http
POST /auth/logout
Authorization: Bearer <token>
```

**Response:**

```json
{
  "success": true,
  "message": "Logout successful"
}
```

### User Management

#### Get User Profile

```http
GET /user/profile
Authorization: Bearer <token>
```

#### Update User Profile

```http
PUT /user/profile
Authorization: Bearer <token>
Content-Type: application/json

{
  "fullName": "John Smith",
  "phoneNumber": "+1987654321",
  "profilePicture": "https://example.com/avatar.jpg"
}
```

#### Change Password

```http
POST /user/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "currentPassword": "oldpassword",
  "newPassword": "newpassword123",
  "confirmNewPassword": "newpassword123"
}
```

#### Deactivate Account

```http
POST /user/deactivate
Authorization: Bearer <token>
```

#### Reactivate Account

```http
POST /user/reactivate
Authorization: Bearer <token>
```

#### Delete Account

```http
DELETE /user/account
Authorization: Bearer <token>
```

### Health Check

#### API Status

```http
GET /health
```

**Response:**

```json
{
  "status": "OK",
  "message": "Good4It Backend API is running",
  "timestamp": "2023-..."
}
```

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "message": "Error description",
  "errors": [
    {
      "field": "email",
      "message": "Please enter a valid email address"
    }
  ]
}
```

## HTTP Status Codes

- `200` - Success
- `201` - Created
- `400` - Bad Request (validation errors)
- `401` - Unauthorized (invalid/missing token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `423` - Account Locked
- `500` - Internal Server Error

## Rate Limiting

- 100 requests per 15 minutes per IP address
- Exceeded limit returns 429 status code

## Security Features

- JWT tokens expire in 7 days (configurable)
- Passwords are hashed with bcrypt (12 salt rounds)
- Account locks after 5 failed login attempts for 2 hours
- CORS protection enabled
- Helmet security headers
- Input validation with Joi schemas
