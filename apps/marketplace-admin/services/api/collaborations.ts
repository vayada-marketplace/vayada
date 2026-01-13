import { apiClient } from './client';
import { AdminCollaborationsResponse } from '@/lib/types/collaboration';

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
    }
};
