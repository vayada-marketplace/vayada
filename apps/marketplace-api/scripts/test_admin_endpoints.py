#!/usr/bin/env python3
"""
Test script for admin endpoints
"""
import requests
import json
import sys
from typing import Optional
import urllib3

# Disable SSL warnings for testing (only for self-signed certs)
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Default API URL - update this if your API is deployed elsewhere
API_URL = "http://localhost:8000"  # Change to your deployed API URL if needed

ADMIN_EMAIL = "admin@vayada.com"
ADMIN_PASSWORD = "Vayada123"


def print_section(title: str):
    """Print a section header"""
    print("\n" + "=" * 60)
    print(f"  {title}")
    print("=" * 60)


def print_response(response: requests.Response, show_body: bool = True):
    """Print response details"""
    print(f"\nStatus: {response.status_code}")
    if show_body:
        try:
            body = response.json()
            print(f"Response: {json.dumps(body, indent=2)}")
        except:
            print(f"Response: {response.text}")


def test_login() -> Optional[str]:
    """Test admin login and return token"""
    print_section("1. Testing Admin Login")
    
    url = f"{API_URL}/auth/login"
    payload = {
        "email": ADMIN_EMAIL,
        "password": ADMIN_PASSWORD
    }
    
    print(f"POST {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.post(url, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            token = data.get("access_token")
            print(f"\n✅ Login successful!")
            print(f"Token: {token[:50]}...")
            return token
        else:
            print(f"\n❌ Login failed!")
            return None
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return None


def test_list_users(token: str):
    """Test listing users"""
    print_section("2. Testing List Users (GET /admin/users)")
    
    url = f"{API_URL}/admin/users"
    headers = {"Authorization": f"Bearer {token}"}
    params = {"page": 1, "page_size": 10}
    
    print(f"GET {url}")
    print(f"Params: {params}")
    
    try:
        response = requests.get(url, headers=headers, params=params, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n✅ Success! Found {data.get('total', 0)} users")
            print(f"   Page: {data.get('page')}/{data.get('total_pages')}")
            print(f"   Users in this page: {len(data.get('users', []))}")
            
            # Return first user ID for next test
            users = data.get('users', [])
            if users:
                return users[0].get('id')
        else:
            print(f"\n❌ Failed!")
            return None
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return None


def test_get_user_details(token: str, user_id: str):
    """Test getting user details"""
    print_section(f"3. Testing Get User Details (GET /admin/users/{user_id})")
    
    url = f"{API_URL}/admin/users/{user_id}"
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"GET {url}")
    
    try:
        response = requests.get(url, headers=headers)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   User: {data.get('name')} ({data.get('email')})")
            print(f"   Type: {data.get('type')}")
            print(f"   Status: {data.get('status')}")
            return True
        else:
            print(f"\n❌ Failed!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_update_user_status(token: str, user_id: str):
    """Test updating user status"""
    print_section(f"4. Testing Update User Status (PATCH /admin/users/{user_id}/status)")
    
    url = f"{API_URL}/admin/users/{user_id}/status"
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "status": "verified",
        "reason": "Test approval via admin API"
    }
    
    print(f"PATCH {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.patch(url, headers=headers, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   Status changed: {data.get('old_status')} → {data.get('new_status')}")
            return True
        else:
            print(f"\n❌ Failed!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_create_user(token: str):
    """Test creating a new user"""
    print_section("5. Testing Create User (POST /admin/users)")
    
    url = f"{API_URL}/admin/users"
    headers = {"Authorization": f"Bearer {token}"}
    
    # Create a test user with unique email
    import time
    timestamp = int(time.time())
    payload = {
        "name": f"Test User {timestamp}",
        "email": f"testuser{timestamp}@example.com",
        "password": "TestPassword123!",
        "type": "creator",
        "status": "pending",
        "email_verified": False
    }
    
    print(f"POST {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.post(url, headers=headers, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 201:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   Created user: {data.get('user', {}).get('name')} ({data.get('user', {}).get('email')})")
            print(f"   User ID: {data.get('user', {}).get('id')}")
            print(f"   Type: {data.get('user', {}).get('type')}")
            print(f"   Status: {data.get('user', {}).get('status')}")
            
            # Check if creator profile was created
            if data.get('user', {}).get('creator_profile'):
                print(f"   ✅ Creator profile created")
            
            return data.get('user', {}).get('id')
        else:
            print(f"\n❌ Failed!")
            return None
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return None


def test_create_user_duplicate_email(token: str):
    """Test creating a user with duplicate email (should fail)"""
    print_section("5b. Testing Create User with Duplicate Email (should fail)")
    
    url = f"{API_URL}/admin/users"
    headers = {"Authorization": f"Bearer {token}"}
    
    # Use a known email (the admin email)
    payload = {
        "name": "Duplicate Test User",
        "email": ADMIN_EMAIL,  # This should already exist
        "password": "TestPassword123!",
        "type": "creator",
        "status": "pending"
    }
    
    print(f"POST {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.post(url, headers=headers, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 400:
            print(f"\n✅ Correctly rejected duplicate email!")
            return True
        else:
            print(f"\n❌ Should have rejected duplicate email but didn't!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_create_hotel_user(token: str):
    """Test creating a hotel user"""
    print_section("5c. Testing Create Hotel User (POST /admin/users)")
    
    url = f"{API_URL}/admin/users"
    headers = {"Authorization": f"Bearer {token}"}
    
    # Create a test hotel user with unique email
    import time
    timestamp = int(time.time())
    payload = {
        "name": f"Test Hotel {timestamp}",
        "email": f"testhotel{timestamp}@example.com",
        "password": "TestPassword123!",
        "type": "hotel",
        "status": "pending",
        "email_verified": False
    }
    
    print(f"POST {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.post(url, headers=headers, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 201:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   Created hotel: {data.get('user', {}).get('name')} ({data.get('user', {}).get('email')})")
            print(f"   User ID: {data.get('user', {}).get('id')}")
            
            # Check if hotel profile was created
            if data.get('user', {}).get('hotel_profile'):
                print(f"   ✅ Hotel profile created")
                print(f"   Hotel name: {data.get('user', {}).get('hotel_profile', {}).get('name')}")
                print(f"   Location: {data.get('user', {}).get('hotel_profile', {}).get('location')}")
            
            return data.get('user', {}).get('id')
        else:
            print(f"\n❌ Failed!")
            return None
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return None


def test_delete_user(token: str, user_id: str):
    """Test deleting a user"""
    print_section(f"6. Testing Delete User (DELETE /admin/users/{user_id})")
    
    url = f"{API_URL}/admin/users/{user_id}"
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"DELETE {url}")
    print(f"⚠️  WARNING: This will permanently delete the user and all related data!")
    
    try:
        response = requests.delete(url, headers=headers, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   Deleted user ID: {data.get('deleted_user_id')}")
            print(f"   Cascade deleted: {json.dumps(data.get('cascade_deleted', {}), indent=2)}")
            return True
        else:
            print(f"\n❌ Failed!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_delete_nonexistent_user(token: str):
    """Test deleting a non-existent user (should fail)"""
    print_section("6b. Testing Delete Non-existent User (should fail)")
    
    fake_user_id = "00000000-0000-0000-0000-000000000000"
    url = f"{API_URL}/admin/users/{fake_user_id}"
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"DELETE {url}")
    
    try:
        response = requests.delete(url, headers=headers, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 404:
            print(f"\n✅ Correctly rejected non-existent user!")
            return True
        else:
            print(f"\n❌ Should have returned 404 but got {response.status_code}!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_delete_own_account(token: str, admin_id: str):
    """Test deleting own admin account (should fail)"""
    print_section("6c. Testing Delete Own Admin Account (should fail)")
    
    url = f"{API_URL}/admin/users/{admin_id}"
    headers = {"Authorization": f"Bearer {token}"}
    
    print(f"DELETE {url}")
    print(f"⚠️  Attempting to delete own admin account (should be rejected)")
    
    try:
        response = requests.delete(url, headers=headers, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 400:
            print(f"\n✅ Correctly prevented self-deletion!")
            return True
        else:
            print(f"\n❌ Should have rejected self-deletion but didn't!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_update_user(token: str, user_id: str):
    """Test updating user information"""
    print_section(f"7. Testing Update User (PUT /admin/users/{user_id})")
    
    url = f"{API_URL}/admin/users/{user_id}"
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "name": "Updated Name (Test)"
    }
    
    print(f"PUT {url}")
    print(f"Payload: {json.dumps(payload, indent=2)}")
    
    try:
        response = requests.put(url, headers=headers, json=payload, verify=False, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print(f"\n✅ Success!")
            print(f"   Updated user: {data.get('user', {}).get('name')}")
            return True
        else:
            print(f"\n❌ Failed!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def test_unauthorized_access():
    """Test that non-admin users cannot access admin endpoints"""
    print_section("8. Testing Unauthorized Access (should fail)")
    
    url = f"{API_URL}/admin/users"
    headers = {"Authorization": "Bearer invalid_token"}
    
    print(f"GET {url} (with invalid token)")
    
    try:
        response = requests.get(url, headers=headers)
        print_response(response)
        
        if response.status_code in [401, 403]:
            print(f"\n✅ Correctly rejected unauthorized access!")
            return True
        else:
            print(f"\n❌ Should have rejected but didn't!")
            return False
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False


def main():
    """Run all tests"""
    print("\n" + "=" * 60)
    print("  ADMIN ENDPOINTS TEST SUITE")
    print("=" * 60)
    print(f"\nAPI URL: {API_URL}")
    print(f"Admin Email: {ADMIN_EMAIL}")
    
    # Test 1: Login
    token = test_login()
    if not token:
        print("\n❌ Cannot proceed without admin token. Exiting.")
        sys.exit(1)
    
    # Test 2: List users
    user_id = test_list_users(token)
    if not user_id:
        print("\n⚠️  No users found to test with. Some tests will be skipped.")
        user_id = "test-user-id"  # Placeholder
    
    # Test 3: Get user details (only if we have a real user_id)
    if user_id and user_id != "test-user-id":
        test_get_user_details(token, user_id)
        
        # Test 4: Update user status
        test_update_user_status(token, user_id)
    
    # Test 5: Create user (creator)
    created_user_id = test_create_user(token)
    
    # Test 5b: Test duplicate email rejection
    test_create_user_duplicate_email(token)
    
    # Test 5c: Create hotel user
    created_hotel_id = test_create_hotel_user(token)
    
    # Test 6: Delete user (use created user if available, otherwise skip)
    if created_user_id:
        test_delete_user(token, created_user_id)
    
    # Test 6b: Delete non-existent user (should fail)
    test_delete_nonexistent_user(token)
    
    # Test 6c: Try to delete own account (should fail)
    # Get admin ID from token or use a placeholder
    admin_user_id = None
    try:
        # Try to get admin user details
        admin_response = requests.get(
            f"{API_URL}/admin/users",
            headers={"Authorization": f"Bearer {token}"},
            params={"type": "admin", "page_size": 1},
            verify=False,
            timeout=10
        )
        if admin_response.status_code == 200:
            admin_users = admin_response.json().get('users', [])
            if admin_users:
                admin_user_id = admin_users[0].get('id')
    except:
        pass
    
    if admin_user_id:
        test_delete_own_account(token, admin_user_id)
    
    # Test 7: Update user (use created hotel if available, otherwise skip)
    if created_hotel_id:
        test_update_user(token, created_hotel_id)
    
    # Test 8: Unauthorized access
    test_unauthorized_access()
    
    print_section("TEST SUITE COMPLETE")
    print("\n✅ All tests completed!")


if __name__ == "__main__":
    # Allow API URL to be passed as command line argument
    if len(sys.argv) > 1:
        API_URL = sys.argv[1]
        print(f"Using API URL from command line: {API_URL}")
    
    main()

