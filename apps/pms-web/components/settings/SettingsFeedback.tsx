/** The save outcome above a Settings page's sections. */
export function SettingsFeedback({ error, success }: { error: string; success: string }) {
  return (
    <>
      {error && (
        <div
          role="alert"
          className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700"
        >
          {success}
        </div>
      )}
    </>
  );
}
