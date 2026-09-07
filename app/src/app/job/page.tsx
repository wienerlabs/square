import type { Metadata } from "next";
import { Suspense } from "react";
import { EmptyState } from "@/components/EmptyState";
import { JobView } from "@/components/views/JobView";

export const metadata: Metadata = { title: "Job" };

export default function JobPage() {
  return (
    <Suspense fallback={<EmptyState title="Loading the job" />}>
      <JobView />
    </Suspense>
  );
}
