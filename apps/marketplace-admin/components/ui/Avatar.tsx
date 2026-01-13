'use client'

import { useState, useEffect } from 'react'
import { UserIcon } from '@heroicons/react/24/outline'

interface AvatarProps {
    src?: string | null
    alt: string
    name?: string // Name for generating initials/fallback
    className?: string
    size?: 'sm' | 'md' | 'lg' | 'xl'
}

export function Avatar({
    src,
    alt,
    name,
    className = '',
    size = 'md'
}: AvatarProps) {
    const [error, setError] = useState(false)
    const [imgSrc, setImgSrc] = useState<string | null>(null)

    useEffect(() => {
        setError(false);

        if (!src) {
            setImgSrc(null);
            return;
        }

        // Handle relative URLs if they don't start with http/https/data
        if (src && !src.startsWith('http') && !src.startsWith('data:')) {
            // If it starts with /, assume it needs API_URL prepended
            if (src.startsWith('/')) {
                const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
                // Remove trailing slash from API URL if present and leading slash from src
                const cleanApiUrl = apiUrl.replace(/\/$/, '');
                setImgSrc(`${cleanApiUrl}${src}`);
            } else {
                // If just a filename, it might be tricky. Assume it works as is or break.
                // But often people store just 'profile.jpg'. 
                // For now, let's treat it as a full URL if it doesn't look like a relative path, 
                // OR if it looks like an S3 key?
                // Safest bet: just try to use it.
                setImgSrc(src);
            }
        } else {
            setImgSrc(src);
        }
    }, [src])

    const sizeClasses = {
        sm: 'h-6 w-6',
        md: 'h-10 w-10',
        lg: 'h-16 w-16',
        xl: 'h-24 w-24',
    }

    // Fallback to UI Avatars if generic name provided, else generic icon
    const getFallback = () => {
        if (name) {
            return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff`
        }
        return null;
    }

    if (error || !imgSrc) {
        const fallbackUrl = getFallback();

        if (fallbackUrl) {
            return (
                <img
                    src={fallbackUrl}
                    alt={alt}
                    className={`rounded-full object-cover ${sizeClasses[size]} ${className}`}
                />
            )
        }

        return (
            <div className={`rounded-full bg-gray-200 flex items-center justify-center text-gray-400 ${sizeClasses[size]} ${className}`}>
                <UserIcon className="w-1/2 h-1/2" />
            </div>
        )
    }

    return (
        <img
            src={imgSrc}
            alt={alt}
            className={`rounded-full object-cover ${sizeClasses[size]} ${className}`}
            onError={() => {
                // If the primary image fails, try the fallback
                setError(true)
            }}
        />
    )
}
