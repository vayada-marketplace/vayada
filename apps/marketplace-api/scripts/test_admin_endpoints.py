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


def test_update_user(token: str, user_id: str):
    """Test updating user information"""
    print_section(f"5. Testing Update User (PUT /admin/users/{user_id})")
    
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
    print_section("6. Testing Unauthorized Access (should fail)")
    
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
        
        # Test 5: Update user
        test_update_user(token, user_id)
    
    # Test 6: Unauthorized access
    test_unauthorized_access()
    
    print_section("TEST SUITE COMPLETE")
    print("\n✅ All tests completed!")


if __name__ == "__main__":
    # Allow API URL to be passed as command line argument
    if len(sys.argv) > 1:
        API_URL = sys.argv[1]
        print(f"Using API URL from command line: {API_URL}")
    
    main()

