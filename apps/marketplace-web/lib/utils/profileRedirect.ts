import { ROUTES } from "@/lib/constants";
import type { CreatorProfileStatus, HotelProfileStatus, UserType } from "@/lib/types";

type ProfileStatus = CreatorProfileStatus | HotelProfileStatus | null;

export type ProfileRedirectDecision = {
  redirectPath: string;
  profileComplete: boolean | null;
};

export function getPostLoginProfileRedirect(
  userType: UserType | null,
  profileStatus: ProfileStatus,
): ProfileRedirectDecision {
  if (userType !== "creator" && userType !== "hotel") {
    return { redirectPath: ROUTES.MARKETPLACE, profileComplete: null };
  }

  const profileComplete = profileStatus?.profile_complete === true;

  return {
    redirectPath: profileComplete ? ROUTES.MARKETPLACE : ROUTES.PROFILE_COMPLETE,
    profileComplete,
  };
}
