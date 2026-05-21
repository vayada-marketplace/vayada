"use client";

const GUEST_INFO_FIELDS = [
  { name: "First Name", type: "Text", required: true },
  { name: "Last Name", type: "Text", required: true },
  { name: "Email", type: "Email", required: true },
  { name: "Phone Number", type: "Phone", required: true },
  { name: "Country", type: "Select", required: true },
  { name: "Arrival Time", type: "Time", required: false },
  { name: "Special Requests", type: "Textarea", required: false },
];

export default function DetailsTab() {
  return (
    <div className="max-w-2xl space-y-4">
      {/* Guest Information Fields */}
      <div className="bg-white rounded-lg border border-gray-200 p-5">
        <h2 className="text-[14px] font-semibold text-gray-900">Guest Information Fields</h2>
        <p className="text-[12px] text-gray-500 mt-0.5 mb-4">
          Fields collected during the booking details step
        </p>

        <div className="space-y-1">
          {GUEST_INFO_FIELDS.map((field) => (
            <div
              key={field.name}
              className="flex items-center justify-between p-3 rounded-lg border border-gray-200"
            >
              <div className="flex items-center gap-3">
                <span className="text-[13px] font-medium text-gray-900">{field.name}</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">
                  {field.type}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {field.required && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">
                    Required
                  </span>
                )}
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-50 text-green-600">
                  Enabled
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
