"use client";
import React, { useId } from "react";

// Every Team & Roles section: heading and subtitle outside, content in a white card below.
export const teamCardClass = "rounded-xl border border-gray-200 bg-white";

export default function TeamSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div>
        <h2 id={id} className="text-lg font-semibold text-gray-900">
          {title}
        </h2>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      {children}
    </section>
  );
}
