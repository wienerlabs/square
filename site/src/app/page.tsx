import { FooterSection } from "@/components/site/footer";
import { HeroSection } from "@/components/site/hero";
import { MeetSection } from "@/components/site/meet";
import { ModesSection } from "@/components/site/modes";
import { Navbar } from "@/components/site/navbar";
import { StandardsSection } from "@/components/site/standards";

export default function HomePage() {
  return (
    <div className="flex flex-col bg-mist text-carbon">
      <div className="relative flex min-h-dvh flex-col">
        <Navbar />
        <HeroSection />
      </div>
      <MeetSection />
      <StandardsSection />
      <ModesSection />
      <FooterSection />
    </div>
  );
}
