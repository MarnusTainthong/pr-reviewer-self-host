/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17202a",
        accent: "#0b6e75",
        canvas: "#f5f7f8",
      },
    },
  },
  plugins: [],
};
