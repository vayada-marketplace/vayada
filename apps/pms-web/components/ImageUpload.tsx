'use client'

import { useState, useRef, useCallback } from 'react'
import { XMarkIcon, PhotoIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline'
import { uploadService, UploadedImage } from '@/services/upload'

interface ImageUploadProps {
  /** Already-uploaded image URLs (from the server) */
  images: string[]
  /** Called when images change (URLs array) */
  onChange: (urls: string[]) => void
  /** Max number of images */
  maxImages?: number
  /** Max file size in MB */
  maxSizeMB?: number
  /** Label text */
  label?: string
  /** Whether to show compact style (for wizards) */
  compact?: boolean
}

export default function ImageUpload({
  images,
  onChange,
  maxImages = 10,
  maxSizeMB = 5,
  label = 'Room Images',
  compact = false,
}: ImageUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setError('')

    const fileArray = Array.from(files)

    // Validate count
    if (images.length + fileArray.length > maxImages) {
      setError(`Maximum ${maxImages} images allowed`)
      e.target.value = ''
      return
    }

    // Validate each file
    for (const file of fileArray) {
      if (!file.type.startsWith('image/')) {
        setError('Only image files are allowed (JPG, PNG, WebP)')
        e.target.value = ''
        return
      }
      if (file.size > maxSizeMB * 1024 * 1024) {
        setError(`Each image must be under ${maxSizeMB}MB`)
        e.target.value = ''
        return
      }
    }

    setUploading(true)
    try {
      const result = await uploadService.uploadImages(fileArray)
      const newUrls = result.images.map((img: UploadedImage) => img.url)
      onChange([...images, ...newUrls])
    } catch (err: any) {
      setError(err.message || 'Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }, [images, onChange, maxImages, maxSizeMB])

  const removeImage = useCallback((index: number) => {
    const updated = images.filter((_, i) => i !== index)
    onChange(updated)
  }, [images, onChange])

  return (
    <div className="space-y-3">
      {label && (
        <label className={`block font-medium text-gray-700 ${compact ? 'text-[13px]' : 'text-sm'}`}>
          {label}
        </label>
      )}

      {/* Image grid */}
      {images.length > 0 && (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {images.map((url, i) => (
            <div key={i} className="relative group aspect-square rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
              <img
                src={url}
                alt={`Room image ${i + 1}`}
                className="w-full h-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <XMarkIcon className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload zone */}
      {images.length < maxImages && (
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          className={`
            border-2 border-dashed rounded-lg flex flex-col items-center justify-center cursor-pointer transition-colors
            ${uploading ? 'border-primary-300 bg-primary-50 cursor-wait' : 'border-gray-300 hover:border-primary-400 hover:bg-gray-50'}
            ${compact ? 'py-4 px-3' : 'py-6 px-4'}
          `}
        >
          {uploading ? (
            <>
              <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin mb-2" />
              <p className={`text-primary-600 font-medium ${compact ? 'text-[12px]' : 'text-sm'}`}>
                Uploading...
              </p>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-2">
                {images.length === 0 ? (
                  <PhotoIcon className="w-5 h-5 text-gray-400" />
                ) : (
                  <ArrowUpTrayIcon className="w-5 h-5 text-gray-400" />
                )}
              </div>
              <p className={`text-gray-700 font-medium ${compact ? 'text-[12px]' : 'text-sm'}`}>
                {images.length === 0 ? 'Upload room images' : 'Add more images'}
              </p>
              <p className={`text-gray-400 mt-0.5 ${compact ? 'text-[11px]' : 'text-xs'}`}>
                JPG, PNG, WebP up to {maxSizeMB}MB ({images.length}/{maxImages})
              </p>
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      )}

      {error && (
        <p className={`text-red-600 font-medium ${compact ? 'text-[11px]' : 'text-xs'}`}>{error}</p>
      )}
    </div>
  )
}
