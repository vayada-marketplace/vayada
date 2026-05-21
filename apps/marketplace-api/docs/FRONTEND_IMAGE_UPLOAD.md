# Frontend Image Upload Guide

## Hotel Profile Picture Upload

### Option 1: Upload Separately (Recommended)

**Step 1: Upload the image**
```javascript
POST /upload/image/hotel-profile
Content-Type: multipart/form-data
Authorization: Bearer {token}∫

Body: FormData with 'file' field
```

**Response:**
```json
{
  "url": "https://bucket.s3.region.amazonaws.com/hotels/user-id/image.jpg",
  "thumbnail_url": "https://bucket.s3.region.amazonaws.com/hotels/user-id/image_thumb.jpg",
  "key": "hotels/user-id/image.jpg",
  "width": 1920,
  "height": 1080,
  "size_bytes": 245678,
  "format": "JPEG"
}
```

**Step 2: Update profile with the URL**
```javascript
PUT /hotels/me
Content-Type: application/json
Authorization: Bearer {token}

Body: {
  "name": "Hotel Name",
  "location": "Location",
  "about": "Description",
  "website": "https://example.com",
  "picture": "https://bucket.s3.region.amazonaws.com/hotels/user-id/image.jpg"
}
```

### Option 2: Upload Directly in Profile Update

```javascript
PUT /hotels/me
Content-Type: multipart/form-data
Authorization: Bearer {token}

Body: FormData with:
  - name: "Hotel Name"
  - location: "Location"
  - about: "Description"
  - website: "https://example.com"
  - picture: File (image file)
```

## Important Notes

1. **Profile Update Endpoint** (`PUT /hotels/me`) accepts:
   - **JSON body** (`application/json`) for text fields only
   - **Form data** (`multipart/form-data`) for text fields + file uploads

2. **Image Requirements:**
   - Formats: JPEG, PNG, WEBP
   - Images are automatically resized if configured
   - Thumbnails are generated automatically

3. **Profile Completion:**
   - Profile is marked complete when: `location`, `about`, and `website` are all filled
   - Location must not be "Not specified"
   - At least one listing must exist

## Example Implementation

```javascript
// Upload image first
const uploadImage = async (file, token) => {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch('/upload/image/hotel-profile', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });
  
  return await response.json();
};

// Update profile with image URL
const updateProfile = async (profileData, imageUrl, token) => {
  const response = await fetch('/hotels/me', {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      ...profileData,
      picture: imageUrl
    })
  });
  
  return await response.json();
};

// Usage
const imageResult = await uploadImage(imageFile, token);
await updateProfile(profileData, imageResult.url, token);
```
