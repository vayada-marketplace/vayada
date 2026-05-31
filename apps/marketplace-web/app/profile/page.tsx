"use client";

import { useState, useEffect } from "react";
import { AuthenticatedNavigation, ProfileWarningBanner } from "@/components/layout";
import { useSidebar } from "@/components/layout/AuthenticatedNavigation";
import { STORAGE_KEYS } from "@/lib/constants";
import { CreatorProfile } from "@/components/profile/creator";
import { HotelProfile } from "@/components/profile/hotel";
import type { UserType } from "@/components/profile/types";

export default function ProfilePage() {
  const { isCollapsed } = useSidebar();

  const [userType, setUserType] = useState<UserType>(() => {
    if (typeof window !== "undefined") {
      const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
      if (storedUserType && (storedUserType === "creator" || storedUserType === "hotel")) {
        return storedUserType;
      }
    }
    return "creator";
  });

  useEffect(() => {
    const storedUserType = localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null;
    if (storedUserType && (storedUserType === "creator" || storedUserType === "hotel")) {
      setUserType(storedUserType);
    }
  }, []);

  return (
    <main className="min-h-screen bg-gray-50">
      <AuthenticatedNavigation />
      <div className={`pt-12 transition-all duration-200 ${isCollapsed ? "md:pl-14" : "md:pl-52"}`}>
        <div className="pt-4">
          <ProfileWarningBanner />
        </div>

        <div className="mx-auto max-w-7xl px-4 py-4 md:px-6 md:py-6">
          {/* Header */}
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Account workspace
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-normal text-gray-950 md:text-3xl">
              Profile
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Manage the profile details used for matching, collaboration requests, and trust
              signals.
            </p>
          </div>

          {userType === "creator" && <CreatorProfile />}
          {userType === "hotel" && <HotelProfile />}
        </div>
      </div>
    </main>
  );
}
