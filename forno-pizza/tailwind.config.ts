import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Warm, appetizing Italian-inspired palette
        crust: {
          50: "#faf6f0",
          100: "#f3e9db",
          200: "#e7d1b6",
          300: "#d8b389",
          400: "#c8905c",
        },
        ember: {
          // Signature tomato red
          50: "#fef2f0",
          100: "#fee0da",
          200: "#fcc4b9",
          300: "#f99b87",
          400: "#f26a4d",
          500: "#e23b2e",
          600: "#cf2a20",
          700: "#ac1f1a",
          800: "#8e1e1b",
          900: "#761e1c",
        },
        flame: {
          // Warm orange
          50: "#fff7ed",
          100: "#ffedd4",
          200: "#fed7aa",
          300: "#fdba74",
          400: "#fb9a3c",
          500: "#f4813f",
          600: "#e2620f",
          700: "#bb4710",
          800: "#953914",
          900: "#793014",
        },
        gold: {
          // Warm cheese yellow
          50: "#fffbeb",
          100: "#fff3c4",
          200: "#ffe488",
          300: "#ffd24d",
          400: "#ffc244",
          500: "#f5a623",
          600: "#d97e0a",
          700: "#b45a09",
          800: "#92460f",
          900: "#783a10",
        },
        charcoal: {
          // Deep dark backgrounds
          50: "#f6f5f4",
          100: "#e7e4e1",
          200: "#cec9c3",
          300: "#aca49b",
          400: "#867d72",
          500: "#6b6259",
          600: "#554e47",
          700: "#45403a",
          800: "#2a2621",
          850: "#211d19",
          900: "#1a1611",
          950: "#120f0b",
        },
        basil: {
          // Vegetarian / fresh accent
          400: "#5fa845",
          500: "#4d8f38",
          600: "#3d722d",
        },
      },
      fontFamily: {
        display: ["var(--font-fraunces)", "Georgia", "serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 2px 8px -2px rgba(18, 15, 11, 0.12), 0 8px 24px -8px rgba(18, 15, 11, 0.16)",
        "card-hover":
          "0 8px 20px -6px rgba(226, 59, 46, 0.28), 0 20px 40px -12px rgba(18, 15, 11, 0.35)",
        glow: "0 0 0 1px rgba(244, 129, 63, 0.4), 0 8px 30px -6px rgba(244, 129, 63, 0.45)",
        drawer: "-24px 0 60px -20px rgba(0, 0, 0, 0.55)",
      },
      borderRadius: {
        "4xl": "2rem",
      },
      backgroundImage: {
        "flame-gradient": "linear-gradient(135deg, #e23b2e 0%, #f4813f 55%, #ffc244 100%)",
        "warm-radial":
          "radial-gradient(1200px 600px at 70% -10%, rgba(244,129,63,0.20), transparent 60%), radial-gradient(900px 500px at 10% 10%, rgba(226,59,46,0.16), transparent 55%)",
      },
      keyframes: {
        float: {
          "0%, 100%": { transform: "translateY(0) rotate(0deg)" },
          "50%": { transform: "translateY(-18px) rotate(6deg)" },
        },
        "spin-slow": {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "badge-pop": {
          "0%": { transform: "scale(1)" },
          "40%": { transform: "scale(1.35)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        float: "float 6s ease-in-out infinite",
        "spin-slow": "spin-slow 26s linear infinite",
        shimmer: "shimmer 1.6s infinite",
        "badge-pop": "badge-pop 0.4s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
