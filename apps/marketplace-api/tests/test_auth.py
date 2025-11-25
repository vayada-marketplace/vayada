"""
Tests for authentication endpoints
"""
import pytest
from fastapi import status


class TestAuth:
    """Test authentication endpoints"""
    
    def test_register_creator(self, client):
        """Test creator registration"""
        response = client.post(
            "/auth/register",
            json={
                "email": "newcreator@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "New Creator"
            }
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["email"] == "newcreator@test.com"
        assert data["type"] == "creator"
        assert data["status"] == "pending"
        assert "id" in data
    
    def test_register_hotel(self, client):
        """Test hotel registration"""
        response = client.post(
            "/auth/register",
            json={
                "email": "newhotel@test.com",
                "password": "testpassword123",
                "type": "hotel",
                "name": "New Hotel"
            }
        )
        assert response.status_code == status.HTTP_201_CREATED
        data = response.json()
        assert data["email"] == "newhotel@test.com"
        assert data["type"] == "hotel"
        assert "id" in data
    
    def test_register_duplicate_email(self, client):
        """Test registration with duplicate email"""
        # Register first time
        client.post(
            "/auth/register",
            json={
                "email": "duplicate@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "First"
            }
        )
        
        # Try to register again
        response = client.post(
            "/auth/register",
            json={
                "email": "duplicate@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "Second"
            }
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "already registered" in response.json()["detail"].lower()
    
    def test_register_invalid_password(self, client):
        """Test registration with invalid password (too short)"""
        response = client.post(
            "/auth/register",
            json={
                "email": "shortpass@test.com",
                "password": "short",
                "type": "creator",
                "name": "Test"
            }
        )
        assert response.status_code == status.HTTP_422_UNPROCESSABLE_ENTITY
    
    def test_login_success(self, client):
        """Test successful login"""
        # First register
        register_response = client.post(
            "/auth/register",
            json={
                "email": "logintest@test.com",
                "password": "testpassword123",
                "type": "creator",
                "name": "Login Test"
            }
        )
        user_id = register_response.json()["id"]
        
        # Then login
        response = client.post(
            "/auth/login",
            json={
                "email": "logintest@test.com",
                "password": "testpassword123"
            }
        )
        assert response.status_code == status.HTTP_200_OK
        data = response.json()
        assert data["email"] == "logintest@test.com"
        assert data["id"] == user_id
        assert data["type"] == "creator"
        assert "message" in data
    
    def test_login_invalid_email(self, client):
        """Test login with invalid email"""
        response = client.post(
            "/auth/login",
            json={
                "email": "nonexistent@test.com",
                "password": "testpassword123"
            }
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert "invalid" in response.json()["detail"].lower()
    
    def test_login_invalid_password(self, client):
        """Test login with invalid password"""
        # First register
        client.post(
            "/auth/register",
            json={
                "email": "wrongpass@test.com",
                "password": "correctpassword123",
                "type": "creator",
                "name": "Test"
            }
        )
        
        # Try to login with wrong password
        response = client.post(
            "/auth/login",
            json={
                "email": "wrongpass@test.com",
                "password": "wrongpassword"
            }
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED
        assert "invalid" in response.json()["detail"].lower()

