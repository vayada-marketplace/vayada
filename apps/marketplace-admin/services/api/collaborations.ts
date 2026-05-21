import { apiClient } from './client';
import { AdminCollaborationsResponse, Collaboration } from '@/lib/types/collaboration';

export const collaborationsService = {
    /**
     * Fetch admin collaborations with pagination, filtering, and search.
     */
    getCollaborations: async (
        page: number = 1,
        pageSize: number = 20,
        filters?: { status?: string; search?: string }
    ): Promise<AdminCollaborationsResponse> => {
        const params = new URLSearchParams();
        params.append('page', page.toString());
        params.append('page_size', pageSize.toString());

        if (filters?.status && filters.status !== 'all') {
            params.append('status', filters.status);
        }
        if (filters?.search) {
            params.append('search', filters.search);
        }

        const endpoint = `/admin/collaborations?${params.toString()}`;
        return apiClient.get<AdminCollaborationsResponse>(endpoint);
    },

    /**
     * Accept or decline a pending collaboration on behalf of the hotel.
     */
    respondAsHotel: async (
        collaborationId: string,
        status: 'accepted' | 'declined',
        responseMessage?: string
    ): Promise<Collaboration> => {
        return apiClient.post<Collaboration>(
            `/admin/collaborations/${collaborationId}/respond`,
            { status, response_message: responseMessage }
        );
    },

    /**
     * Approve current terms on behalf of the hotel. Finalizes the collaboration
     * when the creator has already approved.
     */
    approveAsHotel: async (collaborationId: string): Promise<Collaboration> => {
        return apiClient.post<Collaboration>(
            `/admin/collaborations/${collaborationId}/approve`
        );
    },
};
