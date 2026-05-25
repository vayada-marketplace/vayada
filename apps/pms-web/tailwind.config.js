/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#EFF2FF",
          100: "#DFE5FF",
          200: "#BFCBFF",
          300: "#9FB1FF",
          400: "#5F7FFF",
          500: "#2F52F5",
          600: "#1E3EDB",
          700: "#162FB8",
          800: "#0F2095",
          900: "#081172",
        },
        // Warm editorial palette used by the PMS calendar modals.
        // Paper colors are slightly off-white so ink-black headlines and
        // hairline rules read as printed type rather than UI chrome.
        bone: "#F6F1E7",
        ivory: "#FBF8F1",
        ink: "#1A1714",
        ash: "#6E665A",
        hairline: "#E5DDCC",
        clay: "#B8462C",
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
