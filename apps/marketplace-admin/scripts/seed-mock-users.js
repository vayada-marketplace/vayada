/**
 * One-time script to populate mock data:
 * - 5 Hotels with listings
 * - 5 Creators with social media platforms
 * 
 * Usage:
 *   API_URL=http://localhost:8000 ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=password node scripts/seed-mock-users.js
 */

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let authToken = null;

// Helper function to make API requests
async function apiRequest(endpoint, method = 'GET', body = null, token = null) {
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  const options = {
    method,
    headers,
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${API_URL}${endpoint}`, options);
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(`API Error ${response.status}: ${JSON.stringify(error)}`);
  }
  
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  }
  return null;
}

// Login as admin
async function login() {
  console.log('🔐 Logging in as admin...');
  try {
    const response = await apiRequest('/auth/login', 'POST', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    
    authToken = response.access_token;
    console.log('✅ Login successful');
    return authToken;
  } catch (error) {
    console.error('❌ Login failed:', error.message);
    throw error;
  }
}

// Create a hotel user
async function createHotel(index) {
  const hotels = [
    { name: 'Grand Paradise Resort', location: 'Maldives' },
    { name: 'Mountain View Lodge', location: 'Switzerland' },
    { name: 'Ocean Breeze Hotel', location: 'Bali, Indonesia' },
    { name: 'City Center Plaza', location: 'New York, USA' },
    { name: 'Desert Oasis Resort', location: 'Dubai, UAE' },
  ];
  
  const hotel = hotels[index];
  const email = `hotel${index + 1}@example.com`;
  
  console.log(`  Creating hotel: ${hotel.name}...`);
  
  const userResponse = await apiRequest('/admin/users', 'POST', {
    name: hotel.name,
    email: email,
    password: 'password123',
    type: 'hotel',
    status: 'verified',
  }, authToken);
  
  const userId = userResponse.user.id;
  
  // Update hotel profile
  await apiRequest(`/admin/users/${userId}/profile/hotel`, 'PUT', {
    name: hotel.name,
    location: hotel.location,
    about: `Welcome to ${hotel.name}, located in ${hotel.location}. Experience luxury and comfort with world-class amenities.`,
    website: `https://${hotel.name.toLowerCase().replace(/\s+/g, '')}.com`,
    phone: `+1-555-${1000 + index}`,
    picture: `https://images.unsplash.com/photo-${1560000000 + index}?w=800`,
    profile_complete: true,
  }, authToken);
  
  // Create listings for this hotel
  const listings = [
    { name: 'Deluxe Suite', description: 'Spacious suite with ocean view and premium amenities', type: 'Hotel' },
    { name: 'Executive Room', description: 'Comfortable room perfect for business travelers', type: 'Boutique Hotel' },
    { name: 'Family Villa', description: 'Large villa ideal for families with children', type: 'Villa' },
  ];
  
  // Valid accommodation types: Hotel, Boutique Hotel, Lodge, Apartment, Villa
  const accommodationTypes = ['Hotel', 'Boutique Hotel', 'Lodge', 'Apartment', 'Villa'];
  
  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    await apiRequest(`/admin/users/${userId}/listings`, 'POST', {
      name: listing.name,
      location: hotel.location,
      description: listing.description,
      accommodation_type: listing.type,
      images: [
        `https://images.unsplash.com/photo-${1570000000 + index + i}?w=800`,
        `https://images.unsplash.com/photo-${1580000000 + index + i}?w=800`,
      ],
      status: index < 3 ? 'verified' : 'pending',
    }, authToken);
  }
  
  console.log(`  ✅ Created ${hotel.name} with ${listings.length} listings`);
  return userId;
}

// Create a creator user
async function createCreator(index) {
  const creators = [
    { name: 'Sarah Johnson', location: 'Los Angeles, USA', handle: '@sarahjtravels' },
    { name: 'Marcus Chen', location: 'Tokyo, Japan', handle: '@marcusexplores' },
    { name: 'Emma Williams', location: 'London, UK', handle: '@emmawanderlust' },
    { name: 'David Rodriguez', location: 'Barcelona, Spain', handle: '@davidroam' },
    { name: 'Lisa Anderson', location: 'Sydney, Australia', handle: '@lisajourneys' },
  ];
  
  const creator = creators[index];
  const email = `creator${index + 1}@example.com`;
  
  console.log(`  Creating creator: ${creator.name}...`);
  
  const userResponse = await apiRequest('/admin/users', 'POST', {
    name: creator.name,
    email: email,
    password: 'password123',
    type: 'creator',
    status: 'verified',
  }, authToken);
  
  const userId = userResponse.user.id;
  
  // Update creator profile
  await apiRequest(`/admin/users/${userId}/profile/creator`, 'PUT', {
    location: creator.location,
    short_description: `Travel content creator sharing amazing destinations and experiences. Follow for travel tips and inspiration!`,
    portfolio_link: `https://${creator.name.toLowerCase().replace(/\s+/g, '')}.com`,
    phone: `+1-555-${2000 + index}`,
    profile_picture: `https://images.unsplash.com/photo-${1590000000 + index}?w=400`,
    profile_complete: true,
  }, authToken);
  
  // Create social media platforms
  const platforms = [
    { name: 'Instagram', handle: creator.handle, followers: (index + 1) * 50000, engagement_rate: 3.5 + index * 0.5 },
    { name: 'TikTok', handle: creator.handle.replace('@', ''), followers: (index + 1) * 30000, engagement_rate: 4.0 + index * 0.3 },
    { name: 'YouTube', handle: creator.name.replace(' ', ''), followers: (index + 1) * 20000, engagement_rate: 2.5 + index * 0.4 },
  ];
  
  for (const platform of platforms) {
    await apiRequest(`/admin/users/${userId}/platforms`, 'POST', {
      name: platform.name,
      handle: platform.handle,
      followers: platform.followers,
      engagement_rate: platform.engagement_rate,
    }, authToken);
  }
  
  console.log(`  ✅ Created ${creator.name} with ${platforms.length} platforms`);
  return userId;
}

// Main function
async function main() {
  console.log('🚀 Starting mock data population...\n');
  console.log(`API URL: ${API_URL}`);
  console.log(`Admin Email: ${ADMIN_EMAIL}\n`);
  
  try {
    // Login
    await login();
    
    // Create hotels
    console.log('\n🏨 Creating hotels...');
    const hotelIds = [];
    for (let i = 0; i < 5; i++) {
      try {
        const userId = await createHotel(i);
        hotelIds.push(userId);
      } catch (error) {
        console.error(`  ❌ Failed to create hotel ${i + 1}:`, error.message);
      }
    }
    
    // Create creators
    console.log('\n✨ Creating creators...');
    const creatorIds = [];
    for (let i = 0; i < 5; i++) {
      try {
        const userId = await createCreator(i);
        creatorIds.push(userId);
      } catch (error) {
        console.error(`  ❌ Failed to create creator ${i + 1}:`, error.message);
      }
    }
    
    console.log('\n✅ Mock data population complete!');
    console.log(`\nSummary:`);
    console.log(`  - Hotels created: ${hotelIds.length}`);
    console.log(`  - Creators created: ${creatorIds.length}`);
    console.log(`  - Total listings: ${hotelIds.length * 3}`);
    console.log(`  - Total platforms: ${creatorIds.length * 3}`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the script
main();

