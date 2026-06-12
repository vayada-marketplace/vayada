/**
 * Image upload service — uploads files to PMS backend via multipart form data.
 */

import { getAuthBearerToken } from "../auth/sessionStore";

const PMS_BASE_URL = process.env.NEXT_PUBLIC_PMS_API_URL || "https://api.pms.localhost";

export interface UploadedImage {
  url: string;
  thumbnail_url?: string;
  key: string;
  width: number;
  height: number;
  size_bytes: number;
  format: string;
}

export interface MultipleUploadResponse {
  images: UploadedImage[];
  total: number;
}

export const uploadService = {
  async uploadImages(files: File[]): Promise<MultipleUploadResponse> {
    const token = getAuthBearerToken();
    if (!token) throw new Error("Not authenticated");

    const formData = new FormData();
    files.forEach((file) => formData.append("files", file));

    const response = await fetch(`${PMS_BASE_URL}/upload/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail || `Upload failed (${response.status})`);
    }

    return response.json();
  },
};
