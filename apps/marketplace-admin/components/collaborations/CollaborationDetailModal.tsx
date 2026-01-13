import { Badge } from '../ui/Badge';
import { Modal } from '../ui/Modal';
import { Collaboration, CollaborationStatus } from '../../lib/types/collaboration';

interface CollaborationDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    collaboration: Collaboration | null;
}

const statusVariantMap: Record<CollaborationStatus, 'success' | 'warning' | 'info' | 'danger' | 'neutral'> = {
    pending: 'warning',
    negotiating: 'info',
    accepted: 'success',
    declined: 'danger',
    cancelled: 'neutral',
    completed: 'success',
};

export function CollaborationDetailModal({
    isOpen,
    onClose,
    collaboration,
}: CollaborationDetailModalProps) {
    if (!collaboration) return null;

    const formatDate = (dateString?: string) => {
        if (!dateString) return 'N/A';
        return new Date(dateString).toLocaleDateString();
    };

    const getCompensationText = (collab: Collaboration) => {
        switch (collab.collaboration_type) {
            case 'Paid':
                return `$${collab.paid_amount || 0} Paid`;
            case 'Discount':
                return `${collab.discount_percentage || 0}% Discount`;
            case 'Free Stay':
                return `${collab.stay_nights || collab.free_stay_min_nights || 0} Nights Free Stay`;
            default:
                return 'TBD';
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Collaboration Details"
            size="lg"
        >
            <div className="space-y-6">
                {/* Header: Parties & Status */}
                <div className="flex flex-col md:flex-row justify-between items-center bg-gray-50 p-4 rounded-xl border border-gray-100">
                    {/* Creator */}
                    <div className="flex items-center space-x-3">
                        <img
                            src={collaboration.creator_profile_picture || `https://ui-avatars.com/api/?name=${collaboration.creator_name}`}
                            alt={collaboration.creator_name}
                            className="w-12 h-12 rounded-full object-cover border border-gray-200"
                        />
                        <div>
                            <p className="text-sm font-bold text-gray-900">{collaboration.creator_name}</p>
                            <p className="text-xs text-gray-500">Creator</p>
                        </div>
                    </div>

                    {/* Status */}
                    <div className="my-4 md:my-0 flex flex-col items-center">
                        <Badge variant={statusVariantMap[collaboration.status]}>
                            {collaboration.status.toUpperCase()}
                        </Badge>
                        <span className="text-xs text-gray-400 mt-1">
                            Via {collaboration.initiator_type === 'creator' ? 'Application' : 'Invitation'}
                        </span>
                    </div>

                    {/* Hotel */}
                    <div className="flex items-center space-x-3 text-right">
                        <div>
                            <p className="text-sm font-bold text-gray-900">{collaboration.hotel_name}</p>
                            <p className="text-xs text-gray-500">{collaboration.listing_name}</p>
                        </div>
                        <div className="w-12 h-12 rounded-lg bg-gray-200 flex items-center justify-center text-gray-500 font-bold border border-gray-200">
                            {collaboration.hotel_name.charAt(0)}
                        </div>
                    </div>
                </div>

                {/* Terms & Dates */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                        <h4 className="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-2">Compensation</h4>
                        <p className="text-lg font-medium text-gray-900">{getCompensationText(collaboration)}</p>
                        <p className="text-sm text-gray-500">{collaboration.collaboration_type} Agreement</p>
                    </div>
                    <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                        <h4 className="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-2">Dates</h4>
                        <div className="flex items-center space-x-2">
                            <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                                {collaboration.travel_date_from ? formatDate(collaboration.travel_date_from) : 'TBD'}
                            </span>
                            <span className="text-gray-400">→</span>
                            <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                                {collaboration.travel_date_to ? formatDate(collaboration.travel_date_to) : 'TBD'}
                            </span>
                        </div>
                        {collaboration.preferred_months && !collaboration.travel_date_from && (
                            <p className="text-sm text-gray-500 mt-2">
                                Preferred: {collaboration.preferred_months.join(', ')}
                            </p>
                        )}
                    </div>
                </div>

                {/* Deliverables */}
                <div>
                    <h4 className="text-sm font-semibold text-gray-900 mb-3 border-b pb-2">Deliverables</h4>
                    <div className="space-y-4">
                        {collaboration.platform_deliverables.map((group, i) => (
                            <div key={i}>
                                <h5 className="text-xs font-bold text-gray-600 mb-2 uppercase">{group.platform}</h5>
                                <ul className="space-y-2">
                                    {group.deliverables.map((item) => (
                                        <li key={item.id} className="flex items-center justify-between text-sm bg-gray-50 p-2 rounded">
                                            <div className="flex items-center space-x-2">
                                                <span className={`w-2 h-2 rounded-full ${item.status === 'completed' ? 'bg-green-500' : 'bg-yellow-400'}`}></span>
                                                <span>{item.quantity}x {item.type}</span>
                                            </div>
                                            <Badge size="sm" variant={item.status === 'completed' ? 'success' : 'neutral'}>
                                                {item.status}
                                            </Badge>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Application Note */}
                {collaboration.why_great_fit && (
                    <div className="bg-blue-50 p-4 rounded-lg border border-blue-100">
                        <h4 className="text-xs font-bold text-blue-800 uppercase mb-1">Application Note</h4>
                        <p className="text-sm text-blue-900 italic">"{collaboration.why_great_fit}"</p>
                    </div>
                )}

                {/* Timeline */}
                <div className="text-xs text-gray-400 pt-4 border-t flex flex-wrap gap-4">
                    <span>Created: {formatDate(collaboration.created_at)}</span>
                    {collaboration.updated_at && <span>Last Updated: {formatDate(collaboration.updated_at)}</span>}
                    {collaboration.completed_at && <span>Completed: {formatDate(collaboration.completed_at)}</span>}
                    {collaboration.cancelled_at && <span>Cancelled: {formatDate(collaboration.cancelled_at)}</span>}
                </div>

            </div>
        </Modal>
    );
}
