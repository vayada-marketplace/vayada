import { getAuthBearerToken } from "@/services/auth/sessionStore";

const getPmsUrl = () => process.env.NEXT_PUBLIC_PMS_URL || "https://pms-api.vayada.com";

export async function uploadImages(files: File | File[]): Promise<string[]> {
  const fileList = Array.isArray(files) ? files : [files];
  const pmsUrl = getPmsUrl();
  const token = getAuthBearerToken();
  const formData = new FormData();
  fileList.forEach((file) => formData.append("files", file));

  const res = await fetch(`${pmsUrl}/upload/images`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!res.ok) throw new Error("Upload failed");

  const data = await res.json();
  return (data.images || []).map((img: { url: string }) => img.url);
}

export async function uploadSingleImage(file: File): Promise<string> {
  const urls = await uploadImages(file);
  if (!urls[0]) throw new Error("No image URL returned");
  return urls[0];
}
