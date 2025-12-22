# Admin API Documentation

## Overview
Admin endpoints for managing users in the Vayada platform. All endpoints require admin authentication.

## Authentication
All admin endpoints require:
- Valid JWT token in `Authorization: Bearer <token>` header
- User must have `type = 'admin'` in the users table
- Admin account must not be suspended

## Endpoints

### 1. List Users
**GET** `/admin/users`

List all users with pagination and filtering.

**Query Parameters:**
- `page` (int, default: 1) - Page number (starts at 1)
- `page_size` (int, default: 20, max: 100) - Items per page
- `type` (optional) - Filter by user type: `creator`, `hotel`, or `admin`
- `status` (optional) - Filter by status: `pending`, `verified`, `rejected`, or `suspended`
- `search` (optional) - Search by name or email (case-insensitive)

**Example Request:**
```
GET /admin/users?page=1&page_size=20&type=creator&status=pending&search=john
```

**Response:**
```json
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "name": "John Doe",
      "type": "creator",
      "status": "pending",
      "email_verified": false,
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ],
  "total": 100,
  "page": 1,
  "page_size": 20,
  "total_pages": 5
}
```

---

### 2. Get User Details
**GET** `/admin/users/{user_id}`

Get detailed information about a specific user, including profile data.

**Path Parameters:**
- `user_id` (string, UUID) - User ID

**Response:**
```json
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "type": "creator",
  "status": "pending",
  "email_verified": false,
  "avatar": null,
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "creator_profile": {
    "id": "uuid",
    "location": "New York",
    "short_description": "Travel creator",
    "portfolio_link": "https://...",
    "phone": "+1234567890",
    "profile_picture": "https://...",
    "profile_complete": true,
    "profile_completed_at": "2024-01-02T00:00:00Z",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-02T00:00:00Z",
    "platforms": [
      {
        "id": "uuid",
        "name": "Instagram",
        "handle": "@johndoe",
        "followers": 50000,
        "engagement_rate": 3.5
      }
    ]
  },
  "hotel_profile": null
}
```

**For hotel users**, `hotel_profile` will contain:
```json
{
  "id": "uuid",
  "name": "Grand Hotel",
  "location": "Paris",
  "about": "Luxury hotel...",
  "website": "https://...",
  "phone": "+1234567890",
  "picture": "https://...",
  "profile_complete": true,
  "profile_completed_at": "2024-01-02T00:00:00Z",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-02T00:00:00Z",
  "listings_count": 5
}
```

---

### 3. Update User
**PUT** `/admin/users/{user_id}`

Update user information (name, email, status).

**Path Parameters:**
- `user_id` (string, UUID) - User ID

**Request Body:**
```json
{
  "name": "John Doe Updated",  // optional
  "email": "newemail@example.com",  // optional
  "status": "verified"  // optional: "pending", "verified", "rejected", "suspended"
}
```

**Response:**
```json
{
  "message": "User updated successfully",
  "user": {
    // Same structure as GET /admin/users/{user_id}
  }
}
```

**Errors:**
- `400 Bad Request` - Email already in use by another user
- `400 Bad Request` - No fields to update
- `404 Not Found` - User not found

---

### 4. Update User Status
**PATCH** `/admin/users/{user_id}/status`

Convenience endpoint specifically for status changes (approve, deny, suspend).

**Path Parameters:**
- `user_id` (string, UUID) - User ID

**Request Body:**
```json
{
  "status": "verified",  // required: "pending", "verified", "rejected", "suspended"
  "reason": "Profile approved after review"  // optional, for logging
}
```

**Response:**
```json
{
  "message": "User status updated from pending to verified",
  "user_id": "uuid",
  "old_status": "pending",
  "new_status": "verified"
}
```

---

## Error Responses

All endpoints return standard HTTP status codes:

- `200 OK` - Success
- `400 Bad Request` - Invalid request (e.g., email already in use)
- `401 Unauthorized` - Missing or invalid token
- `403 Forbidden` - User is not an admin or admin account is suspended
- `404 Not Found` - User not found
- `500 Internal Server Error` - Server error

**Error Response Format:**
```json
{
  "detail": "Error message here"
}
```

---

## User Status Values

- `pending` - User registered but not yet reviewed/approved
- `verified` - User approved and active
- `rejected` - User application rejected
- `suspended` - User account suspended (cannot login)

---

## Creating an Admin User

To create the first admin user, you can:

1. **Via SQL (recommended for first admin):**
```sql
INSERT INTO users (email, password_hash, name, type, status)
VALUES (
  'admin@vayada.com',
  '$2b$12$...',  -- bcrypt hash of password
  'Admin User',
  'admin',
  'verified'
);
```

2. **Via existing user (update type):**
```sql
UPDATE users 
SET type = 'admin', status = 'verified'
WHERE email = 'existing@email.com';
```

---

## Frontend Integration Notes

1. **Authentication:** Use the same JWT token from `/auth/login` endpoint
2. **Pagination:** Implement pagination controls using `total_pages` from list response
3. **Filtering:** Build filter UI using query parameters
4. **Status Changes:** Use `PATCH /admin/users/{user_id}/status` for quick approve/deny actions
5. **User Details:** Fetch full details when user clicks on a user from the list

---

## Example Frontend Flow

1. Admin logs in → Gets JWT token
2. Admin navigates to users list → `GET /admin/users?page=1&page_size=20`
3. Admin filters by type/status → `GET /admin/users?type=creator&status=pending`
4. Admin clicks on user → `GET /admin/users/{user_id}`
5. Admin approves user → `PATCH /admin/users/{user_id}/status` with `{"status": "verified"}`
6. Admin edits user info → `PUT /admin/users/{user_id}` with updated fields

