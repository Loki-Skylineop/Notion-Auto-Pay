import { Hero } from "@/components/catalog/Hero";
import { Catalog } from "@/components/catalog/Catalog";
import { ValueProps } from "@/components/catalog/ValueProps";

export default function HomePage() {
  return (
    <>
      <Hero />
      <ValueProps />
      <Catalog />
    </>
  );
}
