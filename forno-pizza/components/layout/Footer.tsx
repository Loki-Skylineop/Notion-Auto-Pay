import Link from "next/link";
import { Pizza, Instagram, Facebook, Twitter, Youtube, MapPin, Phone, Clock, Mail } from "lucide-react";
import { BRAND } from "@/lib/utils/constants";

const socials = [
  { label: "Instagram", icon: Instagram },
  { label: "Facebook", icon: Facebook },
  { label: "Twitter", icon: Twitter },
  { label: "YouTube", icon: Youtube },
];

export function Footer() {
  return (
    <footer className="mt-8 border-t border-white/5 bg-charcoal-950">
      <div className="container-page grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-4">
        {/* Brand */}
        <div className="lg:col-span-1">
          <div className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-flame-gradient">
              <Pizza className="h-6 w-6 text-white" />
            </span>
            <span className="font-display text-2xl font-bold text-crust-50">{BRAND.name}</span>
          </div>
          <p className="mt-4 max-w-xs text-sm text-charcoal-300">
            Wood-fired Neapolitan pizza, handmade daily and delivered hot to your door.
          </p>
          <div className="mt-5 flex gap-2">
            {socials.map(({ label, icon: Icon }) => (
              <a
                key={label}
                href="#"
                aria-label={label}
                className="grid h-9 w-9 place-items-center rounded-full bg-white/5 text-crust-100 transition-colors hover:bg-flame-500/20 hover:text-flame-300"
              >
                <Icon className="h-[18px] w-[18px]" />
              </a>
            ))}
          </div>
        </div>

        {/* Menu links */}
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-charcoal-400">Menu</h3>
          <ul className="mt-4 space-y-2.5 text-sm">
            {["Pizza", "Drinks", "Desserts", "Favorites"].map((item) => (
              <li key={item}>
                <Link
                  href={item === "Favorites" ? "/favorites" : "/#menu"}
                  className="text-charcoal-200 transition-colors hover:text-flame-300"
                >
                  {item}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {/* Company */}
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-charcoal-400">Company</h3>
          <ul className="mt-4 space-y-2.5 text-sm">
            {["About us", "Careers", "Franchise", "Contact"].map((item) => (
              <li key={item}>
                <a href="#" className="text-charcoal-200 transition-colors hover:text-flame-300">
                  {item}
                </a>
              </li>
            ))}
          </ul>
        </div>

        {/* Contact */}
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wider text-charcoal-400">Visit us</h3>
          <ul className="mt-4 space-y-3 text-sm text-charcoal-200">
            <li className="flex items-start gap-2.5">
              <MapPin className="mt-0.5 h-4 w-4 flex-shrink-0 text-flame-400" />
              {BRAND.address}
            </li>
            <li className="flex items-center gap-2.5">
              <Phone className="h-4 w-4 flex-shrink-0 text-flame-400" />
              {BRAND.phone}
            </li>
            <li className="flex items-center gap-2.5">
              <Mail className="h-4 w-4 flex-shrink-0 text-flame-400" />
              {BRAND.email}
            </li>
            <li className="flex items-center gap-2.5">
              <Clock className="h-4 w-4 flex-shrink-0 text-flame-400" />
              {BRAND.hours}
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/5">
        <div className="container-page flex flex-col items-center justify-between gap-2 py-5 text-xs text-charcoal-400 sm:flex-row">
          <p>© {new Date().getFullYear()} {BRAND.name}. Crafted with 🍕 and a lot of mozzarella.</p>
          <p className="flex gap-4">
            <a href="#" className="transition-colors hover:text-crust-100">Privacy</a>
            <a href="#" className="transition-colors hover:text-crust-100">Terms</a>
          </p>
        </div>
      </div>
    </footer>
  );
}
