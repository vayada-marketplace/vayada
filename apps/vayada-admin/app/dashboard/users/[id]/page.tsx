"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { Modal } from "@/components/ui/Modal";
import {
  UserIcon,
  ArrowLeftIcon,
  TrashIcon,
  PencilIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { usersService } from "@/services/api";
import { ApiErrorResponse } from "@/services/api/client";
import type { UserDetailResponse } from "@/lib/types";

type AccountStatus = UserDetailResponse["status"];

function UserDetailContent() {
  const router = useRouter();
  const params = useParams();
  const userId = params.id as string;
  const detailRequest = useRef(0);

  const [userDetail, setUserDetail] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editFormData, setEditFormData] = useState({
    name: "",
    email: "",
    status: "pending" as AccountStatus,
    emailVerified: false,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");

  useEffect(() => {
    loadUserDetail();
  }, [userId]);

  // Initialize edit form when entering edit mode
  useEffect(() => {
    if (isEditing && userDetail) {
      setEditFormData({
        name: userDetail.name || "",
        email: userDetail.email || "",
        status: userDetail.status || "pending",
        emailVerified: userDetail.emailVerified || false,
      });
    }
  }, [isEditing, userDetail]);

  const loadUserDetail = async () => {
    const sequence = ++detailRequest.current;
    try {
      setLoading(true);
      setError("");
      const data = await usersService.getUserById(userId);
      if (sequence !== detailRequest.current) return;
      setUserDetail(data);
    } catch (err) {
      if (sequence !== detailRequest.current) return;
      if (err instanceof ApiErrorResponse) {
        if (err.status === 404) {
          setError("User not found");
        } else if (err.status === 403) {
          setError("Access denied. Admin privileges required.");
        } else {
          setError((err.data.detail as string) || "Failed to load user details");
        }
      } else {
        setError("Failed to load user details");
      }
    } finally {
      if (sequence === detailRequest.current) setLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!userDetail) return;

    try {
      setDeleting(true);
      setDeleteError("");

      await usersService.deleteUser(userDetail.id);

      // Redirect to dashboard after successful deletion
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400 && err.message.toLowerCase().includes("own account")) {
          setDeleteError("Cannot delete your own account.");
        } else if (err.status === 404) {
          setDeleteError("User not found.");
        } else if (err.status === 403) {
          setDeleteError("Access denied. Admin privileges required.");
        } else {
          const detail = err.data.detail;
          const errorMessage =
            typeof detail === "string"
              ? detail
              : Array.isArray(detail)
                ? detail.map((item) => item.msg).join(", ")
                : err.message || "Failed to delete user.";
          setDeleteError(errorMessage);
        }
      } else {
        setDeleteError("Failed to delete user. Please try again.");
      }
    } finally {
      setDeleting(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!userDetail) return;

    try {
      setSaving(true);
      setSaveError("");
      setSaveSuccess("");

      // Update account fields (status, emailVerified, email, name)
      const accountUpdateData: {
        status?: AccountStatus;
        emailVerified?: boolean;
        email?: string;
        name?: string;
      } = {};
      if (editFormData.status !== userDetail.status) {
        accountUpdateData.status = editFormData.status;
      }
      if (editFormData.emailVerified !== userDetail.emailVerified) {
        accountUpdateData.emailVerified = editFormData.emailVerified;
      }
      if (editFormData.email !== userDetail.email) {
        accountUpdateData.email = editFormData.email;
      }
      if (editFormData.name !== userDetail.name) {
        accountUpdateData.name = editFormData.name;
      }

      if (Object.keys(accountUpdateData).length > 0) {
        await usersService.updateUser(userDetail.id, accountUpdateData);
      }

      await loadUserDetail();
      setIsEditing(false);
      setSaveSuccess("Account updated successfully!");
      setTimeout(() => setSaveSuccess(""), 5000);
    } catch (err) {
      if (err instanceof ApiErrorResponse) {
        if (err.status === 400) {
          setSaveError((err.data.detail as string) || "Validation error");
        } else if (err.status === 404) {
          setSaveError("User not found");
        } else if (err.status === 403) {
          setSaveError("Access denied. Admin privileges required.");
        } else {
          setSaveError((err.data.detail as string) || "Failed to update account");
        }
      } else {
        setSaveError(
          err instanceof Error ? err.message : "Failed to update account. Please try again.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setSaveError("");
    setSaveSuccess("");
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case "verified":
        return "bg-green-100 text-green-800";
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "rejected":
        return "bg-red-100 text-red-800";
      case "suspended":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getTypeBadgeColor = (type: string) => {
    switch (type) {
      case "admin":
        return "bg-purple-100 text-purple-800";
      case "hotel":
        return "bg-blue-100 text-blue-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600">Loading user details...</p>
        </div>
      </div>
    );
  }

  if (error || !userDetail) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || "User not found"}</p>
          <Button variant="outline" onClick={() => router.push("/dashboard")}>
            Back to Users
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center justify-between w-full">
              <div className="flex items-center space-x-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (typeof window !== "undefined" && window.history.length > 1) {
                      router.back();
                    } else {
                      router.push("/dashboard");
                    }
                  }}
                >
                  <ArrowLeftIcon className="w-4 h-4 mr-2" />
                  Back to Users
                </Button>
                <div>
                  <h1 className="text-2xl font-bold text-gray-900">User Details</h1>
                  <p className="text-sm text-gray-600">View and manage user information</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (isEditing ? handleCancelEdit() : setIsEditing(true))}
                  className={isEditing ? "bg-gray-100" : ""}
                >
                  {isEditing ? (
                    <>
                      <XMarkIcon className="w-4 h-4 mr-2" />
                      Cancel Edit
                    </>
                  ) : (
                    <>
                      <PencilIcon className="w-4 h-4 mr-2" />
                      Edit
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-red-600 border-red-300 hover:bg-red-50"
                >
                  <TrashIcon className="w-4 h-4 mr-2" />
                  Delete User
                </Button>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-white shadow rounded-lg overflow-hidden">
          {/* User Header Section */}
          <div className="px-6 py-6 border-b border-gray-200">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0">
                {userDetail.avatar ? (
                  <img
                    className="h-20 w-20 rounded-full object-cover"
                    src={userDetail.avatar}
                    alt={userDetail.name}
                  />
                ) : (
                  <div className="h-20 w-20 rounded-full bg-gray-200 flex items-center justify-center">
                    <UserIcon className="h-10 w-10 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="flex-1">
                <h2 className="text-2xl font-bold text-gray-900">{userDetail.name}</h2>
                <p className="text-sm text-gray-600 mt-1">{userDetail.email}</p>
                <div className="mt-3 flex gap-2">
                  <span
                    className={`px-3 py-1 text-sm font-semibold rounded-full ${getTypeBadgeColor(userDetail.type)}`}
                  >
                    {userDetail.type}
                  </span>
                  <span
                    className={`px-3 py-1 text-sm font-semibold rounded-full ${getStatusBadgeColor(userDetail.status)}`}
                  >
                    {userDetail.status}
                  </span>
                  {userDetail.emailVerified && (
                    <span className="px-3 py-1 text-sm font-semibold rounded-full bg-green-100 text-green-800">
                      Email Verified
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="px-6 py-6">
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Information</h3>
                <p className="text-sm text-gray-600 mb-4">
                  User account and authentication details
                </p>
                {(saveError || saveSuccess) && (
                  <div
                    role={saveError ? "alert" : "status"}
                    className={`mb-4 p-3 rounded-lg ${saveError ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"}`}
                  >
                    <p className={`text-sm ${saveError ? "text-red-800" : "text-green-800"}`}>
                      {saveError || saveSuccess}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Name</label>
                    {isEditing ? (
                      <Input
                        type="text"
                        value={editFormData.name}
                        onChange={(e) =>
                          setEditFormData((prev) => ({ ...prev, name: e.target.value }))
                        }
                        placeholder="Full name"
                        className="mt-1"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-900">{userDetail.name}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Account Email</label>
                    {isEditing ? (
                      <Input
                        type="email"
                        value={editFormData.email}
                        onChange={(e) =>
                          setEditFormData((prev) => ({ ...prev, email: e.target.value }))
                        }
                        placeholder="user@example.com"
                        className="mt-1"
                      />
                    ) : (
                      <p className="mt-1 text-sm text-gray-900">{userDetail.email}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">User Type</label>
                    <p className="mt-1">
                      <span
                        className={`px-2 py-1 text-xs font-semibold rounded-full ${getTypeBadgeColor(userDetail.type)}`}
                      >
                        {userDetail.type}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Account Status
                    </label>
                    {isEditing ? (
                      <select
                        value={editFormData.status}
                        onChange={(e) =>
                          setEditFormData((prev) => ({
                            ...prev,
                            status: e.target.value as AccountStatus,
                          }))
                        }
                        className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                      >
                        <option value="pending">Pending</option>
                        <option value="verified">Verified</option>
                        <option value="rejected">Rejected</option>
                        <option value="suspended">Suspended</option>
                      </select>
                    ) : (
                      <p className="mt-1">
                        <span
                          className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(userDetail.status)}`}
                        >
                          {userDetail.status}
                        </span>
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Email Verified
                    </label>
                    {isEditing ? (
                      <div className="mt-1 flex items-center">
                        <input
                          type="checkbox"
                          checked={editFormData.emailVerified}
                          onChange={(e) =>
                            setEditFormData((prev) => ({
                              ...prev,
                              emailVerified: e.target.checked,
                            }))
                          }
                          className="h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 rounded"
                        />
                        <label className="ml-2 block text-sm text-gray-700">
                          {editFormData.emailVerified ? "Verified" : "Not Verified"}
                        </label>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm text-gray-900">
                        {userDetail.emailVerified ? (
                          <span className="text-green-600 font-medium">Yes</span>
                        ) : (
                          <span className="text-gray-400">No</span>
                        )}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Account Created
                    </label>
                    <p className="mt-1 text-sm text-gray-900">
                      {userDetail.createdAt ? new Date(userDetail.createdAt).toLocaleString() : "-"}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Last Updated</label>
                    <p className="mt-1 text-sm text-gray-900">
                      {userDetail.updatedAt ? new Date(userDetail.updatedAt).toLocaleString() : "-"}
                    </p>
                  </div>
                </div>
                {isEditing && (
                  <div className="flex justify-end gap-3 pt-6 mt-6 border-t">
                    <Button variant="outline" onClick={handleCancelEdit} disabled={saving}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={handleSaveEdit} disabled={saving}>
                      {saving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Delete Confirmation Modal */}
        {showDeleteConfirm && userDetail && (
          <Modal
            isOpen={showDeleteConfirm}
            onClose={() => {
              setShowDeleteConfirm(false);
              setDeleteError("");
            }}
            title="Delete User"
            size="md"
          >
            <div className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm font-medium text-red-800">
                  ⚠️ Warning: This action cannot be undone!
                </p>
              </div>

              <div>
                <p className="text-sm text-gray-700 mb-2">
                  Are you sure you want to delete this user? This will permanently delete:
                </p>
                <ul className="list-disc list-inside text-sm text-gray-600 space-y-1 ml-4">
                  <li>
                    User account: <strong>{userDetail.name}</strong> ({userDetail.email})
                  </li>
                  <li>All associated S3 images (profile pictures, media, thumbnails)</li>
                  <li>All related records</li>
                </ul>
              </div>

              {deleteError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-sm text-red-800">{deleteError}</p>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteError("");
                  }}
                  disabled={deleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleDeleteUser}
                  disabled={deleting}
                  className="bg-red-600 hover:bg-red-700"
                >
                  {deleting ? "Deleting..." : "Delete User"}
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

export default function UserDetailPage() {
  return (
    <Suspense fallback={<div className="p-6" />}>
      <UserDetailContent />
    </Suspense>
  );
}
