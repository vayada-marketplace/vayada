'use client'

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Avatar } from '@/components/ui/Avatar';
import { Table, TableColumn } from '@/components/ui/Table';
import { Collaboration, CollaborationStatus } from '@/lib/types/collaboration';
import { CollaborationDetailModal } from '@/components/collaborations/CollaborationDetailModal';
import { collaborationsService } from '@/services/api';
import { ApiErrorResponse } from '@/services/api/client';
import {
    EyeIcon,
    MagnifyingGlassIcon,
    ArrowLeftIcon,
    ArrowRightIcon
} from '@heroicons/react/24/outline';

export default function CollaborationsPage() {
    const router = useRouter();

    // Data State
    const [collaborations, setCollaborations] = useState<Collaboration[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    // Pagination State
    const [page, setPage] = useState(1);
    const [pageSize] = useState(20);
    const [total, setTotal] = useState(0);

    // Filter State
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | CollaborationStatus>('all');

    // Modal State
    const [selectedCollaboration, setSelectedCollaboration] = useState<Collaboration | null>(null);

    // Debounced Search Effect
    useEffect(() => {
        const timer = setTimeout(() => {
            setPage(1); // Reset to page 1 on search change
            fetchCollaborations();
        }, 500);
        return () => clearTimeout(timer);
    }, [searchTerm]);

    // Fetch on Page/Filter Change (skip initial render which is handled by searcheffect but that's fine or explicit)
    // Actually search effect handles the initial load too if I am careful.
    // Better pattern: 
    useEffect(() => {
        fetchCollaborations();
    }, [page, statusFilter]);
    // Note: searchTerm is excluded here because it has its own effect that calls fetchCollaborations (or triggers page reset which calls this? No, page reset calls setPage(1), if page is already 1, it wont trigger. So we need to be careful).

    // Let's refine:
    // We want to fetch when:
    // 1. Page changes
    // 2. Status changes
    // 3. Search term changes (debounced)

    // To avoid double fetching on search change (setPage(1) + fetch), let's use a single effect dependent on a "query key" or just managing dependencies carefully.

    // Simplest working approach for this scale:
    // 1. Define fetch function wrapped in useCallback or just inside component.
    // 2. Use one effect for page/status.
    // 3. Use one effect for debounce search -> updates a "debouncedSearch" state -> triggers fetch.

    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchTerm);
        }, 500);
        return () => clearTimeout(timer);
    }, [searchTerm]);

    useEffect(() => {
        // When debounced search changes, reset to page 1
        setPage(1);
    }, [debouncedSearch]);

    // Main Fetch Effect
    useEffect(() => {
        fetchCollaborations();
    }, [page, statusFilter, debouncedSearch]);


    const fetchCollaborations = async () => {
        try {
            setLoading(true);
            setError('');

            const response = await collaborationsService.getCollaborations(
                page,
                pageSize,
                {
                    status: statusFilter,
                    search: debouncedSearch
                }
            );

            setCollaborations(response.collaborations);
            setTotal(response.total);
        } catch (err) {
            console.error(err);
            if (err instanceof ApiErrorResponse) {
                if (err.status === 401) {
                    // handled by client, but good to show something
                }
                setError(err.data.detail as string || 'Failed to fetch collaborations');
            } else {
                setError('An unexpected error occurred');
            }
        } finally {
            setLoading(false);
        }
    };

    const statusVariantMap: Record<CollaborationStatus, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
        pending: 'warning',
        negotiating: 'info',
        accepted: 'success',
        declined: 'danger',
        cancelled: 'neutral',
        completed: 'success',
    };

    const totalPages = Math.ceil(total / pageSize);
    const startItem = (page - 1) * pageSize + 1;
    const endItem = Math.min(page * pageSize, total);

    const columns: TableColumn<Collaboration>[] = [
        {
            key: 'parties',
            header: 'Parties',
            render: (collab) => {
                const isCreatorInitiator = collab.initiator_type === 'creator';

                return (
                    <div className="flex flex-col space-y-2">
                        {/* FROM / INITIATOR */}
                        <div className="flex items-center space-x-2">
                            <span className={`text-[10px] font-bold uppercase w-12 ${isCreatorInitiator ? 'text-blue-600' : 'text-purple-600'}`}>
                                {isCreatorInitiator ? 'Applied' : 'Invited'}
                            </span>
                            <div className="flex items-center space-x-2 bg-gray-50 px-2 py-1 rounded-md border border-gray-100">
                                {isCreatorInitiator ? (
                                    <>
                                        <Avatar
                                            src={collab.creator_profile_picture}
                                            alt={collab.creator_name}
                                            name={collab.creator_name}
                                            className="w-4 h-4"
                                            size="sm"
                                        />
                                        <span className="text-sm font-medium text-gray-900">{collab.creator_name}</span>
                                    </>
                                ) : (
                                    <>
                                        <div className="w-4 h-4 rounded bg-purple-100 flex items-center justify-center text-[10px] font-bold text-purple-600">H</div>
                                        <span className="text-sm font-medium text-gray-900">{collab.hotel_name}</span>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* TO / RECEIVER */}
                        <div className="flex items-center space-x-2">
                            <span className="text-[10px] font-bold text-gray-400 uppercase w-12">To</span>
                            <div className="flex items-center space-x-2 px-2 py-1">
                                {!isCreatorInitiator ? (
                                    <>
                                        <Avatar
                                            src={collab.creator_profile_picture}
                                            alt={collab.creator_name}
                                            name={collab.creator_name}
                                            className="w-4 h-4 opacity-70"
                                            size="sm"
                                        />
                                        <span className="text-sm text-gray-600">{collab.creator_name}</span>
                                    </>
                                ) : (
                                    <>
                                        <div className="w-4 h-4 rounded bg-gray-100 flex items-center justify-center text-[10px] font-bold text-gray-500">H</div>
                                        <span className="text-sm text-gray-600">{collab.hotel_name}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                );
            }
        },
        {
            key: 'type',
            header: 'Type',
            render: (collab) => (
                <Badge variant="neutral" size="sm">
                    {collab.collaboration_type}
                </Badge>
            )
        },
        {
            key: 'status',
            header: 'Status',
            render: (collab) => (
                <Badge variant={statusVariantMap[collab.status]}>
                    {collab.status.toUpperCase()}
                </Badge>
            )
        },
        {
            key: 'created_at',
            header: 'Created',
            render: (collab) => (
                <span className="text-sm text-gray-500">
                    {new Date(collab.created_at).toLocaleDateString('en-US')}
                </span>
            )
        },
        {
            key: 'actions',
            header: 'Actions',
            className: 'text-right',
            render: (collab) => (
                <Button
                    variant="outline"
                    size="sm"
                    onClick={(e) => {
                        e.stopPropagation();
                        setSelectedCollaboration(collab);
                    }}
                >
                    <EyeIcon className="w-4 h-4 mr-1" />
                    View
                </Button>
            )
        }
    ];

    return (
        <div className="px-4 sm:px-6 lg:px-8 py-8">
            <div className="sm:flex sm:items-center mb-8">
                <div className="sm:flex-auto">
                    <h1 className="text-2xl font-semibold text-gray-900">Collaborations</h1>
                    <p className="mt-2 text-sm text-gray-700">
                        Monitor marketplace activity between Creators and Hotels.
                    </p>
                </div>
            </div>

            {/* Filters */}
            <div className="mb-6 bg-white p-4 rounded-lg shadow">
                <div className="flex flex-col sm:flex-row gap-4">
                    <div className="flex-1">
                        <div className="relative">
                            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                            <Input
                                type="text"
                                placeholder="Search by Creator or Hotel..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="pl-10"
                            />
                        </div>
                    </div>
                    <div className="w-full sm:w-48">
                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value as any)}
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 bg-white"
                        >
                            <option value="all">All Statuses</option>
                            <option value="pending">Pending</option>
                            <option value="negotiating">Negotiating</option>
                            <option value="accepted">Accepted</option>
                            <option value="declined">Declined</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                        </select>
                    </div>
                </div>
            </div>

            {error && (
                <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4">
                    <p className="text-sm text-red-800">{error}</p>
                </div>
            )}

            <Table
                data={collaborations}
                columns={columns}
                onRowClick={(collab) => setSelectedCollaboration(collab)}
                loading={loading}
                emptyMessage="No collaborations found matching your criteria."
            />

            {/* Pagination */}
            {!loading && total > 0 && (
                <div className="mt-6 flex items-center justify-between bg-white px-4 py-3 rounded-lg shadow sm:px-6">
                    <div className="flex flex-1 justify-between sm:hidden">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={page === 1}
                        >
                            Previous
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                            disabled={page === totalPages}
                        >
                            Next
                        </Button>
                    </div>
                    <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                        <div>
                            <p className="text-sm text-gray-700">
                                Showing <span className="font-medium">{startItem}</span> to{' '}
                                <span className="font-medium">{endItem}</span> of{' '}
                                <span className="font-medium">{total}</span> results
                            </p>
                        </div>
                        <div>
                            <nav className="isolate inline-flex -space-x-px rounded-md shadow-sm" aria-label="Pagination">
                                <button
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    disabled={page === 1}
                                    className="relative inline-flex items-center rounded-l-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <ArrowLeftIcon className="w-5 h-5" />
                                </button>
                                {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
                                    // Simple pagination logic (showing only first 10 for now or sliding window, keeping it simple as per earlier example)
                                    // But let's copy the sliding logic from dashboard page if possible.
                                    // Replicating basic logic:
                                    let pageNum: number = i + 1;
                                    if (totalPages > 10) {
                                        if (page > 5) pageNum = page - 5 + i;
                                        if (pageNum > totalPages) pageNum = totalPages - 9 + i; // adjust if near end? Simplified for now.
                                        // Let's just use the robust logic from dashboard.
                                        if (page >= totalPages - 4) {
                                            pageNum = totalPages - 9 + i;
                                        } else if (page > 5) {
                                            pageNum = page - 5 + i;
                                        }
                                    }
                                    // Clamp
                                    if (pageNum < 1) pageNum = i + 1; // Fallback

                                    return (
                                        <button
                                            key={pageNum}
                                            onClick={() => setPage(pageNum)}
                                            className={`relative inline-flex items-center px-4 py-2 text-sm font-semibold ${pageNum === page
                                                ? 'z-10 bg-primary-600 text-white focus:z-20'
                                                : 'text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0'
                                                }`}
                                        >
                                            {pageNum}
                                        </button>
                                    );
                                })}
                                <button
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    disabled={page === totalPages}
                                    className="relative inline-flex items-center rounded-r-md px-2 py-2 text-gray-400 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 focus:z-20 focus:outline-offset-0 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <ArrowRightIcon className="w-5 h-5" />
                                </button>
                            </nav>
                        </div>
                    </div>
                </div>
            )}

            <CollaborationDetailModal
                isOpen={!!selectedCollaboration}
                onClose={() => setSelectedCollaboration(null)}
                collaboration={selectedCollaboration}
            />
        </div>
    );
}
