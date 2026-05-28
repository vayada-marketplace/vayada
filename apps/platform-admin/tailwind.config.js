/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#15130f",
        bone: "#f7f4ed",
        reed: "#72846b",
        brass: "#b08d4a",
        ember: "#c46b4f",
        lagoon: "#246f78",
      },
      boxShadow: {
        panel: "0 18px 70px rgba(35, 31, 24, 0.10)",
      },
    },
  },
  plugins: [],
};
