export type CollaborationStatus =
    | 'pending'       // Initial application or invitation
    | 'negotiating'   // Terms are being discussed/updated
    | 'accepted'      // Both parties agreed (Active)
    | 'declined'      // Request was rejected
    | 'cancelled'     // Withdrawn by either party
    | 'completed';    // All deliverables finished (Historical)

// The type of compensation/agreement
export type CollaborationType =
    | 'Free Stay'
    | 'Paid'
    | 'Discount';

// Individual deliverable item (e.g., 1 Instagram Post)
export interface DeliverableItem {
    id: string;
    type: string;     // e.g., "Instagram Post", "TikTok Video"
    quantity: number;
    status: 'pending' | 'completed';
}

// Grouped deliverables by platform
export interface PlatformDeliverableGroup {
    platform: 'Instagram' | 'TikTok' | 'YouTube' | 'Facebook' | 'Content Package' | 'Custom';
    deliverables: DeliverableItem[];
}

// MAIN COLLABORATION OBJECT
export interface Collaboration {
    id: string;

    // Participants
    initiator_type: 'creator' | 'hotel'; // Who started it?
    creator_id: string;
    creator_name: string;
    creator_profile_picture?: string;
    hotel_id: string;
    hotel_name: string; // The specific hotel profile
    listing_id: string;
    listing_name: string; // The specific room/listing
    listing_location: string;

    // State
    status: CollaborationStatus;

    // Terms & Compensation
    collaboration_type?: CollaborationType;
    paid_amount?: number;             // Only if type is 'Paid'
    discount_percentage?: number;     // Only if type is 'Discount'
    free_stay_min_nights?: number;    // Only if type is 'Free Stay'
    free_stay_max_nights?: number;    // Only if type is 'Free Stay'
    stay_nights?: number;             // Final agreed nights

    // Dates
    travel_date_from?: string; // ISO Date "YYYY-MM-DD"
    travel_date_to?: string;   // ISO Date "YYYY-MM-DD"
    preferred_date_from?: string;
    preferred_date_to?: string;
    preferred_months?: string[]; // e.g., ["Jan", "Feb"]

    // Content Requirements
    platform_deliverables: PlatformDeliverableGroup[];

    // Metadata
    why_great_fit?: string; // The "Cover Letter" from the creator
    created_at: string;     // ISO DateTime
    updated_at: string;     // ISO DateTime
    completed_at?: string;  // ISO DateTime (if completed)
    cancelled_at?: string;  // ISO DateTime (if cancelled)
}

// Response Interface
export interface AdminCollaborationsResponse {
    collaborations: Collaboration[]; // The main interface we defined earlier
    total: number;                   // Total count for pagination
}
