export async function uploadImages(files: File | File[]): Promise<string[]> {
  void files;
  throw new Error("Platform/Admin media publication is not available yet. See VAY-984.");
}

export async function uploadSingleImage(file: File): Promise<string> {
  const urls = await uploadImages(file);
  if (!urls[0]) throw new Error("No image URL returned");
  return urls[0];
}
