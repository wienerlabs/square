import type { Metadata } from "next";
import { NetworkView } from "@/components/views/NetworkView";

export const metadata: Metadata = { title: "Network" };

export default function NetworkPage() {
  return <NetworkView />;
}
