import type { Metadata } from "next";
import { NewJobView } from "@/components/views/NewJobView";

export const metadata: Metadata = { title: "New job" };

export default function NewJobPage() {
  return <NewJobView />;
}
